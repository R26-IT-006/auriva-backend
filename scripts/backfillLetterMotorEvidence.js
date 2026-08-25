'use strict';

/**
 * backfillLetterMotorEvidence.js
 *
 * Recovers letter_motor_mastery_evidence rows that the fixed evidence hook
 * would have frozen at the time, had it not been suppressed by the
 * `created === true` gate (see scripts/auditLetterMotorBackfill.js for the
 * root cause). Recovery ONLY — every value written here is copied verbatim
 * out of a LetterAttempt row that already exists.
 *
 * ── What is and is not invented ────────────────────────────────────────────
 * Nothing is invented. Each row is built from the attempt_number = 3 row of
 * the session that actually passed:
 *
 *   smoothness_score / dtw_distance / speed_cv
 *       copied from that row's normalized_features, unchanged.
 *   support_level / feature_version / template_version / normalization_version
 *       copied from that row's own columns, unchanged.
 *   letter_attempt_id
 *       that row's real primary key, so every recovered row stays traceable
 *       to the exact observation it came from.
 *   mastered_at
 *       that row's own created_at. onLetterMastered() stamps `new Date()`
 *       because it runs inside the mastering request; the historical
 *       equivalent of that instant is when the mastering observation was
 *       actually captured. It is an existing recorded timestamp, not a
 *       reconstruction — and never `Date.now()`, which would claim the
 *       child wrote today.
 *
 * A letter with no eligible attempt-3 row, or no recorded passing session,
 * is REPORTED and SKIPPED. It is never approximated from a neighbouring
 * session, a later re-practice, or a default support_level.
 *
 * ── Safety ─────────────────────────────────────────────────────────────────
 *   - Dry-run by default. Writing requires an explicit --commit flag.
 *   - Idempotent: an existing (student, letter, case) evidence row is never
 *     touched, and the table's own unique key is honoured as the final
 *     authority (a unique-violation is counted as already-present, not an
 *     error), so a second run creates nothing.
 *   - Writes to exactly ONE table: letter_motor_mastery_evidence.
 *     LetterProgress, LetterAttempt, thresholds, Motor Score, adaptive
 *     sequencing and every child-facing decision are neither read for
 *     writing nor modified.
 *   - Milestone/state history is produced by calling the NORMAL
 *     checkAndTriggerMilestones() service — the same code path a live
 *     mastery uses — so the reference-range guard, the frozen model and the
 *     real state_code all apply. This script never writes a pattern label,
 *     never forces Pattern A/B, and never bypasses the guard.
 */

require('dotenv').config({ quiet: true });

const db = require('../src/models');
const { LetterMotorMasteryEvidence } = db;
const { classifyLetter } = require('./auditLetterMotorBackfill');
const { isReferenceLetter } = require('../src/config/letterMotorReferenceLetters');
const { checkAndTriggerMilestones } = require('../src/services/letterMotorMasteryService');

/**
 * Builds the evidence payload for one approved attempt row. Pure — every
 * field is a direct copy, so this function cannot introduce a derived or
 * defaulted value.
 */
function buildEvidencePayload({ studentId, letter, caseType, row }) {
  return {
    student_id: studentId,
    letter,
    case_type: caseType,
    letter_attempt_id: row.id,
    mastered_at: row.created_at,
    smoothness_score: row.normalized_features.smoothness_score,
    dtw_distance: row.normalized_features.dtw_distance,
    speed_cv: row.normalized_features.speed_cv,
    support_level: row.support_level,
    feature_version: row.feature_version,
    template_version: row.template_version,
    normalization_version: row.normalization_version,
  };
}

/**
 * @param {Object} params
 * @param {boolean} params.commit — false (default) performs no writes.
 * @returns {Promise<Object>} per-student results plus totals.
 */
async function backfill({ commit = false } = {}) {
  const { Student, LetterProgress } = db;
  const students = await Student.findAll({
    attributes: ['sid', 'full_name'], raw: true, order: [['sid', 'ASC']],
  });

  const results = [];
  let created = 0;
  let skippedExisting = 0;
  let blocked = 0;

  for (const s of students) {
    const progress = await LetterProgress.findAll({
      where: { student_id: s.sid }, attributes: ['letter', 'case_type'], raw: true,
    });
    const referenceMastered = progress.filter(p => isReferenceLetter(p.letter, p.case_type));
    if (referenceMastered.length === 0) continue;

    const perLetter = [];
    for (const p of referenceMastered) {
      const existing = await LetterMotorMasteryEvidence.findOne({
        where: { student_id: s.sid, letter: p.letter, case_type: p.case_type },
      });
      if (existing) {
        // Immutable — never re-derived, never overwritten (spec §11).
        perLetter.push({ letter: p.letter, caseType: p.case_type, action: 'already_present' });
        skippedExisting += 1;
        continue;
      }

      const verdict = await classifyLetter({ studentId: s.sid, letter: p.letter, caseType: p.case_type });
      if (verdict.status !== 'backfillable') {
        perLetter.push({ letter: p.letter, caseType: p.case_type, action: 'blocked', reason: verdict.reason });
        blocked += 1;
        continue;
      }

      const payload = buildEvidencePayload({
        studentId: s.sid, letter: p.letter, caseType: p.case_type, row: verdict.row,
      });

      if (!commit) {
        perLetter.push({
          letter: p.letter, caseType: p.case_type, action: 'would_create',
          masteredAt: payload.mastered_at, letterAttemptId: payload.letter_attempt_id,
        });
        created += 1;
        continue;
      }

      try {
        await LetterMotorMasteryEvidence.create(payload);
        perLetter.push({
          letter: p.letter, caseType: p.case_type, action: 'created',
          masteredAt: payload.mastered_at, letterAttemptId: payload.letter_attempt_id,
        });
        created += 1;
      } catch (err) {
        if (err.name === 'SequelizeUniqueConstraintError') {
          // The table's unique key is the final authority on idempotency —
          // a concurrent writer got there first, which is a no-op, not a
          // failure.
          perLetter.push({ letter: p.letter, caseType: p.case_type, action: 'already_present' });
          skippedExisting += 1;
          continue;
        }
        throw err;
      }
    }

    // Milestones are evaluated ONLY through the normal service, and only
    // when this run actually added evidence. It is idempotent in its own
    // right (an already-recorded milestone is never re-predicted) and
    // returns 'not_yet_eligible' unless a milestone's exact required pair
    // set is now complete — so a student below the first milestone gets no
    // history row and no model call at all.
    let milestoneResults = null;
    if (commit && perLetter.some(l => l.action === 'created')) {
      milestoneResults = await checkAndTriggerMilestones({ studentId: s.sid });
    }

    results.push({ sid: s.sid, name: s.full_name, perLetter, milestoneResults });
  }

  return { results, totals: { created, skippedExisting, blocked }, commit };
}

function render({ results, totals, commit }) {
  const lines = [];
  lines.push(commit
    ? 'LETTER MOTOR EVIDENCE BACKFILL — COMMITTED'
    : 'LETTER MOTOR EVIDENCE BACKFILL — DRY RUN (no writes)');
  lines.push('');

  for (const s of results) {
    const actionable = s.perLetter.filter(l => l.action === 'created' || l.action === 'would_create');
    if (actionable.length === 0 && !s.perLetter.some(l => l.action === 'blocked')) continue;
    lines.push(`-- sid=${s.sid} ${s.name}`);
    for (const l of s.perLetter) {
      if (l.action === 'created' || l.action === 'would_create') {
        lines.push(`   ${l.action.toUpperCase().padEnd(13)} ${l.letter}/${l.caseType}  mastered_at=${new Date(l.masteredAt).toISOString()}  from letter_attempt id=${l.letterAttemptId}`);
      } else if (l.action === 'blocked') {
        lines.push(`   BLOCKED       ${l.letter}/${l.caseType}  reason=${l.reason}`);
      } else {
        lines.push(`   ALREADY       ${l.letter}/${l.caseType}`);
      }
    }
    if (s.milestoneResults) {
      s.milestoneResults.forEach((m) => {
        const extra = m.missingCount != null ? ` (missing ${m.missingCount})` : '';
        lines.push(`   milestone ${m.milestone}: ${m.status}${extra}`);
      });
    }
    lines.push('');
  }

  lines.push('-- TOTALS');
  lines.push(`   evidence rows ${commit ? 'created' : 'that would be created'}: ${totals.created}`);
  lines.push(`   already present (untouched):              ${totals.skippedExisting}`);
  lines.push(`   blocked (left alone):                     ${totals.blocked}`);
  return lines.join('\n');
}

module.exports = { backfill, buildEvidencePayload, render };

if (require.main === module) {
  const commit = process.argv.includes('--commit');
  db.sequelize.options.logging = false;
  backfill({ commit })
    .then((r) => {
      console.log(render(r));
      if (!commit) console.log('\nRe-run with --commit to write these rows.');
      return db.sequelize.close();
    })
    .catch((e) => {
      console.error('BACKFILL FAILED:', e.message);
      return db.sequelize.close().then(() => process.exit(1));
    });
}
