'use strict';

/**
 * backfillLetterProgressMastery.js
 *
 * Populates the new letter_progress.mastered_at column from evidence that
 * already exists in letter_attempts. Recovery ONLY — this script cannot
 * create mastery, only recognise it where the data already proves it.
 *
 * ── Why a backfill is needed ───────────────────────────────────────────────
 * Before the mastery-semantics correction, a letter_progress row was created
 * by BOTH the pass and the fail branch of recordLetterCompletion(), so row
 * existence meant "practised", not "mastered". mastered_at now carries that
 * distinction, and existing rows have it NULL. Without this script every
 * historical letter would read as unmastered.
 *
 * ── What counts as proof of mastery ────────────────────────────────────────
 * Exactly what the live success path requires: a recorded PASSING,
 * normal-learning session for this (student, letter, case_type):
 *
 *     letter_attempts.passed = true
 *       AND collection_mode = false     — a research-protocol capture never
 *                                          went through the mastery path
 *       AND source_type IS NULL         — reassessment rows likewise
 *
 * The EARLIEST such session is used, because mastery happens once and every
 * later pass is re-practice. Within that session the attempt_number = 3 row's
 * created_at is preferred — the same anchor onLetterMastered() and
 * backfillLetterMotorEvidence.js already use — falling back to the session's
 * last recorded attempt when no attempt-3 row exists.
 *
 * ── What is deliberately NOT used ──────────────────────────────────────────
 * letter_progress.completed_at. It is stamped at row CREATION, which the
 * failure branch also performs, so on a row born from a failure it records the
 * failure. The live audit found 19 rows where it precedes the real passing
 * session by 17 to 95 days — using it would backdate mastery into the wrong
 * reporting period and would mark never-passed letters as mastered, which is
 * the exact bug being fixed.
 *
 * A row with no qualifying passing session is REPORTED and left NULL. It is
 * never approximated from completed_at, from a neighbouring letter, or from
 * the existence of any attempt.
 *
 * ── Safety ─────────────────────────────────────────────────────────────────
 *   - Dry-run by default. Writing requires an explicit --commit flag.
 *   - Idempotent: only rows with mastered_at IS NULL are ever considered, so a
 *     second run writes nothing and an already-stamped row is never rewritten.
 *   - Writes exactly ONE column of ONE table: letter_progress.mastered_at.
 *     letter_attempts is opened read-only; completed_at, blocked_attempts,
 *     attempt_data, progression_score_version and every other column are not
 *     touched.
 *   - Cannot change a pass/fail outcome, a threshold, a Motor Score, an
 *     adaptive decision or any model input — it reads outcomes that were
 *     already decided and recorded.
 */

require('dotenv').config({ quiet: true });

const { Op } = require('sequelize');
const db = require('../src/models');
const { LetterProgress, LetterAttempt } = db;

/**
 * Finds the defensible mastery instant for one letter, or null.
 *
 * Pure read. Returns the evidence alongside the timestamp so a dry run can be
 * reviewed row by row rather than trusted.
 *
 * @returns {Promise<{masteredAt: Date, sessionKey: string, source: string}|null>}
 */
async function deriveMasteryEvent({ studentId, letter, caseType }) {
  const passingRows = await LetterAttempt.findAll({
    where: {
      student_id: studentId,
      letter,
      case_type: caseType,
      passed: true,
      collection_mode: false,
      source_type: null,
    },
    attributes: ['session_key', 'attempt_number', 'created_at'],
    order: [['created_at', 'ASC'], ['id', 'ASC']],
    raw: true,
  });
  if (passingRows.length === 0) return null;

  // The earliest passing session — mastery happens once; later passes are
  // re-practice and must not move the timestamp.
  const earliestSessionKey = passingRows[0].session_key;
  const session = passingRows.filter(r => r.session_key === earliestSessionKey);

  const attempt3 = session.find(r => r.attempt_number === 3);
  if (attempt3) {
    return { masteredAt: attempt3.created_at, sessionKey: earliestSessionKey, source: 'attempt_3' };
  }
  const last = session[session.length - 1];
  return { masteredAt: last.created_at, sessionKey: earliestSessionKey, source: 'session_end' };
}

/**
 * @param {Object} params
 * @param {boolean} params.commit — false (default) performs no writes.
 */
async function backfillMastery({ commit = false } = {}) {
  // Only NULL rows are candidates — this is what makes the script idempotent
  // and what guarantees an existing mastery timestamp is never rewritten.
  const rows = await LetterProgress.findAll({
    where: { mastered_at: null },
    attributes: ['id', 'student_id', 'letter', 'case_type', 'blocked_attempts', 'completed_at'],
    order: [['student_id', 'ASC'], ['case_type', 'ASC'], ['letter', 'ASC']],
    raw: true,
  });

  const results = [];
  let mastered = 0;
  let leftNull = 0;

  for (const row of rows) {
    const event = await deriveMasteryEvent({
      studentId: row.student_id, letter: row.letter, caseType: row.case_type,
    });

    if (!event) {
      results.push({
        ...row, action: 'left_null', reason: 'no_passing_session_recorded',
        masteredAt: null, sessionKey: null, source: null,
      });
      leftNull += 1;
      continue;
    }

    if (commit) {
      // Re-checks mastered_at IS NULL in the WHERE clause, so a concurrent
      // live mastery that landed between the read above and this write is
      // never overwritten.
      await LetterProgress.update(
        { mastered_at: event.masteredAt },
        { where: { id: row.id, mastered_at: null } },
      );
    }
    results.push({
      ...row, action: commit ? 'mastered' : 'would_master',
      masteredAt: event.masteredAt, sessionKey: event.sessionKey, source: event.source,
    });
    mastered += 1;
  }

  return { results, totals: { candidates: rows.length, mastered, leftNull }, commit };
}

function render({ results, totals, commit }) {
  const lines = [];
  lines.push(commit
    ? 'LETTER PROGRESS MASTERY BACKFILL — COMMITTED'
    : 'LETTER PROGRESS MASTERY BACKFILL — DRY RUN (no writes)');
  lines.push('');

  for (const r of results) {
    const label = `sid=${String(r.student_id).padEnd(3)} ${r.letter}/${r.case_type.padEnd(9)}`;
    if (r.action === 'left_null') {
      lines.push(`   LEFT NULL     ${label} reason=${r.reason} blocked_attempts=${r.blocked_attempts}`);
    } else {
      const drift = ((new Date(r.masteredAt) - new Date(r.completed_at)) / 86400000).toFixed(2);
      lines.push(
        `   ${r.action === 'mastered' ? 'MASTERED  ' : 'WOULD MASTER'}  ${label} ` +
        `mastered_at=${new Date(r.masteredAt).toISOString()} (${r.source}) ` +
        `completed_at drift=${drift}d`
      );
    }
  }

  lines.push('');
  lines.push('-- TOTALS');
  lines.push(`   candidate rows (mastered_at was NULL): ${totals.candidates}`);
  lines.push(`   provably mastered:                     ${totals.mastered}`);
  lines.push(`   left NULL (no passing session):        ${totals.leftNull}`);
  lines.push('');
  lines.push(commit ? 'Done.' : 'Re-run with --commit to write these values.');
  return lines.join('\n');
}

async function main() {
  const commit = process.argv.includes('--commit');
  const outcome = await backfillMastery({ commit });
  console.log(render(outcome));
  await db.sequelize.close();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Mastery backfill failed:', err.message);
    process.exit(1);
  });
}

module.exports = { backfillMastery, deriveMasteryEvent, render };
