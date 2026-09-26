'use strict';

// Proposal FR-16, Phase 7B — the single, authoritative vocabulary + policy
// for the live handwriting-session snapshot (student_live_handwriting_sessions).
// Centralized here (not scattered across the model/service/controller) so
// the Sequelize model's `validate.isIn` and the service's own ingestion
// checks reuse exactly one array — never two copies that could drift apart.
// Mirrors this project's established convention (see letterSupportLevels.js,
// demoSpeedPolicy.js).
//
// This is a near-real-time PROTOTYPE policy (spec item 2) — snapshot-based
// polling, not sub-second streaming, and not continuous biometric
// monitoring of any kind.

// What the child is currently doing. 'break'/'idle'/'completed' are valid
// activity_type values (distinct from the top-level session `status` field
// below) per spec §3's own listed vocabulary.
const LIVE_ACTIVITY_TYPES = Object.freeze([
  'prewriting', 'lowercase_letter', 'uppercase_letter',
  'word_writing', 'word_activity', 'break', 'idle', 'completed',
]);

// The session-level lifecycle (spec §18): active while writing/on a
// learning screen, break while paused for a break, ended once the child
// has left the module (Finish for Now, natural navigation-out, or a fresh
// process start). There is no persisted 'idle'/'not_active' status — a row
// simply not existing (or status === 'ended') IS "not active"; the teacher
// UI derives NOT ACTIVE from that, never from a stored value (spec §13).
const LIVE_SESSION_STATUSES = Object.freeze(['active', 'break', 'ended']);

const LIVE_CASE_TYPES = Object.freeze(['lowercase', 'uppercase']);

// Reasonable bounds — reject obviously-bogus values rather than silently
// clamping them (spec §12: "do not trust arbitrary body keys").
const MAX_ATTEMPT_NUMBER          = 20;
const MAX_ELAPSED_ACTIVE_SECONDS  = 24 * 60 * 60; // one full day — generous upper bound, not a real limit
const MAX_CURRENT_ITEM_LENGTH     = 30;
const MIN_SCORE                   = 0;
const MAX_SCORE                   = 100;

// Engineering/pilot default (spec §13) — not a research-validated
// disconnection threshold. "LIVE" while a row was updated within this
// window; "STALE" once older. Centralized so the server (which computes
// connection_status in the GET response) is the single source of truth —
// the teacher UI never re-derives this from a raw timestamp itself.
const STALE_THRESHOLD_SECONDS = 15; // PILOT / ENGINEERING DEFAULT — see spec §13 example (10–15s)

// ─── Rate-limit budget for the polled live-session endpoints ────────────────
//
// Live-session GET/PUT is POLLING TELEMETRY, not auth/CRUD, and the global
// /api limiter (100 requests / 15 min) is explicitly "sized for auth and CRUD,
// not telemetry" — see index.js, which already carves out a separate, looser
// budget for concept telemetry for exactly this reason. Without the same
// carve-out here the poller exhausts the whole /api budget on its own:
//
//   window / poll interval      = 900000ms / 5000ms = 180 requests per client
//   teacher GET + child PUT     = 180 x 2           = 360 per teacher/child pair
//   ...against a 100-request budget, i.e. exhausted in ~8 minutes of simply
//   sitting on the Student Detail screen, after which EVERY /api call 429s.
//
// The budget below is DERIVED from the documented poll interval rather than
// being a magic number, so it cannot drift if that interval changes.
//
// The teacher-side interval itself lives in the frontend
// (auriva-frontend/src/constants/liveSessionPolicy.js LIVE_SESSION_POLL_MS);
// this is the mirrored value used only for sizing, following the same
// deliberate frontend/backend policy-mirroring convention as
// collectionProtocolValidation.js. Both are 5000ms (spec §15/§16).
const LIVE_SESSION_POLL_MS = 5000;

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // matches the global /api window

// Teacher GET poll + child PUT heartbeat.
const RATE_LIMIT_DIRECTIONS = 2;

// A classroom of tablets shares one NAT'd IP (index.js's own note), so the
// budget must cover several concurrent pairs behind a single address. Raise
// this if a pilot classroom is larger than this many simultaneous sessions.
const RATE_LIMIT_CONCURRENT_DEVICE_ALLOWANCE = 6;

const RATE_LIMIT_MAX =
  Math.ceil(RATE_LIMIT_WINDOW_MS / LIVE_SESSION_POLL_MS)
  * RATE_LIMIT_DIRECTIONS
  * RATE_LIMIT_CONCURRENT_DEVICE_ALLOWANCE;

module.exports = {
  LIVE_ACTIVITY_TYPES,
  LIVE_SESSION_STATUSES,
  LIVE_CASE_TYPES,
  MAX_ATTEMPT_NUMBER,
  MAX_ELAPSED_ACTIVE_SECONDS,
  MAX_CURRENT_ITEM_LENGTH,
  MIN_SCORE,
  MAX_SCORE,
  STALE_THRESHOLD_SECONDS,
  LIVE_SESSION_POLL_MS,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_DIRECTIONS,
  RATE_LIMIT_CONCURRENT_DEVICE_ALLOWANCE,
  RATE_LIMIT_MAX,
};
