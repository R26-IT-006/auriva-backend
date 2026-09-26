'use strict';

// Homework practice worksheets — turning an APPROVED adaptive practice
// recommendation into a printable, personalised handwriting worksheet, and
// later accepting the completed paper back as a scan for teacher review.
//
// ── What a worksheet is, and is not ────────────────────────────────────────
// It is teacher-directed SUPPORT MATERIAL. It is never a mastery decision.
// Nothing in these two tables feeds LetterProgress, mastered_at, Motor Score,
// thresholds, the 5-attempt evidence window, adaptive sequencing, the Letter
// Motor Pattern, or word unlock. A teacher's review of a returned worksheet is
// a note about paper practice, not a progression event.
//
// ── Why two tables ─────────────────────────────────────────────────────────
// A worksheet is assigned once; it can be submitted more than once (a photo
// retaken, a second attempt at home). Keeping submissions separate means a
// re-submission never overwrites the assignment record or its history.
//
// No FK constraints — same no-FK convention as every other table in this schema.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('handwriting_worksheets', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },

      student_id: { type: Sequelize.INTEGER, allowNull: false },

      // Human-facing code printed on the sheet (e.g. 'HW-2026-0042') so a
      // returned paper can be matched to its record without exposing any
      // internal database id on a document that leaves the building.
      worksheet_code: { type: Sequelize.STRING(24), allowNull: false },

      // Provenance: the Feature 8 recommendation this worksheet came from.
      // Stored as the opaque recommendationFingerprint the teacher's client
      // already echoes back when validating, plus the stream it belonged to.
      recommendation_fingerprint: { type: Sequelize.STRING(128), allowNull: true },
      case_type: { type: Sequelize.STRING(10), allowNull: false },
      motor_family: { type: Sequelize.STRING(16), allowNull: true },

      // The single letter this worksheet is built around. The teacher may
      // override the system's suggestion, so this is what was ACTUALLY chosen.
      target_letter: { type: Sequelize.CHAR(1), allowNull: false },

      // 'standard' | 'extended'. Neutral support levels, never a clinical
      // difficulty grade — 'extended' simply repeats the same warm-up rows.
      worksheet_intensity: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'standard' },

      // 'generated' | 'assigned' | 'submitted' | 'reviewed' | 'archived'
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'generated' },

      teacher_note: { type: Sequelize.TEXT, allowNull: true },

      generated_at: { type: Sequelize.DATE, allowNull: false },
      assigned_at:  { type: Sequelize.DATE, allowNull: true },
      due_date:     { type: Sequelize.DATE, allowNull: true },
      completed_at: { type: Sequelize.DATE, allowNull: true },

      // Where the rendered PDF lives, if one was stored. The PDF itself is
      // produced on the device and kept in blob storage — never as a database
      // blob, matching this project's existing photo-upload convention.
      worksheet_file_url: { type: Sequelize.STRING(512), allowNull: true },

      created_at: { type: Sequelize.DATE, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, defaultValue: Sequelize.fn('NOW') },
    });

    await queryInterface.addIndex('handwriting_worksheets', ['worksheet_code'], {
      name: 'handwriting_worksheets_code_uniq', unique: true,
    });
    await queryInterface.addIndex('handwriting_worksheets', ['student_id', 'generated_at'], {
      name: 'handwriting_worksheets_student_generated_idx',
    });

    // Duplicate control. At most ONE live worksheet per (student, letter, case)
    // at a time, so a recommendation that keeps re-appearing cannot silently
    // pile up identical homework. A partial index rather than application logic
    // alone, so the guarantee survives a concurrent double-tap.
    await queryInterface.addIndex(
      'handwriting_worksheets',
      ['student_id', 'target_letter', 'case_type'],
      {
        name: 'handwriting_worksheets_active_uniq',
        unique: true,
        where: { status: { [Sequelize.Op.in]: ['generated', 'assigned', 'submitted'] } },
      }
    );

    await queryInterface.createTable('handwriting_worksheet_submissions', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },

      worksheet_id: { type: Sequelize.INTEGER, allowNull: false },
      student_id:   { type: Sequelize.INTEGER, allowNull: false },

      submitted_at: { type: Sequelize.DATE, allowNull: false },

      // Blob URL of the returned paper — a photo or a scan.
      file_reference:  { type: Sequelize.STRING(512), allowNull: false },
      submission_type: { type: Sequelize.STRING(16),  allowNull: false }, // 'photo' | 'scan'

      // 'pending_review' | 'reviewed' | 'needs_more_practice'
      //
      // Deliberately NO 'failed'. A returned worksheet is practice evidence a
      // teacher reads, not something a child passes.
      review_status:   { type: Sequelize.STRING(24), allowNull: false, defaultValue: 'pending_review' },
      teacher_comment: { type: Sequelize.TEXT, allowNull: true },
      reviewed_at:     { type: Sequelize.DATE, allowNull: true },

      // ── Future capability, deliberately inert ────────────────────────────
      // Reserved so an OPTIONAL, separately-validated image analysis could be
      // added later without a second migration. NOTHING writes these today,
      // and no automatic scoring of handwriting from a scan exists anywhere in
      // this system. A future analysis would be advisory only and would still
      // require the teacher's own review to stand.
      analysis_status: { type: Sequelize.STRING(24),  allowNull: true },
      analysis_result: { type: Sequelize.JSONB,       allowNull: true },
      analysis_model_version: { type: Sequelize.STRING(40), allowNull: true },

      created_at: { type: Sequelize.DATE, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, defaultValue: Sequelize.fn('NOW') },
    });

    await queryInterface.addIndex('handwriting_worksheet_submissions', ['worksheet_id', 'submitted_at'], {
      name: 'handwriting_worksheet_submissions_worksheet_idx',
    });
    await queryInterface.addIndex('handwriting_worksheet_submissions', ['student_id', 'submitted_at'], {
      name: 'handwriting_worksheet_submissions_student_idx',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('handwriting_worksheet_submissions');
    await queryInterface.dropTable('handwriting_worksheets');
  },
};
