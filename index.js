'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });

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

// ─── Rate limiting (100 req / 15 min per IP) ──────────────────────────────────
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
}));

// ─── Body parsing ─────────────────────────────────────────────────────────────
// 5mb limit: handwriting assessments send raw stroke point arrays that can be large
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

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

// ─── Self-heal: students.personal_thresholds ──────────────────────────────────
// This DB is shared across dev machines, and a teammate booting with
// ALLOW_DB_SYNC=true on stale code (missing the alter:{drop:false} guard
// below) can still run a full sync({ alter: true }) and drop this column out
// from under everyone else — it has happened repeatedly, and mid-session, not
// just at boot. Rather than everyone re-running the migration by hand each
// time it's dropped, poll for it and re-add it whenever it's missing. This
// never drops or alters anything else, so it's safe even outside
// ALLOW_DB_SYNC and even while the server is already handling traffic.
async function ensurePersonalThresholdsColumn() {
  const [[info]] = await sequelize.query(
    `SELECT count(*) AS has_col FROM information_schema.columns
      WHERE table_name='students' AND column_name='personal_thresholds'`
  );
  if (Number(info.has_col) === 0) {
    logger.warn('students.personal_thresholds missing — re-adding it (likely dropped by another dev\'s sync against this shared DB)');
    await sequelize.getQueryInterface().addColumn('students', 'personal_thresholds', {
      type:         require('sequelize').DataTypes.JSONB,
      allowNull:    false,
      defaultValue: {},
    });
    logger.warn('students.personal_thresholds re-added');
  }
  return Number(info.has_col) !== 0;
}

// ─── Startup ──────────────────────────────────────────────────────────────────
async function start() {
  await sequelize.authenticate();
  logger.info('Database connection established');

  const [[info]] = await sequelize.query(
    `SELECT current_database() AS db, current_schema() AS schema,
            (SELECT count(*) FROM information_schema.columns
              WHERE table_name='students' AND column_name='personal_thresholds') AS has_col`
  );
  logger.info(`DB → ${info.db} schema=${info.schema} personal_thresholds=${info.has_col}`);

  await ensurePersonalThresholdsColumn();

  // Re-check periodically while running, not just at boot — another dev's
  // machine can drop the column at any point in this server's lifetime.
  setInterval(() => {
    ensurePersonalThresholdsColumn().catch((err) => {
      logger.error('personal_thresholds self-heal check failed', { err });
    });
  }, 60_000).unref();

  // Schema changes belong in migrations (see migrations/) from here on.
  // sync({ alter: true }) is disabled by default — it runs ALTER TABLE
  // against the live schema on every boot with no confirmation, which is
  // unsafe once real data exists. NODE_ENV=development is not a safe proxy
  // for "ok to auto-alter," since this backend can point at a real
  // database even in development. Opt in explicitly and only on a
  // disposable local/dev database — never against the school data.
  const allowSync = process.env.ALLOW_DB_SYNC === 'true' && process.env.NODE_ENV !== 'production';
  if (allowSync) {
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
  logger.error('Startup failed', { err });
  process.exit(1);
});
