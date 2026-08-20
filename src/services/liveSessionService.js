'use strict';

// Proposal FR-16, Phase 7B — real-time (near-real-time, snapshot-polling)
// teacher session monitoring. This service owns the ONE current live-
// session row per student (student_live_handwriting_sessions — see the
// migration/model for why student_id is the table's own primary key).
//
// Privacy / data minimization (spec §4): this module never reads or writes
// raw stroke coordinates, medical/diagnosis details, Feature 11 research
// internals, or model centroid distances. Only the small snapshot fields
// listed in WHITELISTED_FIELDS ever cross this boundary — anything else in
// a request body is silently ignored, never mass-assigned (spec §12).
//
// This is an EDUCATIONAL SUPERVISION feature, not a research data feed —
// collection_mode sessions never reach this table at all (excluded at the
// frontend call-site; see LearningSessionContext.js's own header for that
// decision, spec §19).

const { StudentLiveHandwritingSession } = require('../models');
const ApiError = require('../utils/ApiError');
const teacherService = require('./teacherService');
const { isValidLetterSupportLevel } = require('../config/letterSupportLevels');
const {
  LIVE_ACTIVITY_TYPES, LIVE_SESSION_STATUSES, LIVE_CASE_TYPES,
  MAX_ATTEMPT_NUMBER, MAX_ELAPSED_ACTIVE_SECONDS, MAX_CURRENT_ITEM_LENGTH,
  MIN_SCORE, MAX_SCORE, STALE_THRESHOLD_SECONDS,
} = require('../config/liveSessionPolicy');

const WHITELISTED_FIELDS = [
  'activity_type', 'status', 'current_item', 'case_type',
  'attempt_number', 'support_level', 'elapsed_active_seconds', 'latest_saved_score',
];

/**
 * Validates + whitelists an incoming PUT body (spec §12). Every field is
 * OPTIONAL — a screen sends only whatever actually changed (spec §8's
 * "meaningful events" model, not a full snapshot on every call) — but
 * whatever IS present must pass validation, or the whole request is
 * rejected (422) rather than silently dropped or coerced. Keys outside
 * WHITELISTED_FIELDS are always ignored — never mass-assigned.
 *
 * @throws {ApiError} 422 on any invalid present field.
 */
function sanitizeLivePatch(body) {
  if (!body || typeof body !== 'object') throw new ApiError(422, 'Request body required');
  const patch = {};

  if ('activity_type' in body) {
    if (!LIVE_ACTIVITY_TYPES.includes(body.activity_type)) {
      throw new ApiError(422, `activity_type must be one of: ${LIVE_ACTIVITY_TYPES.join(', ')}`);
    }
    patch.activity_type = body.activity_type;
  }

  if ('status' in body) {
    if (!LIVE_SESSION_STATUSES.includes(body.status)) {
      throw new ApiError(422, `status must be one of: ${LIVE_SESSION_STATUSES.join(', ')}`);
    }
    patch.status = body.status;
  }

  if ('current_item' in body) {
    if (body.current_item !== null
        && (typeof body.current_item !== 'string' || body.current_item.length === 0 || body.current_item.length > MAX_CURRENT_ITEM_LENGTH)) {
      throw new ApiError(422, `current_item must be a non-empty string of at most ${MAX_CURRENT_ITEM_LENGTH} characters, or null`);
    }
    patch.current_item = body.current_item;
  }

  if ('case_type' in body) {
    if (body.case_type !== null && !LIVE_CASE_TYPES.includes(body.case_type)) {
      throw new ApiError(422, `case_type must be one of: ${LIVE_CASE_TYPES.join(', ')}, or null`);
    }
    patch.case_type = body.case_type;
  }

  if ('attempt_number' in body) {
    const n = body.attempt_number;
    if (n !== null && (!Number.isInteger(n) || n < 1 || n > MAX_ATTEMPT_NUMBER)) {
      throw new ApiError(422, `attempt_number must be an integer between 1 and ${MAX_ATTEMPT_NUMBER}, or null`);
    }
    patch.attempt_number = n;
  }

  if ('support_level' in body) {
    if (body.support_level !== null && !isValidLetterSupportLevel(body.support_level)) {
      throw new ApiError(422, 'support_level must be a valid letter support level, or null');
    }
    patch.support_level = body.support_level;
  }

  if ('elapsed_active_seconds' in body) {
    const s = body.elapsed_active_seconds;
    if (!Number.isInteger(s) || s < 0 || s > MAX_ELAPSED_ACTIVE_SECONDS) {
      throw new ApiError(422, `elapsed_active_seconds must be a non-negative integer (max ${MAX_ELAPSED_ACTIVE_SECONDS})`);
    }
    patch.elapsed_active_seconds = s;
  }

  if ('latest_saved_score' in body) {
    const sc = body.latest_saved_score;
    if (sc !== null && (typeof sc !== 'number' || Number.isNaN(sc) || sc < MIN_SCORE || sc > MAX_SCORE)) {
      throw new ApiError(422, `latest_saved_score must be a number between ${MIN_SCORE} and ${MAX_SCORE}, or null`);
    }
    patch.latest_saved_score = sc;
  }

  return patch;
}

/**
 * PUT /handwriting/live-session/:studentId — upserts the one current
 * snapshot row for this student. NEVER creates a second row (spec §6/§7 —
 * "current snapshot updates rather than creating unbounded rows").
 *
 * started_at semantics (spec §17): set once when a session begins and
 * preserved across every subsequent update within that same visit. A
 * session is considered to BEGIN whenever no row currently exists, or the
 * existing row's status is 'ended' (i.e. the previous visit was explicitly
 * closed) — never merely because the letter/word/attempt changed.
 */
async function upsertLiveSession(teacherId, studentId, body) {
  await teacherService.getOwnStudentById(teacherId, studentId);
  const patch = sanitizeLivePatch(body);
  const now = new Date();

  const existing = await StudentLiveHandwritingSession.findByPk(studentId);

  if (existing) {
    const isNewSession = existing.status === 'ended';
    await existing.update({
      ...patch,
      started_at: isNewSession ? now : existing.started_at,
      last_updated_at: now,
    });
    return toSnapshot(existing);
  }

  const created = await StudentLiveHandwritingSession.create({
    student_id: studentId,
    activity_type: patch.activity_type ?? 'idle',
    status: patch.status ?? 'active',
    current_item: patch.current_item ?? null,
    case_type: patch.case_type ?? null,
    attempt_number: patch.attempt_number ?? null,
    support_level: patch.support_level ?? null,
    elapsed_active_seconds: patch.elapsed_active_seconds ?? 0,
    latest_saved_score: patch.latest_saved_score ?? null,
    started_at: now,
    last_updated_at: now,
  });
  return toSnapshot(created);
}

/**
 * GET /handwriting/live-session/:studentId — read-only. `{status:
 * 'not_active'}` when no row has ever been written for this student (spec
 * §13's NOT ACTIVE state). When a row exists, returns the sanitized
 * snapshot plus a server-computed `connection_status` ('live'|'stale'|
 * 'not_active') so the teacher UI never re-derives staleness from a raw
 * timestamp itself — one source of truth (STALE_THRESHOLD_SECONDS),
 * server-side.
 */
async function getLiveSession(teacherId, studentId) {
  await teacherService.getOwnStudentById(teacherId, studentId);
  const row = await StudentLiveHandwritingSession.findByPk(studentId);
  if (!row) return { status: 'not_active' };
  return toSnapshot(row);
}

function toSnapshot(row) {
  const ageSeconds = (Date.now() - new Date(row.last_updated_at).getTime()) / 1000;
  const connectionStatus = row.status === 'ended'
    ? 'not_active'
    : (ageSeconds <= STALE_THRESHOLD_SECONDS ? 'live' : 'stale');

  return {
    student_id:             row.student_id,
    activity_type:          row.activity_type,
    status:                 row.status,
    current_item:           row.current_item,
    case_type:              row.case_type,
    attempt_number:         row.attempt_number,
    support_level:          row.support_level,
    elapsed_active_seconds: row.elapsed_active_seconds,
    latest_saved_score:     row.latest_saved_score,
    started_at:             row.started_at,
    last_updated_at:        row.last_updated_at,
    connection_status:      connectionStatus,
  };
}

module.exports = { upsertLiveSession, getLiveSession, sanitizeLivePatch };
