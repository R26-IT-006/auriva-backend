'use strict';

/**
 * auditLetterMotorBackfill.js — READ-ONLY.
 *
 * Feature 11B historical audit. Answers, per student and per mastered
 * reference letter, whether a letter_motor_mastery_evidence row can be
 * reconstructed ENTIRELY from records that already exist in the database.
 *
 * Why this is needed: the evidence hook in recordLetterCompletion() used to
 * be gated on `created === true` from LetterProgress.findOrCreate(). The
 * blocked branch also calls findOrCreate() (for its blocked_attempts
 * counter), so any letter a child failed at least once already had a row by
 * the time they passed — `created` was false at the session that actually
 * achieved mastery, and the freeze silently never ran. That gate is fixed
 * going forward; this audit scopes what can be recovered for the past.
 *
 * NOTHING is invented here. A letter is reported backfillable only when:
 *   - it is one of the 20 reference letters, AND
 *   - it has a LetterProgress row (it really was mastered), AND
 *   - a real non-collection session with passed = true exists for it, AND
 *   - that session's attempt_number = 3 row passes the SAME
 *     validateEvidenceEligibility() the live service uses (imported, not
 *     reimplemented, so this audit cannot drift from the rule it reports
 *     on), AND
 *   - that row carries a real created_at to serve as mastered_at.
 *
 * Every other letter is reported with the exact reason it cannot be
 * recovered, and is left alone.
 */

require('dotenv').config({ quiet: true });

const db = require('../src/models');
const { LetterAttempt, LetterProgress, LetterMotorMasteryEvidence, LetterMotorStateHistory, Student } = db;
const { isReferenceLetter, getReferenceLetterCount } = require('../src/config/letterMotorReferenceLetters');
const { MILESTONES } = require('../src/config/letterMotorMilestones');
const { validateEvidenceEligibility } = require('../src/services/letterMotorMasteryService');

function lookupKey(letter, caseType) {
  return `${letter}|${caseType}`;
}

/**
 * Locates the session that actually achieved mastery for one letter, and
 * decides whether it can produce an evidence row.
 *
 * The mastering session is the EARLIEST non-collection session whose rows
 * carry passed = true. recordLetterCompletion() only reaches its success
 * path (and only stamps passed = true) when bestScore >= threshold, so this
 * is the recorded pass event itself — not a reconstruction of one.
 *
 * @returns {{status: string, reason: string|null, row: Object|null}}
 */
async function classifyLetter({ studentId, letter, caseType }) {
  const rows = await LetterAttempt.findAll({
    where: { student_id: studentId, letter, case_type: caseType, collection_mode: false },
    order: [['created_at', 'ASC']],
  });

  if (rows.length === 0) {
    return { status: 'not_backfillable', reason: 'no_non_collection_attempts', row: null };
  }

  // Group into sessions, preserving first-seen (chronological) order.
  const sessions = new Map();
  for (const r of rows) {
    if (!sessions.has(r.session_key)) sessions.set(r.session_key, []);
    sessions.get(r.session_key).push(r);
  }

  const passingSessions = [...sessions.values()].filter(s => s.some(r => r.passed === true));
  if (passingSessions.length === 0) {
    // Mastered per LetterProgress, but no session carries passed = true —
    // e.g. a row created purely by the blocked branch's bookkeeping. Not
    // recoverable without inventing the pass event.
    return { status: 'not_backfillable', reason: 'no_passing_session_recorded', row: null };
  }

  const masteringSession = passingSessions[0];
  const attempt3 = masteringSession.find(r => r.attempt_number === 3);
  if (!attempt3) {
    return { status: 'not_backfillable', reason: 'mastering_session_has_no_attempt_3', row: null };
  }

  const eligibility = validateEvidenceEligibility(attempt3);
  if (!eligibility.valid) {
    return { status: 'not_backfillable', reason: eligibility.reason, row: null };
  }

  // mastered_at is NEVER invented: it is this exact attempt row's own
  // recorded created_at — the moment the mastering observation was captured.
  if (!attempt3.created_at) {
    return { status: 'not_backfillable', reason: 'no_historical_timestamp', row: null };
  }

  return { status: 'backfillable', reason: null, row: attempt3 };
}

/**
 * Full read-only audit. Returns a plain object so the backfill script can
 * consume exactly the same classification it reports.
 */
async function auditAll() {
  const students = await Student.findAll({
    attributes: ['sid', 'full_name'], raw: true, order: [['sid', 'ASC']],
  });
  const perStudent = [];

  for (const s of students) {
    const progress = await LetterProgress.findAll({
      where: { student_id: s.sid }, attributes: ['letter', 'case_type'], raw: true,
    });
    if (progress.length === 0) continue;

    const referenceMastered = progress.filter(p => isReferenceLetter(p.letter, p.case_type));

    const existingEvidence = await LetterMotorMasteryEvidence.findAll({
      where: { student_id: s.sid }, attributes: ['letter', 'case_type'], raw: true,
    });
    const existingKeys = new Set(existingEvidence.map(e => lookupKey(e.letter, e.case_type)));

    const historyCount = await LetterMotorStateHistory.count({ where: { student_id: s.sid } });

    const backfillable = [];
    const blocked = [];
    for (const p of referenceMastered) {
      // Already frozen — immutable, never re-examined or overwritten.
      if (existingKeys.has(lookupKey(p.letter, p.case_type))) continue;
      const verdict = await classifyLetter({ studentId: s.sid, letter: p.letter, caseType: p.case_type });
      if (verdict.status === 'backfillable') backfillable.push({ ...p, row: verdict.row });
      else blocked.push({ ...p, reason: verdict.reason });
    }

    // Milestone projection: which milestones the EXACT required pair sets
    // would be satisfied by, counting existing evidence plus what is
    // recoverable. Never "any N letters" — the named sets only.
    const projectedKeys = new Set([
      ...existingKeys,
      ...backfillable.map(b => lookupKey(b.letter, b.case_type)),
    ]);
    const milestoneProjection = MILESTONES.map(m => ({
      code: m.code,
      coverageN: m.coverageN,
      missing: m.requiredPairs
        .filter(p => !projectedKeys.has(lookupKey(p.letter, p.caseType)))
        .map(p => `${p.letter}/${p.caseType}`),
    }));

    perStudent.push({
      sid: s.sid,
      name: s.full_name,
      totalMastered: progress.length,
      referenceMastered: referenceMastered.length,
      existingEvidence: existingEvidence.length,
      historyRows: historyCount,
      backfillable,
      blocked,
      projectedEvidence: projectedKeys.size,
      milestoneProjection,
    });
  }

  return { perStudent, referenceLetterTotal: getReferenceLetterCount() };
}

function render({ perStudent, referenceLetterTotal }) {
  const lines = [];
  lines.push('FEATURE 11B HISTORICAL EVIDENCE AUDIT (read-only)');
  lines.push(`reference letter set size: ${referenceLetterTotal}`);
  lines.push('');

  let totalBackfillable = 0;
  let totalBlocked = 0;
  const blockedReasons = {};

  for (const s of perStudent) {
    lines.push(`-- sid=${s.sid} ${s.name}`);
    lines.push(`   mastered=${s.totalMastered}  reference mastered=${s.referenceMastered}/${referenceLetterTotal}  existing evidence=${s.existingEvidence}  history rows=${s.historyRows}`);
    lines.push(`   BACKFILLABLE: ${s.backfillable.length}  [${s.backfillable.map(b => b.letter + '/' + b.case_type).join(', ')}]`);
    if (s.blocked.length) {
      const byReason = {};
      s.blocked.forEach((b) => {
        (byReason[b.reason] = byReason[b.reason] || []).push(b.letter + '/' + b.case_type);
      });
      Object.entries(byReason).forEach(([reason, pairs]) => {
        lines.push(`   BLOCKED (${reason}): ${pairs.join(', ')}`);
        blockedReasons[reason] = (blockedReasons[reason] || 0) + pairs.length;
      });
    }
    const reachable = s.milestoneProjection.filter(m => m.missing.length === 0).map(m => m.code);
    lines.push(`   projected evidence after backfill: ${s.projectedEvidence}`);
    lines.push(`   milestones reachable after backfill: ${reachable.length ? reachable.join(', ') : 'NONE'}`);
    const first = s.milestoneProjection[0];
    if (first && first.missing.length) {
      lines.push(`   ${first.code} still missing ${first.missing.length}: ${first.missing.join(', ')}`);
    }
    lines.push('');
    totalBackfillable += s.backfillable.length;
    totalBlocked += s.blocked.length;
  }

  lines.push('-- TOTALS');
  lines.push(`   rows safely backfillable: ${totalBackfillable}`);
  lines.push(`   rows NOT backfillable:    ${totalBlocked}`);
  Object.entries(blockedReasons).sort((a, b) => b[1] - a[1])
    .forEach(([reason, n]) => lines.push(`     ${String(n).padStart(3)}  ${reason}`));
  return lines.join('\n');
}

module.exports = { auditAll, classifyLetter, render };

if (require.main === module) {
  db.sequelize.options.logging = false;
  auditAll()
    .then((r) => { console.log(render(r)); return db.sequelize.close(); })
    .catch((e) => {
      console.error('AUDIT FAILED:', e.message);
      return db.sequelize.close().then(() => process.exit(1));
    });
}
