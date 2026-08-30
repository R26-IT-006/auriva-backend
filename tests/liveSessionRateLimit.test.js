'use strict';

// Live-session polling must not exhaust the global /api rate-limit budget.
//
// Regression guard for a real defect: the teacher UI GETs the live-session
// snapshot every LIVE_SESSION_POLL_MS while the Student Detail screen is
// focused, and the child side PUTs a heartbeat on the same cadence. At 5s that
// is 180 requests per client per 15-minute window — well past the global
// 100/15min /api budget, which index.js itself documents as "sized for auth and
// CRUD, not telemetry". The result was that simply sitting on the screen for
// ~8 minutes 429'd every subsequent /api call, including unrelated ones
// (observed: repeated "[liveSession] fetch failed" plus collateral
// "[familyThresholds] fetch failed — treating as read_failed").
//
// These tests pin BOTH halves of the fix: the derived budget, and the carve-out
// wiring in index.js.

const fs = require('fs');
const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');

const policy = require('../src/config/liveSessionPolicy');

const INDEX_SOURCE = fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8');

describe('live-session rate-limit budget is derived, not guessed', () => {
  it('exposes the poll interval and a window matching the global /api window', () => {
    expect(policy.LIVE_SESSION_POLL_MS).toBe(5000);
    expect(policy.RATE_LIMIT_WINDOW_MS).toBe(15 * 60 * 1000);
  });

  it('the limit is exactly the documented derivation', () => {
    const pollsPerClient = Math.ceil(policy.RATE_LIMIT_WINDOW_MS / policy.LIVE_SESSION_POLL_MS);
    expect(pollsPerClient).toBe(180);
    expect(policy.RATE_LIMIT_MAX).toBe(
      pollsPerClient * policy.RATE_LIMIT_DIRECTIONS * policy.RATE_LIMIT_CONCURRENT_DEVICE_ALLOWANCE,
    );
  });

  it('covers at least one full teacher+child pair for a whole window', () => {
    // The minimum that makes the feature usable at all: a single pair polling
    // continuously for the entire window must never be rate-limited.
    const onePairPerWindow =
      Math.ceil(policy.RATE_LIMIT_WINDOW_MS / policy.LIVE_SESSION_POLL_MS) * 2;
    expect(onePairPerWindow).toBe(360);
    expect(policy.RATE_LIMIT_MAX).toBeGreaterThanOrEqual(onePairPerWindow);
  });

  it('the budget would NOT fit inside the strict /api budget — i.e. the carve-out is necessary', () => {
    const STRICT_API_LIMIT = 100;
    const onePairPerWindow =
      Math.ceil(policy.RATE_LIMIT_WINDOW_MS / policy.LIVE_SESSION_POLL_MS) * 2;
    expect(onePairPerWindow).toBeGreaterThan(STRICT_API_LIMIT);
  });
});

describe('index.js wires the carve-out', () => {
  it('mounts a dedicated limiter on the live-session prefix', () => {
    expect(INDEX_SOURCE).toMatch(/const LIVE_SESSION_PREFIX = '\/api\/handwriting\/live-session'/);
    expect(INDEX_SOURCE).toMatch(/app\.use\(LIVE_SESSION_PREFIX, rateLimit\(/);
    expect(INDEX_SOURCE).toMatch(/liveSessionPolicy\.RATE_LIMIT_MAX/);
    expect(INDEX_SOURCE).toMatch(/liveSessionPolicy\.RATE_LIMIT_WINDOW_MS/);
  });

  it('the global /api limiter skips BOTH telemetry prefixes', () => {
    expect(INDEX_SOURCE).toMatch(/skip:\s*\(req\)\s*=>\s*req\.originalUrl\.startsWith\(CONCEPT_PREFIX\)/);
    expect(INDEX_SOURCE).toMatch(/req\.originalUrl\.startsWith\(LIVE_SESSION_PREFIX\)/);
  });

  it('auth and ordinary CRUD keep the strict 100/15min budget', () => {
    // The strict bar must still exist — the fix must not have widened it.
    expect(INDEX_SOURCE).toMatch(/limit:\s*100/);
  });
});

// Functional proof, using the same middleware composition index.js uses. Kept
// self-contained (no DB, no real routes) so it stays a fast unit test.
describe('limiter composition behaves correctly', () => {
  const CONCEPT_PREFIX = '/api/teacher/concepts';
  const LIVE_SESSION_PREFIX = '/api/handwriting/live-session';

  function buildApp() {
    const app = express();
    app.use(LIVE_SESSION_PREFIX, rateLimit({
      windowMs: policy.RATE_LIMIT_WINDOW_MS,
      limit: policy.RATE_LIMIT_MAX,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Too many requests, please try again later.' },
    }));
    app.use('/api', rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 100,
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => req.originalUrl.startsWith(CONCEPT_PREFIX)
        || req.originalUrl.startsWith(LIVE_SESSION_PREFIX),
      message: { error: 'Too many requests, please try again later.' },
    }));
    app.get('/api/*splat', (req, res) => res.json({ ok: true }));
    return app;
  }

  function listen(app) {
    return new Promise((resolve) => {
      const server = app.listen(0, () => resolve(server));
    });
  }

  async function hit(port, urlPath, times) {
    let last;
    for (let i = 0; i < times; i += 1) {
      const res = await fetch(`http://127.0.0.1:${port}${urlPath}`);
      last = { status: res.status, limit: res.headers.get('ratelimit-limit') };
    }
    return last;
  }

  it('a full window of pair polling is never rate-limited, and does not consume the /api budget', async () => {
    const server = await listen(buildApp());
    const { port } = server.address();
    try {
      // 360 = one teacher+child pair for a whole 15-minute window.
      const poll = await hit(port, '/api/handwriting/live-session/5', 360);
      expect(poll.status).toBe(200);
      expect(poll.limit).toBe(String(policy.RATE_LIMIT_MAX));

      // The strict budget is untouched by that traffic.
      const other = await hit(port, '/api/handwriting/family-thresholds/5', 1);
      expect(other.status).toBe(200);
      expect(other.limit).toBe('100');
    } finally {
      server.close();
    }
  }, 30000);

  it('exhausting the strict /api budget does NOT break live-session polling', async () => {
    const server = await listen(buildApp());
    const { port } = server.address();
    try {
      const exhausted = await hit(port, '/api/handwriting/progress/5', 101);
      expect(exhausted.status).toBe(429);

      const poll = await hit(port, '/api/handwriting/live-session/5', 1);
      expect(poll.status).toBe(200);
    } finally {
      server.close();
    }
  }, 30000);
});
