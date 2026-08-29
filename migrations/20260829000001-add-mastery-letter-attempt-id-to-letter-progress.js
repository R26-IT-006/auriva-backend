'use strict';

/**
 * The attempt that actually established mastery.
 *
 * ── What was missing ─────────────────────────────────────────────────────
 * LetterProgress records THAT a letter was mastered (`mastered_at`) but never
 * WHICH attempt did it. LetterAttempt holds every attempt's stroke_points, so
 * the drawing exists — there was simply no durable link between the mastery
 * event and the row that caused it.
 *
 * That gap is why the teacher report's Letter Details could only say "No
 * writing evidence available yet": picking a letter's best or latest attempt
 * would have been a guess presented as fact, and under the current policy
 * mastery is established by Attempt 3 alone.
 *
 * letter_motor_mastery_evidence.letter_attempt_id already does exactly this,
 * but only for the 20 Feature 11B reference letters. This column is the same
 * link for the other 32.
 *
 * ── Never backfilled ─────────────────────────────────────────────────────
 * Deliberately nullable, and no UPDATE runs here. For a letter mastered
 * before this column existed, the mastering attempt cannot be identified from
 * stored data: LetterProgress has no session_key, and `attempt_data` is a
 * latest-attempt convenience field that later sessions overwrite. Choosing a
 * row by score or recency would fabricate the attribution this column exists
 * to make honest, so historical rows stay NULL and the UI says so.
 *
 * Same no-backfill policy as support_level, demo_speed_level and
 * progression_score_version — see their column comments.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('letter_progress', 'mastery_letter_attempt_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('letter_progress', 'mastery_letter_attempt_id');
  },
};
