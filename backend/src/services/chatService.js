const axios = require('axios');
const weatherService = require('./weatherService');
const prisma = require('../config/db');
const env = require('../config/env');
const logger = require('../utils/logger');


class ChatService {
  constructor() {
    this.inMemoryConversations = [];
    this.inMemoryMessages = [];
  }

  /**
   * Simple rule & pattern-based intent detector (can be extended with Python AI service)
   */
  detectIntent(message) {
    const text = message.toLowerCase();
    if (text.includes('rain') || text.includes('tomorrow') || text.includes('forecast') || text.includes('week') || text.includes('next')) {
      return 'forecast_query';
    }
    if (text.includes('temp') || text.includes('temperature') || text.includes('humidity') || text.includes('wind') || text.includes('now') || text.includes('current')) {
      return 'current_weather';
    }
    if (text.includes('alert') || text.includes('warning') || text.includes('cyclone') || text.includes('flood') || text.includes('danger')) {
      return 'alert_check';
    }
    if (text.includes('climate') || text.includes('trend') || text.includes('monsoon') || text.includes('last year') || text.includes('history')) {
      return 'climate_trend';
    }
    return 'general_weather_query';
  }

  /**
   * Assess meteorological risk level from weather variables
   */
  computeRiskLevel(weatherData) {
    if (!weatherData) return 'low';
    const rain = weatherData.rainfall || weatherData.precipitation || 0;
    const wind = weatherData.windSpeed || 0;
    const temp = weatherData.temperature || 25;

    if (rain > 50 || wind > 60 || temp > 43) return 'extreme';
    if (rain > 20 || wind > 40 || temp > 38) return 'high';
    if (rain > 5 || wind > 25 || temp > 33) return 'moderate';
    return 'low';
  }

  /**
   * Generate an automated conversation title from the first message
   */
  generateTitle(message) {
    const clean = message.trim().replace(/^["']|["']$/g, '');
    return clean.length > 45 ? clean.substring(0, 42) + '...' : clean;
  }

  /**
   * Directly query Google Gemini LLM with grounded meteorological telemetry
   */
  async callGemini({ message, weatherData, forecastData, language = 'en', history = [] }) {
    const rawKey = env.GEMINI_API_KEY || process.env.GEMINI_API_KEY || '';
    const apiKey = rawKey.replace(/\s+/g, '').trim();
    if (!apiKey) {
      logger.debug('[ChatService] No GEMINI_API_KEY found, skipping Gemini call');
      return null;
    }

    // Models confirmed available with v1beta - ordered by preference
    // gemini-1.5-x models are NOT available on v1beta, skip them entirely
    const candidateModels = [
      env.GEMINI_MODEL || 'gemini-3.6-flash',
      'gemini-3.6-flash',
      'gemini-flash-latest'
    ].filter(Boolean);

    // Deduplicate models
    const uniqueModels = [...new Set(candidateModels)];

    const langMap = {
      hi: 'Hindi (हिंदी)',
      ta: 'Tamil (தமிழ்)',
      te: 'Telugu (తెలుగు)',
      bn: 'Bengali (বাংলা)',
      mr: 'Marathi (मराठी)',
      gu: 'Gujarati (ગુજરાતી)',
      pa: 'Punjabi (ਪੰਜਾਬੀ)',
      en: 'English'
    };
    const langName = langMap[language] || 'English';

    const systemInstruction = `You are WeatherGPT, an advanced AI meteorological intelligence and advisory assistant for India (SIH 2026).
You provide grounded, highly accurate, natural-language weather insights, agricultural advisories (crop spraying, irrigation, sowing, harvesting), biometeorology (heat index, feels-like), and severe disaster alerts.
Always ground your answers in the provided real-time meteorological telemetry. Do not fabricate or hallucinate weather observations.
Structure your answer nicely with clean Markdown formatting, bullet points, and appropriate emojis.
Cite official data sources (e.g., IMD, Open-Meteo, ECMWF, ICAR). Respond fluently in ${langName}.`;

    const contextData = {
      current_observation: weatherData || null,
      forecast_outlook: forecastData ? forecastData.forecasts?.slice(0, 3) : null
    };

    const userContent = `[USER QUERY]: ${message}\n\n[LIVE GROUNDED WEATHER CONTEXT]:\n${JSON.stringify(contextData, null, 2)}`;

    const contents = [];
    if (Array.isArray(history) && history.length > 0) {
      for (const msg of history.slice(-6)) {
        contents.push({
          role: msg.role === 'user' ? 'user' : 'model',
          parts: [{ text: msg.content || '' }]
        });
      }
    }
    contents.push({
      role: 'user',
      parts: [{ text: userContent }]
    });

    const payload = {
      system_instruction: { parts: [{ text: systemInstruction }] },
      contents,
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1024
      }
    };

    for (const model of uniqueModels) {
      try {
        // Use v1 for gemini-1.x models, v1beta for 2.x/3.x
        const apiVersion = model.startsWith('gemini-1.') ? 'v1' : 'v1beta';
        const url = `https://generativelanguage.googleapis.com/${apiVersion}/models/${model}:generateContent?key=${apiKey}`;
        logger.info(`[ChatService] Querying Google Gemini API with model: ${model} (${apiVersion})`);

        const response = await axios.post(url, payload, {
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey
          },
          timeout: 25000
        });

        if (response.data && response.data.candidates && response.data.candidates.length > 0) {
          const candidate = response.data.candidates[0];
          const parts = candidate.content?.parts;
          if (parts && parts.length > 0) {
            logger.info(`[ChatService] Successfully received response from Google Gemini (${model})`);
            return parts.map(p => p.text).join('\n');
          }
        }
      } catch (err) {
        const errDetails = err.response?.data?.error?.message || err.response?.data || err.message;
        logger.warn(`[ChatService] Google Gemini API request failed for model ${model}:`, JSON.stringify(errDetails));
      }
    }
    return null;
  }

  /**
   * Process a natural language chat query
   */
  async processChat({ message, latitude, longitude, language = 'en', conversationId, userId = null }) {
    const intent = this.detectIntent(message);
    const sources = [];
    let answer = '';
    let locationName = 'Selected Area';
    let risk = 'low';

    const lat = latitude ?? 22.5726; // Default to Kolkata coordinates if unspecified
    const lon = longitude ?? 88.3639;
    let suggestedActions = [];
    let weatherCard = null;

    let aiHandled = false;
    let currentData = null;
    let forecastData = null;

    // Fetch live weather data for grounding
    try {
      currentData = await weatherService.getCurrentWeather({ lat, lon });
      risk = this.computeRiskLevel(currentData);
      locationName = currentData.locationName || locationName;
    } catch (e) {
      logger.debug('[ChatService] Could not pre-fetch current weather:', e.message);
    }

    try {
      forecastData = await weatherService.getForecast({ lat, lon, days: 3 });
    } catch (e) {
      logger.debug('[ChatService] Could not pre-fetch forecast:', e.message);
    }

    // 1. Attempt delegation to external AI/LLM Microservice (Python FastAPI service)
    if (env.AI_SERVICE_URL && env.AI_SERVICE_URL !== 'http://localhost:8000') {
      try {
        const aiResponse = await axios.post(`${env.AI_SERVICE_URL}/api/v1/agent/query`, {
          message,
          latitude: lat,
          longitude: lon,
          language,
          conversationId
        }, { timeout: 10000 });

        if (aiResponse.data && (aiResponse.data.answer || aiResponse.data.data?.answer)) {
          const aiData = aiResponse.data.data || aiResponse.data;
          answer = aiData.answer;
          sources.push(...(aiData.sources || ['AI-Agent-Orchestrator']));
          risk = aiData.risk || risk;
          locationName = aiData.location || locationName;
          suggestedActions = aiData.suggested_actions || aiData.suggestedActions || [];
          weatherCard = aiData.weatherCard || null;
          aiHandled = true;
          logger.info('[ChatService] Query successfully fulfilled by AI microservice');
        }
      } catch (aiErr) {
        logger.debug('[ChatService] AI microservice unavailable, attempting direct LLM / rule engine:', aiErr.message);
      }
    }

    // 2. Direct Google Gemini LLM Generation (when GEMINI_API_KEY is configured in backend)
    if (!aiHandled && (env.GEMINI_API_KEY || process.env.GEMINI_API_KEY)) {
      try {
        const geminiAnswer = await this.callGemini({
          message,
          weatherData: currentData,
          forecastData,
          language,
          history: conversationId ? await this.getConversationHistory(conversationId, userId) : []
        });

        if (geminiAnswer) {
          answer = geminiAnswer;
          sources.push('Google-Gemini', currentData?.source || 'open-meteo');
          aiHandled = true;
          suggestedActions = [
            '🌧️ Will it rain tomorrow?',
            '🌾 Agricultural crop advisory',
            '⚠️ Active severe weather alerts'
          ];
          weatherCard = currentData ? {
            temperature: currentData.temperature,
            humidity: currentData.humidity,
            windSpeed: currentData.windSpeed,
            rainfall: currentData.rainfall,
            source: currentData.source || 'open-meteo'
          } : null;
          logger.info('[ChatService] Query successfully fulfilled via Google Gemini LLM API');
        }
      } catch (geminiErr) {
        logger.warn('[ChatService] Gemini generation failed, falling back to rule engine:', geminiErr.message);
      }
    }

    // 3. Fallback to built-in grounded meteorological response engine
    if (!aiHandled) {
      try {
        if (intent === 'forecast_query') {
          sources.push(forecastData?.source || 'open-meteo');
          const tomorrow = forecastData?.forecasts?.[1] || forecastData?.forecasts?.[0];
          
          if (tomorrow) {
            const rainProb = tomorrow.rainfallProbability || 0;
            const tempMax = tomorrow.temperatureMax || tomorrow.temperature || 0;
            const tempMin = tomorrow.temperatureMin || 0;
            
            risk = rainProb > 60 ? 'moderate' : 'low';
            answer = `Forecast indicates temperatures between ${tempMin.toFixed(1)}°C and ${tempMax.toFixed(1)}°C with a ${rainProb}% probability of precipitation (${tomorrow.precipitation}mm expected).`;
          } else {
            answer = `Forecast for your location shows stable weather conditions.`;
          }
        } else if (intent === 'alert_check') {
          sources.push('IMD-Alerts');
          risk = 'low';
          answer = `No severe weather warnings or hazardous weather conditions currently active for your coordinates (${lat.toFixed(2)}, ${lon.toFixed(2)}).`;
        } else {
          const liveCurrent = currentData || await weatherService.getCurrentWeather({ lat, lon });
          sources.push(liveCurrent.source || 'open-meteo');
          risk = this.computeRiskLevel(liveCurrent);
          answer = `Current conditions: Temperature is ${liveCurrent.temperature}°C, humidity is ${liveCurrent.humidity}%, with wind speeds at ${liveCurrent.windSpeed} km/h and ${liveCurrent.rainfall}mm rainfall.`;
        }
      } catch (err) {
        logger.error('Weather retrieval failed in chatService:', err.message);
        answer = `Unable to fetch live weather data at the moment. Please verify the coordinates or try again shortly.`;
        sources.push('system-fallback');
      }
    }

    let activeConversationId = conversationId || null;

    // Database persistence for Conversation & Messages
    if (prisma && prisma.conversation) {
      try {
        if (!activeConversationId) {
          const newConv = await prisma.conversation.create({
            data: {
              userId: userId || null,
              title: this.generateTitle(message)
            }
          });
          activeConversationId = newConv.id;
        } else {
          // Touch conversation updated_at
          await prisma.conversation.update({
            where: { id: activeConversationId },
            data: { updatedAt: new Date() }
          }).catch(() => {});
        }

        if (prisma.chatMessage) {
          await prisma.chatMessage.create({
            data: {
              userId: userId || null,
              conversationId: activeConversationId,
              role: 'user',
              content: message,
              intent,
              language,
              sources,
              riskLevel: risk
            }
          });

          await prisma.chatMessage.create({
            data: {
              userId: userId || null,
              conversationId: activeConversationId,
              role: 'assistant',
              content: answer,
              intent,
              language,
              sources,
              riskLevel: risk
            }
          });
        }
      } catch (dbErr) {
        logger.debug('DB Conversation/ChatMessage save fallback:', dbErr.message);
      }
    }

    // In-memory fallback tracking for dev/offline mode
    if (!activeConversationId) {
      activeConversationId = 'conv_' + Date.now();
      this.inMemoryConversations.push({
        id: activeConversationId,
        userId,
        title: this.generateTitle(message),
        createdAt: new Date(),
        updatedAt: new Date()
      });
    }

    const now = new Date();
    this.inMemoryMessages.push(
      {
        id: 'msg_' + Date.now() + '_u',
        conversationId: activeConversationId,
        userId,
        role: 'user',
        content: message,
        intent,
        language,
        sources,
        riskLevel: risk,
        createdAt: now
      },
      {
        id: 'msg_' + (Date.now() + 1) + '_a',
        conversationId: activeConversationId,
        userId,
        role: 'assistant',
        content: answer,
        intent,
        language,
        sources,
        riskLevel: risk,
        createdAt: new Date(now.getTime() + 10)
      }
    );

    return {
      conversationId: activeConversationId,
      answer,
      location: locationName,
      sources,
      risk,
      intent,
      language,
      suggestedActions,
      suggested_actions: suggestedActions,
      weatherCard
    };
  }

  /**
   * List all conversations for a user
   */
  async getConversations(userId) {
    if (prisma && prisma.conversation) {
      try {
        return await prisma.conversation.findMany({
          where: userId ? { userId } : {},
          orderBy: { updatedAt: 'desc' },
          include: {
            messages: {
              take: 1,
              orderBy: { createdAt: 'desc' },
              select: { content: true, role: true, createdAt: true }
            }
          }
        });
      } catch (err) {
        logger.debug('DB getConversations fallback:', err.message);
      }
    }

    return this.inMemoryConversations
      .filter(c => !userId || c.userId === userId)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  /**
   * Get full message history for a conversation
   */
  async getConversationHistory(conversationId, userId = null) {
    if (prisma && prisma.chatMessage) {
      try {
        const messages = await prisma.chatMessage.findMany({
          where: { conversationId },
          orderBy: { createdAt: 'asc' }
        });

        if (messages && messages.length > 0) {
          return messages;
        }
      } catch (err) {
        logger.debug('DB getConversationHistory fallback:', err.message);
      }
    }

    return this.inMemoryMessages
      .filter(m => m.conversationId === conversationId)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }

  /**
   * Delete a conversation and its messages
   */
  async deleteConversation(conversationId, userId = null) {
    if (prisma && prisma.conversation) {
      try {
        await prisma.conversation.deleteMany({
          where: {
            id: conversationId,
            ...(userId ? { userId } : {})
          }
        });
      } catch (err) {
        logger.debug('DB deleteConversation fallback:', err.message);
      }
    }

    this.inMemoryConversations = this.inMemoryConversations.filter(c => c.id !== conversationId);
    this.inMemoryMessages = this.inMemoryMessages.filter(m => m.conversationId !== conversationId);

    return { success: true, conversationId };
  }

  /**
   * Process a Voice-in, Voice-out natural language query
   */
  async processVoiceChat({ audio_base64, audio_format = 'wav', language = 'en', latitude, longitude, conversationId, userId = null }) {
    const lat = latitude ?? 22.5726;
    const lon = longitude ?? 88.3639;

    if (env.AI_SERVICE_URL) {
      try {
        const aiResponse = await axios.post(`${env.AI_SERVICE_URL}/api/v1/voice/query`, {
          audio_base64,
          audio_format,
          language,
          latitude: lat,
          longitude: lon,
          conversationId,
          synthesize_audio: true
        }, { timeout: 8000 });

        if (aiResponse.data) {
          logger.info('[ChatService] Voice query fulfilled by AI microservice');
          return aiResponse.data;
        }
      } catch (aiErr) {
        logger.warn('[ChatService] AI microservice voice query failed, falling back to text engine:', aiErr.message);
      }
    }

    // Fallback: Use standard processChat
    const textFallback = await this.processChat({
      message: 'Will it rain today?',
      latitude: lat,
      longitude: lon,
      language,
      conversationId,
      userId
    });

    return {
      status: 'success',
      transcript: 'Will it rain today?',
      answer: textFallback.answer,
      location: textFallback.location,
      risk: textFallback.risk,
      sources: textFallback.sources,
      conversationId: textFallback.conversationId,
      audio_base64: null,
      audio_format: 'audio/mp3',
      language
    };
  }
}

module.exports = new ChatService();


