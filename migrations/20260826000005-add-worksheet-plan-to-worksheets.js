'use strict';

// Freezes the motor-preparation plan a worksheet was ACTUALLY generated from.
//
// ── Why ────────────────────────────────────────────────────────────────────
// A worksheet is a physical artefact: it is printed, taken home, written on,
// photographed and reviewed. Reprinting HW-2026-0001 next term must reproduce
// the sheet the child was given, not whatever the current mapping would
// produce today.
//
// Without this column, a reprint re-derived its warm-up shapes from the LIVE
// worksheetMotorMap. That is a correctness problem the moment the mapping is
// ever corrected (it already was once, when a drift test found eight
// mis-transcribed letters) — the same worksheet code would then print two
// different pages, and a teacher reviewing returned work would be comparing it
// against a sheet that no longer exists.
//
// Storing the STRUCTURED plan, not rendered HTML: the plan is small, readable,
// diffable and enough to re-render the page. Rendered markup would freeze the
// layout too, which we do want to be able to improve.
//
// Nullable by design — worksheets created before this change keep NULL, and the
// renderer falls back honestly rather than fabricating a plan for them.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('handwriting_worksheets', 'worksheet_plan', {
      type:      Sequelize.JSONB,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('handwriting_worksheets', 'worksheet_plan');
  },
};
