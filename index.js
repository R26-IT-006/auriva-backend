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
// Concept learning gets its own, much looser budget. It emits per-tap and
// per-round telemetry (image taps, match attempts, activity rounds), so a single
// child working through a few concepts plus one activity can run to hundreds of
// requests — and a classroom of tablets shares one NAT'd IP. The 100/15min bar
// below is sized for auth and CRUD, not telemetry.
const CONCEPT_PREFIX = '/api/teacher/concepts';

app.use(CONCEPT_PREFIX, rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
}));

app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.originalUrl.startsWith(CONCEPT_PREFIX),
  message: { error: 'Too many requests, please try again later.' },
}));

// ─── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
    return res.status(err.statusCode).json({
      error:   err.message,
      ...(err.details && { details: err.details }),
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
  await sequelize.authenticate();
  logger.info('Database connection established');

  // Schema changes belong in migrations (see migrations/), not in sync().
  //
  // This used to be `if (NODE_ENV === 'development') sequelize.sync({ alter: true })`,
  // which ran ALTER TABLE against the live schema on every boot. NODE_ENV is
  // 'development' on every developer machine, but they all point at the SHARED
  // Azure database — and alter:true defaults to drop:true, so booting this branch
  // dropped students.reduce_stimulation and students.personal_thresholds, which
  // this branch's Student model does not declare. ddl_audit_log recorded six such
  // drop/restore cycles between 2026-08-08 and 2026-08-16, from five different
  // developer machines, each one 500-ing the app for everyone else.
  //
  // Now opt-in and non-destructive:
  //   ALLOW_DB_SYNC=true   — explicit, and absent from .env by default
  //   alter: { drop: false } — never remove a column this branch's models
  //                            happen not to know about
  // Only ever enable it against a disposable local database.
  const allowSync = process.env.ALLOW_DB_SYNC === 'true' && process.env.NODE_ENV !== 'production';
  if (allowSync) {
    await sequelize.sync({ alter: { drop: false } });
    logger.warn('Database schema synced via ALLOW_DB_SYNC=true (alter, drop: false) — local/dev databases only');
  } else {
    logger.info('Schema sync skipped — use migrations for schema changes');
  }

  app.listen(PORT, () => {
    logger.info(`Auriva backend running on port ${PORT} [${process.env.NODE_ENV}]`);
    logger.info(`Swagger UI → http://localhost:${PORT}/api-docs`);
  });
}

start().catch((err) => {
  logger.error('Startup failed', { err });
  process.exit(1);
});
