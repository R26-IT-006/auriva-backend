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
};
