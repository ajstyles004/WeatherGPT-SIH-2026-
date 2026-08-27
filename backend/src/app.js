const express = require('express');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./config/swagger');
const routes = require('./routes');
const errorHandler = require('./middleware/errorHandler');
const { apiLimiter } = require('./middleware/rateLimiter');
const { errorResponse } = require('./utils/response');

const env = require('./config/env');

const app = express();

// Trust reverse proxy headers (required for Render, Cloudflare, Heroku to correctly identify client IPs for rate-limiting)
app.set('trust proxy', 1);

// Parse and configure CORS Origin Whitelist
const corsOriginEnv = env.CORS_ORIGIN || '';
const allowedOrigins = corsOriginEnv
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    // Allow non-browser requests (curl, Postman, mobile, server-to-server)
    if (!origin) return callback(null, true);
    // If CORS_ORIGIN is set to '*' or not configured, allow all
    if (!corsOriginEnv || allowedOrigins.includes('*')) {
      return callback(null, true);
    }
    // Allow if origin matches whitelist exactly or is a Vercel/Render deployment subdomain
    const isAllowed = allowedOrigins.includes(origin) ||
      origin.endsWith('.vercel.app') ||
      origin.endsWith('.onrender.com') ||
      origin.endsWith('.railway.app');
    if (isAllowed) {
      return callback(null, true);
    }
    return callback(new Error(`CORS Error: Origin '${origin}' is not allowed by policy.`), false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
};
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Apply rate limiter to API routes
app.use('/api', apiLimiter);

// Swagger UI Documentation
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.use('/api/v1/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Root info route
app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to WeatherGPT API Gateway',
    version: '1.0.0',
    documentation: '/api-docs',
    healthCheck: '/health'
  });
});

// Mount Routes
app.use(routes);

// 404 Catch-all
app.use((req, res) => {
  return errorResponse(res, `Route not found: ${req.method} ${req.originalUrl}`, 404);
});

// Central Error Handler
app.use(errorHandler);

module.exports = app;
