'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });

const express   = require('express');
const helmet    = require('helmet');
const cors      = require('cors');
const morgan    = require('morgan');
const rateLimit = require('express-rate-limit');
const logger       = require('./src/utils/logger');
const ApiError     = require('./src/utils/ApiError');
const { sequelize }      = require('./src/models');
const fixCat3ForeignKeys = require('./src/utils/fixCat3ForeignKeys');
const swaggerUi          = require('swagger-ui-express');
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
// 12mb (up from 10mb) — the pronunciation module posts base64 audio recordings.
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

  const [[info]] = await sequelize.query(
    `SELECT current_database() AS db, current_schema() AS schema,
            (SELECT count(*) FROM information_schema.columns
              WHERE table_name='students' AND column_name='personal_thresholds') AS has_col`
  );
  logger.info(`DB → ${info.db} schema=${info.schema} personal_thresholds=${info.has_col}`);

  // Schema changes belong in migrations (see migrations/) from here on.
  // sync({ alter: true }) is disabled by default — it runs ALTER TABLE
  // against the live schema on every boot with no confirmation, which is
  // unsafe once real data exists. NODE_ENV=development is not a safe proxy
  // for "ok to auto-alter," since this backend can point at a real
  // database even in development. Opt in explicitly and only on a
  // disposable local/dev database — never against the school data.
  const allowSync = process.env.ALLOW_DB_SYNC === 'true' && process.env.NODE_ENV !== 'production';
  if (allowSync) {
    // Clears the stale Cat3 word_id FK constraints so the sync below can
    // recreate them — it only makes sense immediately before a sync, which is
    // why it sits inside this branch rather than running on every boot.
    await fixCat3ForeignKeys();
    // alter: { drop: false } — never let an out-of-date local model definition
    // drop a live column. This DB is shared across dev machines, and alter:true's
    // default (drop: true) has repeatedly dropped students.personal_thresholds
    // out from under other developers whose Student model already had it.
    await sequelize.sync({ alter: { drop: false } });
    logger.warn('Database schema synced via ALLOW_DB_SYNC=true (alter: true, drop: false) — should only happen on a local/dev database');
  } else {
    logger.info('Schema sync skipped (set ALLOW_DB_SYNC=true on a non-production, disposable database to enable) — use migrations for schema changes');
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
