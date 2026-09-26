'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Homework practice worksheet — see
// migrations/20260826000004-create-handwriting-worksheets.js for the full
// rationale. Teacher-directed SUPPORT MATERIAL only: nothing here feeds
// mastery, Motor Score, thresholds, sequencing or word unlock.
const HandwritingWorksheet = sequelize.define('HandwritingWorksheet', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  student_id:     { type: DataTypes.INTEGER,    allowNull: false },
  worksheet_code: { type: DataTypes.STRING(24), allowNull: false },

  recommendation_fingerprint: { type: DataTypes.STRING(128), allowNull: true },
  case_type:    { type: DataTypes.STRING(10), allowNull: false },
  motor_family: { type: DataTypes.STRING(16), allowNull: true },

  target_letter:       { type: DataTypes.CHAR(1),    allowNull: false },
  worksheet_intensity: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'standard' },
  status:              { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'generated' },
  teacher_note:        { type: DataTypes.TEXT,       allowNull: true },

  generated_at: { type: DataTypes.DATE, allowNull: false },
  assigned_at:  { type: DataTypes.DATE, allowNull: true },
  due_date:     { type: DataTypes.DATE, allowNull: true },
  completed_at: { type: DataTypes.DATE, allowNull: true },

  worksheet_file_url: { type: DataTypes.STRING(512), allowNull: true },

  // The FROZEN motor-preparation plan this worksheet was generated from.
  // A reprint renders from this, never from the live worksheetMotorMap, so a
  // printed sheet stays reproducible even after the mapping changes.
  // NULL on worksheets created before this column existed — the renderer
  // falls back honestly rather than inventing a plan for them.
  worksheet_plan: { type: DataTypes.JSONB, allowNull: true },

  created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  updated_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  tableName: 'handwriting_worksheets',
  timestamps: false,
  indexes: [
    { unique: true, fields: ['worksheet_code'] },
    { fields: ['student_id', 'generated_at'] },
  ],
});

module.exports = HandwritingWorksheet;
