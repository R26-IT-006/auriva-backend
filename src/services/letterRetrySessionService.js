'use strict';

/**
 * letterRetrySessionService.js
 *
 * Resolves the `retry_session_key` a client may present when re-submitting a
 * cycle whose attempt 3 suffered a TECHNICAL CAPTURE FAULT.
 *
 * ── The problem this closes ──────────────────────────────────────────────
 * `session_key` is minted server-side, once per POST (`randomUUID()` in
 * recordLetterCompletion). When attempt 3 fails to capture, the cycle is
 * still persisted — attempts 1 and 2 complete, attempt 3 'incomplete' — and
 * the client then retries. The retry is a NEW POST, so it got a NEW
 * session_key, and re-sent attempts 1 and 2 alongside the fresh attempt 3:
 *
 *   session A:  A1(complete)  A2(complete)  A3(incomplete)
 *   session B:  A1(complete)  A2(complete)  A3(complete)   <- A1/A2 duplicated
 *
 * Cycle COUNTING was always correct (session A has no complete attempt 3, so
 * groupIntoCycles never treated it as a cycle). The damage was to the
 * research store: duplicated attempt rows contaminate attempt distributions
 * and any future Motor Score calibration drawn from them.
 *
 * ── Why a server-issued token, not client-generated session keys ─────────
 * The client never invents an identifier here. The server mints the
 * session_key exactly as it always has, hands that same value back in the
 * capture-fault response, and — when the client returns it — re-validates it
 * from scratch against the database before honouring it. The client is a
 * courier, not an authority. A client-generated-key redesign would have
 * moved session identity into the payload for EVERY cycle, expanding the
 * trust surface to fix one narrow path.
 *
 * ── What is validated (all of it, every time) ────────────────────────────
 * A presented key is honoured only if the rows it names are:
 *   - the same student (and that student is already ownership-checked by the
 *     caller, so a key naming another teacher's student can never match)
 *   - the same letter and case_type
 *   - normal learning (collection_mode=false, source_type=null) — a Writing
 *     Check or research session can never be resumed through this path
 *   - on the SAME practice date
 *   - genuinely an unfinished capture-fault cycle: no COMPLETE attempt-3 row
 *
 * That last condition is what stops a genuine COVERAGE failure from being
 * re-opened. A coverage failure has a complete attempt 3, consumed its
 * cycle, and is finished business.
 *
 * ── Rejection is never an error ──────────────────────────────────────────
 * An unusable key resolves to `rejected` and the caller mints a fresh
 * session, exactly as if no key had been sent. A child mid-practice is never
 * shown an error because of a stale or malformed token; the only consequence
 * of a bad key is that it is ignored.
 */

const { Op } = require('sequelize');
const { LetterAttempt } = require('../models');
const { toPracticeDate, currentPracticeDate } = require('../config/practiceCyclePolicy');
const { MASTERY_ATTEMPT_NUMBER } = require('../config/masteryPolicy');
const { CAPTURE_STATUS } = require('../utils/captureStatus');
const logger = require('../utils/logger');

/** Stable rejection vocabulary — never an overloaded generic string. */
const RETRY_REJECTION = {
  MALFORMED:        'malformed_retry_session_key',
  NOT_FOUND:        'retry_session_not_found',
  STUDENT_MISMATCH: 'retry_session_student_mismatch',
  LETTER_MISMATCH:  'retry_session_letter_mismatch',
  NOT_NORMAL:       'retry_session_not_normal_learning',
  DATE_MISMATCH:    'retry_session_different_practice_date',
  ALREADY_COMPLETE: 'retry_session_already_completed',
  READ_FAILED:      'retry_session_read_failed',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {{
 *   studentId: number,
 *   letter: string,
 *   caseType: string,
 *   retrySessionKey: unknown,
 * }} args
 * @returns {Promise<{
 *   status: 'accepted'|'not_requested'|'rejected',
 *   sessionKey: string|null,
 *   reason: string|null,
 *   existingAttemptNumbers: number[],
 * }>}
 */
async function resolveRetrySessionKey({ studentId, letter, caseType, retrySessionKey }) {
  const none = { sessionKey: null, existingAttemptNumbers: [] };

  if (retrySessionKey == null) {
    return { status: 'not_requested', reason: null, ...none };
  }
  if (typeof retrySessionKey !== 'string' || !UUID_RE.test(retrySessionKey)) {
    return { status: 'rejected', reason: RETRY_REJECTION.MALFORMED, ...none };
  }

  let rows;
  try {
    // Deliberately queried by session_key ALONE, then checked field by field
    // below. Filtering by student_id/letter in the WHERE clause would make a
    // key belonging to another student look simply "not found", losing the
    // ability to log an attempted cross-attachment as what it is.
    rows = await LetterAttempt.findAll({
      where: { session_key: retrySessionKey },
      attributes: ['student_id', 'letter', 'case_type', 'attempt_number',
                   'collection_mode', 'source_type', 'capture_status', 'created_at'],
      raw: true,
    });
  } catch (err) {
    logger.error('Retry session lookup failed', { studentId, letter, caseType, errorMessage: err.message });
    return { status: 'rejected', reason: RETRY_REJECTION.READ_FAILED, ...none };
  }

  if (rows.length === 0) {
    return { status: 'rejected', reason: RETRY_REJECTION.NOT_FOUND, ...none };
  }

  // ── Ownership. The caller has already ownership-checked studentId against
  // the authenticated teacher, so matching here is what prevents a client
  // attaching an attempt to ANOTHER student's cycle.
  if (rows.some(r => Number(r.student_id) !== Number(studentId))) {
    logger.warn('Retry session key rejected — student mismatch', {
      studentId, letter, caseType, retrySessionKey,
    });
    return { status: 'rejected', reason: RETRY_REJECTION.STUDENT_MISMATCH, ...none };
  }

  if (rows.some(r => r.letter !== letter || r.case_type !== caseType)) {
    return { status: 'rejected', reason: RETRY_REJECTION.LETTER_MISMATCH, ...none };
  }

  // Writing Check and research collection keep their own session identity and
  // can never be resumed through this path.
  if (rows.some(r => r.collection_mode === true || r.source_type != null)) {
    return { status: 'rejected', reason: RETRY_REJECTION.NOT_NORMAL, ...none };
  }

  const today = currentPracticeDate();
  if (rows.some(r => toPracticeDate(r.created_at) !== today)) {
    return { status: 'rejected', reason: RETRY_REJECTION.DATE_MISMATCH, ...none };
  }

  // A cycle with a COMPLETE attempt 3 is finished — passed, below threshold,
  // or a genuine coverage failure. All three already consumed their cycle and
  // must never be re-opened as if they were a capture fault.
  const hasCompleteMasteryAttempt = rows.some(
    r => Number(r.attempt_number) === MASTERY_ATTEMPT_NUMBER
      && r.capture_status === CAPTURE_STATUS.COMPLETE,
  );
  if (hasCompleteMasteryAttempt) {
    return { status: 'rejected', reason: RETRY_REJECTION.ALREADY_COMPLETE, ...none };
  }

  return {
    status: 'accepted',
    sessionKey: retrySessionKey,
    reason: null,
    existingAttemptNumbers: [...new Set(rows
      .filter(r => r.capture_status === CAPTURE_STATUS.COMPLETE)
      .map(r => Number(r.attempt_number)))].sort((a, b) => a - b),
  };
}

module.exports = { resolveRetrySessionKey, RETRY_REJECTION };
