'use strict';

// Tier 2 records only a status and a retry count, while tier 1 records a score,
// an attempt count and a pass timestamp. completeTier2 already receives score and
// attemptCount — it writes them to the interaction log and drops them here.
//
// Three things downstream read tier-1 numbers because tier-2 numbers do not
// exist, and all three are in the adaptive path:
//   - selectConcepts ranks re-test candidates on tier1_score
//   - difficultyFor derives conceptStrength from tier1_score
//   - selectConcepts sorts "oldest mastery first" on tier1_passed_at, although
//     mastery requires tier 1 AND tier 2, so it sorts on a timestamp that
//     precedes the event it claims to measure
//
// Idempotent — safe to re-run.
const TABLE = 'student_concept_progress';

const COLUMNS = {
  tier2_score:     (S) => ({ type: S.FLOAT,   allowNull: true }),
  tier2_attempts:  (S) => ({ type: S.INTEGER, allowNull: true }),
  tier2_passed_at: (S) => ({ type: S.DATE,    allowNull: true }),
};

async function has(queryInterface, column) {
  const described = await queryInterface.describeTable(TABLE);
  return Object.prototype.hasOwnProperty.call(described, column);
}

module.exports = {
  async up(queryInterface, Sequelize) {
    for (const [name, spec] of Object.entries(COLUMNS)) {
      if (!(await has(queryInterface, name))) {
        await queryInterface.addColumn(TABLE, name, spec(Sequelize));
      }
    }

    // Backfill from the event log, which has carried these values all along.
    // DISTINCT ON takes the most recent tier2_pass per (student, concept): a
    // concept can be re-tested, and the latest pass is the one that describes
    // the current state of the progress row.
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
      UPDATE ${TABLE} p
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
    // the child got. Only the score and attempt count — a failure has no pass
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
      UPDATE ${TABLE} p
         SET tier2_score    = COALESCE(p.tier2_score, latest.score),
             tier2_attempts = COALESCE(p.tier2_attempts, latest.attempts)
        FROM latest
       WHERE p.student_id   = latest.student_id
         AND p.category_key = latest.category_key
         AND p.concept_key  = latest.concept_key
         AND p.tier2_status <> 'passed'
    `);
  },

  async down(queryInterface) {
    for (const name of Object.keys(COLUMNS)) {
      if (await has(queryInterface, name)) {
        await queryInterface.removeColumn(TABLE, name);
      }
    }
  },
};
