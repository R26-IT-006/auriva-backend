'use strict';

/**
 * feature9Provenance.js
 *
 * Feature 9 Step 2 — Provenance Fingerprints + Policy Versions.
 *
 * PURE CONSTANTS + PURE HELPERS ONLY. No DB reads, no filesystem, no
 * network, no logger side effects, no environment mutation — crypto
 * hashing only, matching this file's own "pure helper guarantee"
 * requirement. This module accepts already-computed data as plain
 * arguments; it never queries or re-derives anything itself.
 *
 * ── What problem this solves ────────────────────────────────────────────
 * The same (studentId, caseType, family) three-tuple can recur weeks apart
 * from genuinely different longitudinal evidence, and the same evidence can
 * later be re-evaluated under a changed policy. Neither Feature 7's stream
 * result nor Feature 8's recommendation object carries any stable identity
 * field today (confirmed absent in Feature 9 Step 1's audit, §7/§8) — this
 * module is what gives a Feature 9 validation event something durable to
 * point at, without persisting anything itself.
 *
 * ── Two-level identity (Step 2 spec §2) ─────────────────────────────────
 *   evidence fingerprint        — identifies the Feature 7 evidence window
 *   recommendation fingerprint  — identifies the Feature 8 recommendation
 *                                  instance built from that evidence, and
 *                                  CHAINS the evidence fingerprint in as one
 *                                  of its own inputs (Step 2 spec §25) —
 *                                  never independently re-derives Feature 7
 *                                  evidence.
 * These are deliberately never collapsed into one hash (Step 2 spec §2).
 *
 * ── Zero Feature 7/8 service dependency (Step 2 spec §26/§27) ──────────
 * This file imports nothing beyond Node's built-in `crypto` — not
 * `persistentDifficultyService.js`, not `persistentDifficultyEvidence.js`,
 * not `worksheetRecommendationService.js`, not `../models`. Every input is
 * accepted as an explicit argument (including `persistentPolicyVersion`,
 * `recommendationPolicyVersion`, and `mappingVersion` — Step 2 spec §53
 * prefers explicit helper inputs over an internally-imported default for
 * testability). Callers (a future Step 3 service) are responsible for
 * sourcing `MAPPING_VERSION` from `letterBaselineFamilies.js` and passing
 * it in — this file never introduces a second mapping-version scheme
 * (Step 2 spec §8) and never imports that config module itself.
 *
 * ── Opaque and non-reversible (Step 2 spec §11) ─────────────────────────
 * Both fingerprints are one-way SHA-256 hashes over a canonical payload —
 * safe to expose to a frontend later (Step 2 spec §50) precisely because
 * neither raw attempt IDs nor session keys are ever part of that payload
 * (Step 2 spec §10/§18).
 *
 * ── Research framing (Step 2 spec §66) ──────────────────────────────────
 * Fingerprinting exists for research provenance, recommendation identity,
 * race protection, and idempotent history — never for diagnostic
 * certainty, confidence scoring, or severity scoring.
 */

const crypto = require('crypto');

// ─── Policy version constants (Step 2 spec §6/§7) ──────────────────────────
// Provenance metadata only — these do not change Feature 7/8 behavior or
// output in any way. Reserved so a future policy revision (e.g. Feature 7's
// window size or Feature 8's recommendation content changing) can be
// distinguished from today's evidence/recommendations without altering
// either feature's current, already-shipped runtime code.
const PERSISTENT_DIFFICULTY_POLICY_VERSION = 'persistent_difficulty_v1';
const WORKSHEET_RECOMMENDATION_POLICY_VERSION = 'worksheet_recommendation_v1';

// Feature 7's own six-stream taxonomy (matches persistentDifficultyService.js
// and worksheetRecommendationService.js's own local CASE_TYPES/FAMILIES
// constants). Duplicated here as plain literals — NOT imported from either
// service (Step 2 spec §26/§27) — exactly the same "each layer keeps its
// own copy of this small, stable taxonomy rather than cross-importing"
// precedent Feature 8 itself already established relative to Feature 7.
const VALID_CASE_TYPES = ['lowercase', 'uppercase'];
const VALID_FAMILIES = ['straight', 'curved', 'complex'];

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

// ─── Normalization helpers ──────────────────────────────────────────────────

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

// Non-negative finite integer only — rejects NaN, Infinity, and numeric
// strings (Step 2 spec §15's "prefer strict deterministic inputs").
function isNonNegativeInteger(value) {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

// Accepts a Date instance or an ISO-parseable string; returns a canonical
// ISO string, or null on anything invalid (Step 2 spec §14) — never
// silently hashes the literal string "Invalid Date".
function toIsoTimestamp(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

// Rebuilds a window in a fixed key order from only its four known fields —
// this is what makes property-insertion-order on the caller's object
// irrelevant (Step 2 spec §12) and what makes an unrelated extra property
// on the caller's object harmless (Step 2 spec §45): only these four keys
// are ever read.
function normalizeWindow(window) {
  if (!window || typeof window !== 'object') return null;

  const successfulCycles = window.successfulCycles;
  const failedCycles = window.failedCycles;
  const evidenceStart = toIsoTimestamp(window.evidenceStart);
  const evidenceEnd = toIsoTimestamp(window.evidenceEnd);

  if (!isNonNegativeInteger(successfulCycles)) return null;
  if (!isNonNegativeInteger(failedCycles)) return null;
  if (evidenceStart === null) return null;
  if (evidenceEnd === null) return null;

  return { successfulCycles, failedCycles, evidenceStart, evidenceEnd };
}

// Preserves the caller's array order exactly (Step 2 spec §13/§21) — this
// function never sorts. Feature 7 already returns `affectedLetters` in its
// own deterministic (failedCycles desc, then totalCycles desc, then
// alphabetical) order; re-sorting here would just be redundant work, and
// would also silently hide a genuine order difference between two calls
// that canonicalization tests (§46) require to remain order-sensitive.
function normalizeAffectedLetters(affectedLetters) {
  if (!Array.isArray(affectedLetters) || affectedLetters.length === 0) return null;

  const normalized = [];
  for (const entry of affectedLetters) {
    if (!entry || typeof entry !== 'object') return null;
    if (!isNonEmptyString(entry.letter)) return null;
    if (!isNonNegativeInteger(entry.totalCycles)) return null;
    if (!isNonNegativeInteger(entry.failedCycles)) return null;
    normalized.push({ letter: entry.letter, totalCycles: entry.totalCycles, failedCycles: entry.failedCycles });
  }
  return normalized;
}

// Preserves order, rejects anything not a non-empty array of non-empty
// strings (Step 2 spec §21's "do not sort" applies identically here).
function normalizeFocusLetters(focusLetters) {
  if (!Array.isArray(focusLetters) || focusLetters.length === 0) return null;
  for (const letter of focusLetters) {
    if (!isNonEmptyString(letter)) return null;
  }
  return [...focusLetters];
}

function hashCanonicalPayload(payload) {
  const serialized = JSON.stringify(payload);
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

// ─── Canonical payload builders (Step 2 spec §12) ──────────────────────────
// Both builders construct the payload object with an explicit, fixed key
// order every time — never a spread of the caller's own object — so
// JSON.stringify's output never depends on the caller's own property
// insertion order.

function buildCanonicalEvidencePayload({
  studentId, caseType, family, earlierWindow, recentWindow, affectedLetters,
  persistentPolicyVersion, mappingVersion,
}) {
  return {
    studentId,
    caseType,
    family,
    earlierWindow,
    recentWindow,
    affectedLetters,
    persistentPolicyVersion,
    mappingVersion,
  };
}

function buildCanonicalRecommendationPayload({
  studentId, caseType, family, recommendationType, focusLetters,
  evidenceFingerprint, recommendationPolicyVersion,
}) {
  return {
    studentId,
    caseType,
    family,
    recommendationType,
    focusLetters,
    evidenceFingerprint,
    recommendationPolicyVersion,
  };
}

// ─── Evidence fingerprint (Step 2 spec §9/§10) ─────────────────────────────
/**
 * Identifies a specific Feature 7 evidence window. Pure — accepts only
 * already-computed data, never re-queries `LetterAttempt` and never
 * includes raw attempt IDs or session keys (Step 2 spec §10/§11).
 *
 * Returns a 64-char lowercase hex SHA-256 digest, or `null` if any required
 * input is missing or malformed (Step 2 spec §16) — this function never
 * throws, so a corrupt upstream Feature 7 result cannot crash a future
 * validation write path.
 *
 * @param {Object} params
 * @param {number} params.studentId
 * @param {'lowercase'|'uppercase'} params.caseType
 * @param {'straight'|'curved'|'complex'} params.family
 * @param {{successfulCycles:number, failedCycles:number, evidenceStart:(Date|string), evidenceEnd:(Date|string)}} params.earlierWindow
 * @param {{successfulCycles:number, failedCycles:number, evidenceStart:(Date|string), evidenceEnd:(Date|string)}} params.recentWindow
 * @param {Array<{letter:string, totalCycles:number, failedCycles:number}>} params.affectedLetters
 * @param {string} params.persistentPolicyVersion
 * @param {string} params.mappingVersion
 * @returns {string|null}
 */
function computePersistentEvidenceFingerprint({
  studentId,
  caseType,
  family,
  earlierWindow,
  recentWindow,
  affectedLetters,
  persistentPolicyVersion,
  mappingVersion,
} = {}) {
  if (!isPositiveInteger(studentId)) return null;
  if (!VALID_CASE_TYPES.includes(caseType)) return null;
  if (!VALID_FAMILIES.includes(family)) return null;

  const normalizedEarlierWindow = normalizeWindow(earlierWindow);
  if (normalizedEarlierWindow === null) return null;

  const normalizedRecentWindow = normalizeWindow(recentWindow);
  if (normalizedRecentWindow === null) return null;

  const normalizedAffectedLetters = normalizeAffectedLetters(affectedLetters);
  if (normalizedAffectedLetters === null) return null;

  if (!isNonEmptyString(persistentPolicyVersion)) return null;
  if (!isNonEmptyString(mappingVersion)) return null;

  const payload = buildCanonicalEvidencePayload({
    studentId,
    caseType,
    family,
    earlierWindow: normalizedEarlierWindow,
    recentWindow: normalizedRecentWindow,
    affectedLetters: normalizedAffectedLetters,
    persistentPolicyVersion,
    mappingVersion,
  });

  return hashCanonicalPayload(payload);
}

// ─── Recommendation fingerprint (Step 2 spec §17/§18) ──────────────────────
/**
 * Identifies a specific Feature 8 recommendation instance. Chains in an
 * already-computed `evidenceFingerprint` rather than re-deriving Feature 7
 * evidence itself (Step 2 spec §25) — this function never imports or calls
 * `computePersistentEvidenceFingerprint` internally; the caller supplies
 * the value.
 *
 * Deliberately excludes `title`/`rationale`/`suggestedActivities` text from
 * the hashed payload (Step 2 spec §19): `recommendationPolicyVersion`
 * already identifies the content regime that produced that text, and
 * `focusLetters` already identifies the student-specific content — hashing
 * the full text as well would make the fingerprint change on cosmetic
 * wording edits that are really `recommendationPolicyVersion` bumps, not
 * new identity. Also deliberately excludes teacher decision, teacher note,
 * teacher id, and any timestamp (Step 2 spec §18/§57 items 39-42) —
 * recommendation identity is what the SYSTEM produced, entirely independent
 * of whether or how a teacher later acted on it.
 *
 * Returns a 64-char lowercase hex SHA-256 digest, or `null` on malformed
 * input — never throws.
 *
 * @param {Object} params
 * @param {number} params.studentId
 * @param {'lowercase'|'uppercase'} params.caseType
 * @param {'straight'|'curved'|'complex'} params.family
 * @param {string} params.recommendationType
 * @param {string[]} params.focusLetters
 * @param {string} params.evidenceFingerprint - a 64-char lowercase hex SHA-256 digest, typically from computePersistentEvidenceFingerprint()
 * @param {string} params.recommendationPolicyVersion
 * @returns {string|null}
 */
function computeWorksheetRecommendationFingerprint({
  studentId,
  caseType,
  family,
  recommendationType,
  focusLetters,
  evidenceFingerprint,
  recommendationPolicyVersion,
} = {}) {
  if (!isPositiveInteger(studentId)) return null;
  if (!VALID_CASE_TYPES.includes(caseType)) return null;
  if (!VALID_FAMILIES.includes(family)) return null;
  if (!isNonEmptyString(recommendationType)) return null;

  const normalizedFocusLetters = normalizeFocusLetters(focusLetters);
  if (normalizedFocusLetters === null) return null;

  if (typeof evidenceFingerprint !== 'string' || !SHA256_HEX_PATTERN.test(evidenceFingerprint)) return null;
  if (!isNonEmptyString(recommendationPolicyVersion)) return null;

  const payload = buildCanonicalRecommendationPayload({
    studentId,
    caseType,
    family,
    recommendationType,
    focusLetters: normalizedFocusLetters,
    evidenceFingerprint,
    recommendationPolicyVersion,
  });

  return hashCanonicalPayload(payload);
}

module.exports = {
  PERSISTENT_DIFFICULTY_POLICY_VERSION,
  WORKSHEET_RECOMMENDATION_POLICY_VERSION,
  computePersistentEvidenceFingerprint,
  computeWorksheetRecommendationFingerprint,
};
