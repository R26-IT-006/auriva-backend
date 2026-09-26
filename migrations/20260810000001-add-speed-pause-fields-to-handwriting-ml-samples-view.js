'use strict';

// ML readiness pass (collection-mode feature-completeness fix, Part 9):
// extends handwriting_ml_samples with the new speed/pause fields
// introduced in src/utils/featureNormalization.js's deriveTrajectoryFeatures()
// — speed_std, speed_cv, total_pause_duration_ms, mean_pause_duration_ms,
// pause_frequency, pause_duration_ratio — by extracting them from the same
// `normalized_features` JSONB column the view already reads every other
// derived feature from.
//
// This migration is a straight CREATE OR REPLACE VIEW: every existing
// column, in its original order, with its original expression, is kept
// byte-for-byte identical to migrations/20260714000006-create-
// handwriting-ml-samples-view.js — the new columns are appended at the end
// of each branch's SELECT list only. GET /handwriting/ml-samples/export
// (collectionController.js's exportMlSamples) selects `*` from this view
// and is unaffected by a column being appended; nothing that already reads
// this view can break from new trailing columns.
//
// down() restores the exact prior view definition (see the migration
// referenced above) rather than dropping the view outright, so a rollback
// leaves handwriting_ml_samples in its pre-this-migration working state
// instead of removing it.
const CREATE_VIEW_SQL_V2 = `
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
  sf.created_at,
  (sf.normalized_features ->> 'speed_std')::float                 AS speed_std,
  (sf.normalized_features ->> 'speed_cv')::float                  AS speed_cv,
  (sf.normalized_features ->> 'total_pause_duration_ms')::float   AS total_pause_duration_ms,
  (sf.normalized_features ->> 'mean_pause_duration_ms')::float    AS mean_pause_duration_ms,
  (sf.normalized_features ->> 'pause_frequency')::float           AS pause_frequency,
  (sf.normalized_features ->> 'pause_duration_ratio')::float      AS pause_duration_ratio
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
  la.created_at,
  (la.normalized_features ->> 'speed_std')::float                 AS speed_std,
  (la.normalized_features ->> 'speed_cv')::float                  AS speed_cv,
  (la.normalized_features ->> 'total_pause_duration_ms')::float   AS total_pause_duration_ms,
  (la.normalized_features ->> 'mean_pause_duration_ms')::float    AS mean_pause_duration_ms,
  (la.normalized_features ->> 'pause_frequency')::float           AS pause_frequency,
  (la.normalized_features ->> 'pause_duration_ratio')::float      AS pause_duration_ratio
FROM letter_attempts la
LEFT JOIN teacher_validation tv
  ON tv.student_id = la.student_id AND tv.collection_session_id = la.collection_session_id;
`;

// Exact prior definition (migrations/20260714000006-create-handwriting-ml-samples-view.js),
// restored verbatim on rollback.
const CREATE_VIEW_SQL_V1 = `
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
    await queryInterface.sequelize.query(CREATE_VIEW_SQL_V2);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(CREATE_VIEW_SQL_V1);
  },
};
