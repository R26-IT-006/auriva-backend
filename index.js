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
const { ensurePersonalThresholdsColumn } = require('./src/utils/ensurePersonalThresholdsColumn');
const swaggerUi          = require('swagger-ui-express');
const swaggerSpec  = require('./src/config/swagger');
const phonemeGopService = require('./src/services/phonemeGopService');

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
// PATCH added (final pre-PP2 fix) — PATCH /handwriting/assessment/:id/finalize
// and PATCH /handwriting/collection-session/:id/complete both already exist
// as real routes; this list previously omitted the verb entirely. The React
// Native app itself is unaffected either way (CORS preflight is a browser
// mechanism, not enforced by native fetch/axios), but a future browser-based
// admin tool or a CORS-aware HTTP client would otherwise be silently blocked
// on these two routes.
//
// origin: CORS_ORIGIN falls back to '*' when unset — an accepted, documented
// development/pilot-stage default (see .env.example), not tightened here to
// avoid an unreviewed production-security change immediately before PP2.
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
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

// Concept learning gets its own, much looser budget. It emits per-tap and
// per-round telemetry (image taps, match attempts, activity rounds), so a single
// child working through a few concepts plus one activity can run to hundreds of
// requests — and a classroom of tablets shares one NAT'd IP. The general /api
// bar below is sized for auth and CRUD, not telemetry.
const CONCEPT_PREFIX = '/api/teacher/concepts';

// Live-session snapshot polling is telemetry for the same reason concepts are:
// the teacher UI GETs every ~5s while the Student Detail screen is focused and
// the child-side PUTs a heartbeat on the same cadence. At 5s that is 180
// requests per client per 15-minute window (360 for a teacher/child pair) —
// which alone exceeds the 100/15min bar below, exhausting it in ~8 minutes and
// then 429-ing every other /api call as collateral. The budget is derived from
// the documented poll interval in src/config/liveSessionPolicy.js so it cannot
// drift from it.
//
// This does NOT widen unauthenticated surface: every route under
// /api/handwriting sits behind `router.use(verifyToken, isTeacher)`
// (src/routes/handwriting.js), and auth/CRUD keep the strict 100/15min budget.
const LIVE_SESSION_PREFIX = '/api/handwriting/live-session';
const liveSessionPolicy = require('./src/config/liveSessionPolicy');

app.use(CONCEPT_PREFIX, rateLimit({
  windowMs: rateLimitWindowMs,
  limit: getPositiveIntegerEnv('CONCEPT_RATE_LIMIT_MAX', 1000),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
}));

app.use(LIVE_SESSION_PREFIX, rateLimit({
  windowMs: liveSessionPolicy.RATE_LIMIT_WINDOW_MS,
  limit: liveSessionPolicy.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
}));

app.use('/api', rateLimit({
  windowMs: rateLimitWindowMs,
  limit: getPositiveIntegerEnv('API_RATE_LIMIT_MAX', 1000),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.originalUrl.startsWith(CONCEPT_PREFIX)
    || req.originalUrl.startsWith(LIVE_SESSION_PREFIX),
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
  // A Sequelize database error's own message is only the Postgres headline
  // ("invalid input syntax for type json"), which does not say which column or
  // value was rejected — the useful part lives on err.parent. Surface it, plus
  // the statement, so a failing write can be diagnosed from the log instead of
  // by guesswork. Bind parameters are deliberately NOT logged: for this API
  // they include the child's raw audio blob (see the note on err.details below).
  const dbDetail = err.parent || err.original;
  logger.error(err.message, {
    stack: err.stack,
    path: req.path,
    ...(dbDetail && {
      db_detail: dbDetail.detail || null,
      db_column: dbDetail.column || null,
      db_table: dbDetail.table || null,
      db_code: dbDetail.code || null,
      db_routine: dbDetail.routine || null,
      sql: typeof err.sql === 'string' ? err.sql.slice(0, 2000) : null,
    }),
  });

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

  if (err.name === 'SequelizeConnectionAcquireTimeoutError') {
    const isScoringRequest = req.path.endsWith('/pronunciation-score');
    return res.status(503).json({
      error: isScoringRequest
        ? 'Scoring is busy right now. Your recording is still saved; please press Next again.'
        : 'The service is busy right now. Please try again.',
      code: 'DATABASE_BUSY',
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

  await ensurePersonalThresholdsColumn(sequelize);

  // Re-check periodically while running, not just at boot — another dev's
  // machine can drop the column at any point in this server's lifetime.
  // Deliberately NOT startup-only — see ensurePersonalThresholdsColumn.js
  // and the Reliability investigation report for why this interval is
  // intentional, not an oversight.
  setInterval(() => {
    ensurePersonalThresholdsColumn(sequelize).catch((err) => {
      logger.error('personal_thresholds self-heal check failed', { err });
    });
  }, 60_000).unref();

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
    // Clears the stale Cat3 word_id FK constraints so the sync below can
    // recreate them — it only makes sense immediately before a sync, which is
    // why it sits inside this branch rather than running on every boot.
    await fixCat3ForeignKeys();
    await sequelize.sync({ alter: { drop: false } });
    logger.warn('Database schema synced via ALLOW_DB_SYNC=true (alter, drop: false) — local/dev databases only');
  } else {
    logger.info('Schema sync skipped — use migrations for schema changes');
  }

  app.listen(PORT, () => {
    logger.info(`Auriva backend running on port ${PORT} [${process.env.NODE_ENV}]`);
    logger.info(`Swagger UI → http://localhost:${PORT}/api-docs`);
  });

  // Fire-and-forget: warms the GOP model in the background so the first
  // layer-1-escalated attempt doesn't pay the cold-start cost itself. On
  // failure the worker logs its own reason and scoring falls back to
  // layer-1-only, same as any later runtime GOP failure.
  phonemeGopService.warmup().then((ready) => {
    if (ready) logger.info('Phoneme GOP worker warmed up');
  });
}

start().catch((err) => {
  // Pass message/stack as top-level fields, not nested under { err } — the
  // console transport's printf format only reads top-level `message`/`stack`
  // off the log info object, so { err } silently prints just "Startup failed"
  // with no detail (confirmed: logs/error.log had the full SequelizeDatabaseError
  // detail all along, only the console output was uninformative). The name/message
  // prefix keeps that detail in the console line itself; `err` rides along for
  // the structured file transport.
  logger.error(`Startup failed: ${err.name || 'Error'} - ${err.message}`, {
    stack: err.stack,
    err,
  });
  process.exit(1);
});
