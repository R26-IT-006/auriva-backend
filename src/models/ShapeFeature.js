'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ShapeFeature = sequelize.define('ShapeFeature', {
  id: {
    type:          DataTypes.INTEGER,
    primaryKey:    true,
    autoIncrement: true,
  },
  // Nullable: pre-writing warm-up rows (source: 'pre_writing_warmup') have no
  // handwriting_assessments parent — see migration
  // 20260804000001-relax-shape-features-for-prewriting.
  assessment_id: {
    type:      DataTypes.INTEGER,
    allowNull: true,
  },
  student_id: {
    type:      DataTypes.INTEGER,
    allowNull: false,
  },
  // Which population this row belongs to: 'initial_assessment' (the 6-shape
  // battery, via submitAssessment) or 'pre_writing_warmup' (via
  // submitPreWritingActivity). Query by this before aggregating shape_type
  // across rows — the two populations use different, non-overlapping
  // shape_type vocabularies but nothing else marks them apart.
  source: {
    type:         DataTypes.STRING(30),
    allowNull:    false,
    defaultValue: 'initial_assessment',
  },
  shape_type: {
    type:      DataTypes.STRING(50),
    allowNull: false,
  },
  attempt_number: {
    type:         DataTypes.INTEGER,
    allowNull:    false,
    defaultValue: 1,
  },
  // full features object from the frontend: {duration_ms, total_distance,
  // avg_speed, smoothness, pause_count, accuracy}
  features: {
    type:         DataTypes.JSONB,
    allowNull:    false,
    defaultValue: {},
  },
  // array of {stroke_id, points:[{x,y,t,tAbs,stroke_id}]} — one element per
  // pen-lift within this shape attempt
  stroke_points: {
    type:         DataTypes.JSONB,
    allowNull:    false,
    defaultValue: [],
  },
  // true when captured during a fixed research protocol session
  collection_mode: {
    type:         DataTypes.BOOLEAN,
    allowNull:    false,
    defaultValue: false,
  },

  // ── Collection-session tracking ────────────────────────────────────────────
  collection_session_id: { type: DataTypes.UUID,       allowNull: true },
  protocol_version:      { type: DataTypes.STRING(20), allowNull: true },
  task_order:            { type: DataTypes.INTEGER,    allowNull: true },
  capture_status: {
    type:         DataTypes.ENUM('complete', 'incomplete', 'abandoned', 'network_failed'),
    allowNull:    false,
    defaultValue: 'complete',
  },

  // ── Device / capture metadata ──────────────────────────────────────────────
  canvas_width:     { type: DataTypes.INTEGER,    allowNull: true },
  canvas_height:    { type: DataTypes.INTEGER,    allowNull: true },
  device_type:      { type: DataTypes.STRING(20), allowNull: true },
  app_version:      { type: DataTypes.STRING(20), allowNull: true },
  feature_version:  { type: DataTypes.STRING(20), allowNull: true },
  template_version: { type: DataTypes.STRING(20), allowNull: true },
  // dtw_norm_v1 — see frontend utils/dtwNormalization.js. Which coordinate
  // normalization method produced this row's dtw_distance (zigzag/curve_wave).
  normalization_version: { type: DataTypes.STRING(20), allowNull: true },

  // ── ML-normalized features + score (see src/utils/featureNormalization.js,
  //    src/utils/motorScore.js) ────────────────────────────────────────────
  // Canonical 10-field schema: duration_ms, total_distance, avg_speed,
  // smoothness_score, pause_count, accuracy_score, dtw_distance, stroke_count,
  // direction_score, motor_score. `features` above is left untouched
  // (raw, as sent by the client) for backward compatibility.
  normalized_features: { type: DataTypes.JSONB, allowNull: true },
  feature_validity:    { type: DataTypes.JSONB, allowNull: true },
  motor_score:         { type: DataTypes.FLOAT, allowNull: true },
  quality_score:       { type: DataTypes.FLOAT, allowNull: true },
  score_version:       { type: DataTypes.STRING(20), allowNull: true },

  // ── Collection acceptance vs. quality (never use collection_accepted as
  //    an ML label — see handwritingController.js) ──────────────────────────
  collection_accepted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  threshold:           { type: DataTypes.FLOAT,   allowNull: true }, // N/A for shapes today
  threshold_passed:    { type: DataTypes.BOOLEAN, allowNull: true },

  // Same column as letter_attempts, kept for schema symmetry — always NULL
  // for shapes today (no multi-stroke template/bipartite-matching concept
  // exists for zigzag/curve_wave, see computeMultiStrokeDTW in dtw.js).
  stroke_order_matches_template: { type: DataTypes.BOOLEAN, allowNull: true },

  created_at: {
    type:         DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName:       'shape_features',
  timestamps:      false,
  freezeTableName: true,
  indexes: [
    { fields: ['assessment_id'] },
    { fields: ['student_id']   },
    { fields: ['shape_type']   },
    { fields: ['collection_session_id'] },
    { fields: ['capture_status'] },
  ],
});

module.exports = ShapeFeature;
