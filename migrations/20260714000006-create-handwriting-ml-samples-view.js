'use strict';

// handwriting_ml_samples is a plain SQL VIEW (not a materialized/physical
// table): it's always in sync with shape_features/letter_attempts with no
// dual-write or staleness risk, and is safe to treat as read-only for
// export. Revisit as a materialized view only if row counts grow large
// enough that view performance becomes a real problem.
//
// sample_id is prefixed per source table because shape_features.id and
// letter_attempts.id are independent autoincrement sequences and would
// otherwise collide across the UNION ALL.
//
// teacher_label / teacher_feedback are derived, not stored directly:
// teacher_label maps teacher_overall_rating (1/2/3) to weak/moderate/good;
// teacher_feedback is an alias for teacher_notes. This mapping is applied
// here, in one place, rather than duplicated by every consumer.
//
// Every text-ish column that's UNION'd is explicitly cast to ::text on both
// branches. This isn't cosmetic: case_type and capture_status are declared
// as DataTypes.ENUM(...) on the Sequelize models, and sequelize.sync({
// alter: true }) (run on every server boot) materializes those as native
// Postgres enum types (e.g. enum_letter_attempts_case_type) — Postgres
// cannot UNION a native enum column against a plain varchar/NULL literal on
// the other branch. Casting both sides to ::text sidesteps the enum
// entirely and is safe regardless of whether a given deployment's columns
// ended up as varchar (from the original migrations) or enum (from sync).
const CREATE_VIEW_SQL = `
CREATE OR REPLACE VIEW handwriting_ml_samples AS
SELECT
  'shape:' || sf.id                                     AS sample_id,
  sf.student_id,
  sf.collection_session_id,
  'shape'::text                                          AS sample_type,
  sf.shape_type::text                                    AS activity_name,
  NULL::text                                             AS letter,
  NULL::text                                              AS case_type,
  sf.attempt_number,
  sf.task_order,
  sf.collection_mode,
  sf.capture_status::text                                 AS capture_status,
  sf.feature_version::text                                AS feature_version,
  sf.template_version::text                               AS template_version,
  (sf.normalized_features ->> 'duration_ms')::float      AS duration_ms,
  (sf.normalized_features ->> 'total_distance')::float   AS total_distance,
  (sf.normalized_features ->> 'avg_speed')::float         AS avg_speed,
  (sf.normalized_features ->> 'smoothness_score')::float  AS smoothness_score,
  (sf.normalized_features ->> 'pause_count')::float       AS pause_count,
  (sf.normalized_features ->> 'accuracy_score')::float    AS accuracy_score,
  (sf.normalized_features ->> 'dtw_distance')::float      AS dtw_distance,
  (sf.normalized_features ->> 'stroke_count')::float      AS stroke_count,
  (sf.normalized_features ->> 'direction_score')::float   AS direction_score,
  sf.motor_score,
  sf.quality_score,
  sf.threshold,
  sf.threshold_passed,
  sf.collection_accepted,
  sf.canvas_width,
  sf.canvas_height,
  sf.stroke_points                                       AS raw_stroke_points,
  COALESCE(tv.teacher_validated, false)                  AS teacher_validated,
  (CASE tv.teacher_overall_rating
    WHEN 1 THEN 'weak' WHEN 2 THEN 'moderate' WHEN 3 THEN 'good' ELSE NULL
  END)::text                                              AS teacher_label,
  tv.teacher_notes                                        AS teacher_feedback,
  sf.created_at
FROM shape_features sf
LEFT JOIN teacher_validation tv
  ON tv.student_id = sf.student_id AND tv.collection_session_id = sf.collection_session_id

UNION ALL

SELECT
  'letter:' || la.id                                     AS sample_id,
  la.student_id,
  la.collection_session_id,
  'letter'::text                                          AS sample_type,
  la.letter::text                                         AS activity_name,
  la.letter::text                                         AS letter,
  la.case_type::text                                      AS case_type,
  la.attempt_number,
  la.task_order,
  la.collection_mode,
  la.capture_status::text                                 AS capture_status,
  la.feature_version::text                                AS feature_version,
  la.template_version::text                               AS template_version,
  (la.normalized_features ->> 'duration_ms')::float       AS duration_ms,
  (la.normalized_features ->> 'total_distance')::float    AS total_distance,
  (la.normalized_features ->> 'avg_speed')::float          AS avg_speed,
  (la.normalized_features ->> 'smoothness_score')::float   AS smoothness_score,
  (la.normalized_features ->> 'pause_count')::float        AS pause_count,
  (la.normalized_features ->> 'accuracy_score')::float     AS accuracy_score,
  (la.normalized_features ->> 'dtw_distance')::float       AS dtw_distance,
  (la.normalized_features ->> 'stroke_count')::float       AS stroke_count,
  (la.normalized_features ->> 'direction_score')::float    AS direction_score,
  la.motor_score,
  la.quality_score,
  la.threshold,
  la.threshold_passed,
  la.collection_accepted,
  la.canvas_width,
  la.canvas_height,
  la.stroke_points                                        AS raw_stroke_points,
  COALESCE(tv.teacher_validated, false)                   AS teacher_validated,
  (CASE tv.teacher_overall_rating
    WHEN 1 THEN 'weak' WHEN 2 THEN 'moderate' WHEN 3 THEN 'good' ELSE NULL
  END)::text                                               AS teacher_label,
  tv.teacher_notes                                         AS teacher_feedback,
  la.created_at
FROM letter_attempts la
LEFT JOIN teacher_validation tv
  ON tv.student_id = la.student_id AND tv.collection_session_id = la.collection_session_id;
`;

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(CREATE_VIEW_SQL);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP VIEW IF EXISTS handwriting_ml_samples;');
  },
};
