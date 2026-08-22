'use strict';

require('dotenv').config();

const express   = require('express');
const helmet    = require('helmet');
const cors      = require('cors');
const morgan    = require('morgan');
const rateLimit = require('express-rate-limit');
const logger       = require('./src/utils/logger');
const ApiError     = require('./src/utils/ApiError');
const { sequelize } = require('./src/models');
const swaggerUi    = require('swagger-ui-express');
const swaggerSpec  = require('./src/config/swagger');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Process-level safety nets ─────────────────────────────────────────────────
// Without these, a rejection escaping request scope (e.g. inside a subprocess
// 'exit' handler) or any uncaught exception crashes the whole server, ending
// every teacher/student session in progress with no trace of why.
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled promise rejection: ${reason?.message || reason}`, {
    stack: reason?.stack,
  });
});

process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.message}`, { stack: err.stack });
  process.exit(1);
});

function getPositiveIntegerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// ─── Security headers ─────────────────────────────────────────────────────────
app.use(helmet());

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
}));

// ─── HTTP request logging ─────────────────────────────────────────────────────
app.use(morgan('combined', {
  stream: { write: (msg) => logger.http(msg.trim()) },
}));

// ─── Rate limiting ────────────────────────────────────────────────────────────
const rateLimitWindowMs = getPositiveIntegerEnv('RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000);

app.use('/api/auth', rateLimit({
  windowMs: rateLimitWindowMs,
  limit: getPositiveIntegerEnv('AUTH_RATE_LIMIT_MAX', 30),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication requests, please try again later.' },
}));

app.use('/api', rateLimit({
  windowMs: rateLimitWindowMs,
  limit: getPositiveIntegerEnv('API_RATE_LIMIT_MAX', 1000),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
}));

// ─── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true, limit: '12mb' }));

// ─── Swagger UI ───────────────────────────────────────────────────────────────
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customSiteTitle: 'Auriva API Docs',
  swaggerOptions: { persistAuthorization: true },
}));

// Expose raw OpenAPI JSON for tooling
app.get('/api-docs.json', (req, res) => res.json(swaggerSpec));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api', require('./src/routes'));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ─── 404 handler ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ─── Global error handler ─────────────────────────────────────────────────────
// Express 5 automatically catches async errors and routes them here.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error(err.message, { stack: err.stack, path: req.path });

  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  if (err instanceof ApiError) {
    // express-validator's error array includes the raw submitted `value` per
    // field, which for this API can be an 8MB base64 audio blob of a child's
    // recording — never echo submitted values back in the response.
    const details = Array.isArray(err.details)
      ? err.details.map(({ value, ...rest }) => rest)
      : err.details;

    return res.status(err.statusCode).json({
      error: err.message,
      ...(details && { details }),
    });
  }

  if (err.code === 'AUDIO_QUALITY_FAILED' || err.code === 'WORD_MISMATCH') {
    return res.status(422).json({
      error: err.message,
      code: err.code,
      ...(err.details && { details: err.details }),
    });
  }

  if (err.code === 'ACOUSTIC_SCORING_FAILED' || err.code === 'GOP_UNAVAILABLE') {
    return res.status(503).json({
      error: 'Scoring is temporarily unavailable. Please try recording again.',
      code: err.code,
    });
  }

  if (err.name === 'SequelizeUniqueConstraintError') {
    return res.status(409).json({ error: 'A record with that value already exists' });
  }

  if (err.name === 'SequelizeValidationError') {
    return res.status(422).json({
      error:   'Database validation error',
      details: err.errors.map((e) => ({ field: e.path, message: e.message })),
    });
  }

  res.status(500).json({ error: 'Internal server error' });
});

// ─── Startup ──────────────────────────────────────────────────────────────────
async function start() {
  logger.info(`Connecting to database at ${process.env.DB_HOST}:${process.env.DB_PORT || 5432}`);
  await sequelize.authenticate();
  logger.info('Database connection established');

  if (process.env.NODE_ENV === 'development') {
    logger.info('Syncing database schema');
    await sequelize.sync({ alter: { drop: false } });
    logger.info('Database schema synced');
  }

  app.listen(PORT, () => {
    logger.info(`Auriva backend running on port ${PORT} [${process.env.NODE_ENV}]`);
    logger.info(`Swagger UI → http://localhost:${PORT}/api-docs`);
  });
}

start().catch((err) => {
  logger.error(`Startup failed: ${err.name || 'Error'} - ${err.message}`, {
    stack: err.stack,
  });
  process.exit(1);
});
