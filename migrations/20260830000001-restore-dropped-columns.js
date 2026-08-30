'use strict';

// ─── Restore columns dropped from the SHARED database ──────────────────────
//
// Fourth of its kind — see restore-personal-thresholds-column (2026-08-09),
// restore-student-sensory-and-threshold-columns (2026-08-14),
// restore-reduce-stimulation-again (2026-08-16) and
// restore-reduce-stimulation-final (2026-08-21).
//
// Cause, every time: a machine booting with ALLOW_DB_SYNC=true on a branch
// whose models predate a column. sync({ alter: true }) drops what it does not
// recognise, and because every developer points at the SAME Azure database it
// drops it for the whole team. The original migrations are still recorded as
// `up` in SequelizeMeta, so `db:migrate` will not re-apply them — hence a new
// forward-only migration rather than editing migration history.
//
// Detected 2026-08-30 by comparing every Sequelize model's declared columns
// against information_schema. Five columns across three tables were missing;
// the app returned 500 on GET /api/teacher/students (Student Details) and
// GET /api/teacher/dashboard.
//
// Written to be re-runnable: every step checks for existence first, so running
// it against a healthy database is a no-op.

async function columnExists(queryInterface, table, column) {
  const described = await queryInterface.describeTable(table);
  return Object.prototype.hasOwnProperty.call(described, column);
}

const ACTIVITY_ENUM = 'enum_student_activities_activity_type';

module.exports = {
  async up(queryInterface, Sequelize) {
    // ── students.reduce_stimulation ──────────────────────────────────────
    if (!(await columnExists(queryInterface, 'students', 'reduce_stimulation'))) {
      await queryInterface.addColumn('students', 'reduce_stimulation', {
        type:         Sequelize.BOOLEAN,
        allowNull:    false,
        defaultValue: false,
      });
    }

    // ── student_concept_progress.tier2_* ─────────────────────────────────
    const TIER2 = {
      tier2_score:     { type: Sequelize.FLOAT,   allowNull: true },
      tier2_attempts:  { type: Sequelize.INTEGER, allowNull: true },
      tier2_passed_at: { type: Sequelize.DATE,    allowNull: true },
    };
    for (const [name, spec] of Object.entries(TIER2)) {
      if (!(await columnExists(queryInterface, 'student_concept_progress', name))) {
        await queryInterface.addColumn('student_concept_progress', name, spec);
      }
    }

    // The dropped column took its data with it. Rebuild from the interaction
    // log, exactly as 20260826000005-add-tier2-score-columns.js does — the log
    // is append-only, so this reconstructs what was lost rather than guessing.
    // COALESCE throughout: never overwrite a value that is already there.
    await queryInterface.sequelize.query(`
      WITH latest AS (
        SELECT DISTINCT ON (student_id, category_key, concept_key)
               student_id, category_key, concept_key,
               (event_data->>'score')::float          AS score,
               (event_data->>'attempt_count')::int    AS attempts,
               created_at
          FROM concept_interaction_logs
         WHERE event_type = 'tier2_pass'
           AND jsonb_typeof(event_data->'score') = 'number'
         ORDER BY student_id, category_key, concept_key, created_at DESC
      )
      UPDATE student_concept_progress p
         SET tier2_score     = COALESCE(p.tier2_score, latest.score),
             tier2_attempts  = COALESCE(p.tier2_attempts, latest.attempts),
             tier2_passed_at = COALESCE(p.tier2_passed_at, latest.created_at)
        FROM latest
       WHERE p.student_id   = latest.student_id
         AND p.category_key = latest.category_key
         AND p.concept_key  = latest.concept_key
         AND p.tier2_status = 'passed'
    `);

    // Failed attempts carry a score too, and it is the only record of how close
    // the child got. Score and attempt count only — a failure has no pass
    // timestamp, and inventing one would corrupt the mastery-recency sort.
    await queryInterface.sequelize.query(`
      WITH latest AS (
        SELECT DISTINCT ON (student_id, category_key, concept_key)
               student_id, category_key, concept_key,
               (event_data->>'score')::float       AS score,
               (event_data->>'attempt_count')::int AS attempts
          FROM concept_interaction_logs
         WHERE event_type = 'tier2_fail'
           AND jsonb_typeof(event_data->'score') = 'number'
         ORDER BY student_id, category_key, concept_key, created_at DESC
      )
      UPDATE student_concept_progress p
         SET tier2_score    = COALESCE(p.tier2_score, latest.score),
             tier2_attempts = COALESCE(p.tier2_attempts, latest.attempts)
        FROM latest
       WHERE p.student_id   = latest.student_id
         AND p.category_key = latest.category_key
         AND p.concept_key  = latest.concept_key
         AND p.tier2_status <> 'passed'
    `);

    // ── student_activities.activity_type ─────────────────────────────────
    // DROP COLUMN does NOT drop the enum type, so it is still there from
    // 20260824000002. addColumn(Sequelize.ENUM(...)) would emit CREATE TYPE and
    // fail with "type already exists" — so reuse the surviving type by name.
    if (!(await columnExists(queryInterface, 'student_activities', 'activity_type'))) {
      const [types] = await queryInterface.sequelize.query(
        `SELECT 1 FROM pg_type WHERE typname = '${ACTIVITY_ENUM}'`,
      );
      if (types.length) {
        await queryInterface.sequelize.query(
          `ALTER TABLE student_activities
             ADD COLUMN activity_type ${ACTIVITY_ENUM} NOT NULL DEFAULT 'practice'`,
        );
      } else {
        await queryInterface.addColumn('student_activities', 'activity_type', {
          type:         Sequelize.ENUM('practice', 'pair_match', 'memory'),
          allowNull:    false,
          defaultValue: 'practice',
        });
      }
    }

    // Index the original migration created alongside the column; it is dropped
    // with the column, so recreate it when absent.
    const INDEX = 'student_activities_student_id_category_key_activity_type';
    const indexes = await queryInterface.showIndex('student_activities');
    if (!indexes.some((i) => i.name === INDEX)) {
      await queryInterface.addIndex(
        'student_activities',
        ['student_id', 'category_key', 'activity_type'],
        { name: INDEX },
      );
    }
  },

  // Deliberately a no-op. Every column here is one the models already require;
  // removing them again is precisely the failure this migration exists to
  // repair, so `down` must not re-break the application. Roll back by
  // restoring from a database backup, not by running this in reverse.
  async down() {
    /* intentionally empty — see note above */
  },
};
