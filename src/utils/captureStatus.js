'use strict';

/**
 * captureStatus.js
 *
 * ONE predicate for "was this attempt actually captured?", shared by the code
 * that STORES a row and the code that SCORES it.
 *
 * ── Why this file exists ─────────────────────────────────────────────────
 * The two questions used to be answered by two different functions that could
 * not see each other:
 *
 *   rowCaptureStatus()        (private to handwritingController) decided what
 *                             got STORED as `capture_status`
 *   isAttemptCoverageValid()  decided what got SCORED
 *
 * `isAttemptCoverageValid` returns `false` for an EMPTY drawing and for a
 * genuine-but-tiny drawing alike — `getDrawingBounds([])` is {0,0,0}, which
 * fails the coverage test exactly as a real small trace does. So a device
 * fault that captured nothing was indistinguishable, at the mastery gate,
 * from a child who really did write too little. Both produced
 * `attempt3_coverage_invalid`, both failed the cycle, and the child was told
 * "keep practising" for handwriting the system never recorded.
 *
 * Centralising the predicate is the fix: the row this module calls
 * 'incomplete' is now exactly the row the mastery gate refuses to evaluate.
 * They cannot drift apart, because there is only one of them.
 *
 * ── Semantics are UNCHANGED ──────────────────────────────────────────────
 * Byte-for-byte the previous rowCaptureStatus() rule:
 *   complete   = strokePoints is a non-empty array
 *                AND features is a non-empty object
 *   incomplete = anything else
 *
 * The LetterAttempt/ShapeFeature enums also carry 'abandoned' and
 * 'network_failed'. NOTHING has ever written either value, and this task
 * deliberately does not start: inventing new capture semantics is a separate,
 * larger decision than making the existing one consistent. They remain
 * unused vocabulary, documented here so the gap is visible rather than
 * forgotten.
 *
 * Pure; no I/O. Never blocks a save — a row is always persisted, it is only
 * LABELLED.
 */

const CAPTURE_STATUS = Object.freeze({
  COMPLETE:   'complete',
  INCOMPLETE: 'incomplete',
});

/**
 * @param {{ strokePoints?: Array, features?: Object }} attempt
 * @returns {'complete'|'incomplete'}
 */
function rowCaptureStatus({ strokePoints, features }) {
  const hasStrokes  = Array.isArray(strokePoints) && strokePoints.length > 0;
  const hasFeatures = features != null && typeof features === 'object' && Object.keys(features).length > 0;
  return hasStrokes && hasFeatures ? CAPTURE_STATUS.COMPLETE : CAPTURE_STATUS.INCOMPLETE;
}

/**
 * Convenience wrapper for the scoring path, which holds an attempt object
 * shaped `{ strokes, features }` rather than `{ strokePoints, features }`.
 * Same predicate, no second rule.
 */
function isAttemptCaptureComplete(attempt) {
  return rowCaptureStatus({
    strokePoints: attempt?.strokes,
    features:     attempt?.features,
  }) === CAPTURE_STATUS.COMPLETE;
}

module.exports = { CAPTURE_STATUS, rowCaptureStatus, isAttemptCaptureComplete };
