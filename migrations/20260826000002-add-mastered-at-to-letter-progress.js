'use strict';

// Mastery-semantics correction.
//
// ── The bug this fixes ─────────────────────────────────────────────────────
// recordLetterCompletion()'s FAILURE branch calls LetterProgress.findOrCreate()
// purely to keep its blocked_attempts counter. That creates a row — with
// completed_at defaulting to NOW — for a letter the child did NOT master.
// Every mastery reader then treated row existence as mastery:
//
//   - getMasteredLetterPairs() fed the frontend resume/skip filter, so a
//     failed letter was removed from the child's practice sequence and never
//     presented again;
//   - the periodic report counted it as a mastered letter;
//   - the word-unlock progress counts included it.
//
// Live audit: 5 of 41 letter_progress rows have no passing session anywhere in
// letter_attempts (sid 5 'o'; sid 10 'C','g','n'; sid 39 'i').
//
// ── Why a new column rather than reusing completed_at ─────────────────────
// completed_at cannot be repaired in place: on a row created by a failure it
// records the FAILURE instant. The same live audit found 19 rows where
// completed_at precedes the real passing session by 17 to 95 days. It is kept
// untouched (this migration neither reads nor writes it) so no existing
// behaviour or historical value changes; mastered_at is added alongside it.
//
// ── Semantics ──────────────────────────────────────────────────────────────
//   mastered_at IS NOT NULL  ->  this letter is MASTERED, at that instant
//   mastered_at IS NULL      ->  practice/blocked history only, NOT mastered
//   row existence            ->  means nothing about mastery either way
//
// Nullable with no default and no backfill here: this migration only adds the
// column. Populating it from provable historical passing sessions is a
// separate, dry-run-by-default script (scripts/backfillLetterProgressMastery.js)
// so the derivation is reviewable before it writes, and can never run as an
// invisible side effect of a deploy.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('letter_progress', 'mastered_at', {
      type:      Sequelize.DATE,
      allowNull: true,
    });

    // Mastery reads are "every mastered pair for this student".
    await queryInterface.addIndex(
      'letter_progress',
      ['student_id', 'mastered_at'],
      { name: 'letter_progress_student_mastered_idx' }
    );
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('letter_progress', 'letter_progress_student_mastered_idx');
    await queryInterface.removeColumn('letter_progress', 'mastered_at');
  },
};
