'use strict';

/**
 * One-off backfill for concepts promoted by the adaptive quiz before
 * completeAdaptive started writing tier1_score alongside tier1_status.
 *
 * Those rows are stored as passed-at-a-failing-score (or passed-at-null, from the
 * findOrCreate path). Both are read as strength: activityService keeps such a
 * concept at the top of its weakest-first re-test queue and lets it drag activity
 * difficulty down, and the teacher screens show a failing percentage on a concept
 * the child passed.
 *
 * Raises those scores to exactly the pass bar — the same value completeAdaptive
 * now writes. Idempotent: a second run updates 0 rows.
 *
 * Usage:  npm run backfill:scores
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const { PASS_SCORE } = require('../services/conceptService');

async function backfill() {
  await sequelize.authenticate();
  console.log('Connected to database');

  const [before] = await sequelize.query(
    `SELECT COUNT(*) FILTER (WHERE tier1_score IS NULL)::int      AS null_score,
            COUNT(*) FILTER (WHERE tier1_score < :pass)::int      AS low_score
       FROM student_concept_progress
      WHERE tier1_status = 'passed'
        AND (tier1_score IS NULL OR tier1_score < :pass)`,
    { replacements: { pass: PASS_SCORE }, type: QueryTypes.SELECT },
  );

  console.log(
    `Found ${before.low_score} passed row(s) scored below the pass bar ` +
    `and ${before.null_score} with no score at all.`,
  );

  if (before.low_score === 0 && before.null_score === 0) {
    console.log('Nothing to do.');
    await sequelize.close();
    return;
  }

  const [, meta] = await sequelize.query(
    `UPDATE student_concept_progress
        SET tier1_score = :pass
      WHERE tier1_status = 'passed'
        AND (tier1_score IS NULL OR tier1_score < :pass)`,
    { replacements: { pass: PASS_SCORE } },
  );

  // Postgres returns the pg Result object as metadata; other dialects return a
  // bare affected-row count.
  const changed = typeof meta === 'number' ? meta : (meta?.rowCount ?? 0);

  console.log(`Updated ${changed} row(s) to ${PASS_SCORE.toFixed(3)}.`);
  await sequelize.close();
}

backfill().catch((err) => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
