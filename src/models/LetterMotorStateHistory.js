'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Feature 11B Phase 5 — see
// migrations/20260821000002-create-letter-motor-state-history.js for the
// full schema rationale. One immutable row per (student, milestone,
// model_version) persisted K=2 prediction snapshot — only ever created at
// the 14/17/20 pilot milestones, never at 3/7/10.
const LetterMotorStateHistory = sequelize.define('LetterMotorStateHistory', {
  id: {
    type:          DataTypes.INTEGER,
    primaryKey:    true,
    autoIncrement: true,
  },
  student_id: { type: DataTypes.INTEGER,    allowNull: false },
  milestone:  { type: DataTypes.STRING(40), allowNull: false },
  coverage_n: { type: DataTypes.INTEGER,    allowNull: false },
  completed_category: { type: DataTypes.JSONB, allowNull: false },
  observed_at:         { type: DataTypes.DATE,   allowNull: false },

  smoothness_score: { type: DataTypes.FLOAT, allowNull: false },
  dtw_distance:     { type: DataTypes.FLOAT, allowNull: false },
  speed_cv:         { type: DataTypes.FLOAT, allowNull: false },

  cluster_id:   { type: DataTypes.INTEGER,    allowNull: false },
  state_code:   { type: DataTypes.STRING(40), allowNull: false },
  display_name: { type: DataTypes.STRING(80), allowNull: false },

  nearest_distance:        { type: DataTypes.FLOAT, allowNull: false },
  second_nearest_distance: { type: DataTypes.FLOAT, allowNull: false },
  separation_margin:       { type: DataTypes.FLOAT, allowNull: false },

  model_version: { type: DataTypes.STRING(40), allowNull: false },

  feature_version:       { type: DataTypes.STRING(20), allowNull: false },
  template_version:      { type: DataTypes.STRING(20), allowNull: false },
  normalization_version: { type: DataTypes.STRING(20), allowNull: false },

  // Writing Check link. NULL on legacy 14/17/20 milestone rows; set on
  // rows produced by a dedicated teacher-initiated Writing Check. See
  // migrations/20260826000003 for why uniqueness is split by this column.
  pattern_check_id: { type: DataTypes.INTEGER, allowNull: true },

  created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  updated_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  tableName:  'letter_motor_state_history',
  timestamps: false,
  indexes: [
    { fields: ['student_id', 'observed_at'] },
    { unique: true, fields: ['student_id', 'milestone', 'model_version'] },
  ],
});

module.exports = LetterMotorStateHistory;
