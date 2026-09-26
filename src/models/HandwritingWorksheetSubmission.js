'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// One returned (photographed or scanned) worksheet. A worksheet may be
// submitted more than once — a retaken photo, a second attempt at home — so
// submissions live in their own table and never overwrite the assignment.
//
// The analysis_* columns are reserved for a FUTURE, separately-validated
// optional image analysis. Nothing writes them today: no automatic scoring of
// handwriting from a scan exists in this system.
const HandwritingWorksheetSubmission = sequelize.define('HandwritingWorksheetSubmission', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  worksheet_id: { type: DataTypes.INTEGER, allowNull: false },
  student_id:   { type: DataTypes.INTEGER, allowNull: false },

  submitted_at:    { type: DataTypes.DATE,       allowNull: false },
  file_reference:  { type: DataTypes.STRING(512), allowNull: false },
  submission_type: { type: DataTypes.STRING(16),  allowNull: false },

  review_status:   { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'pending_review' },
  teacher_comment: { type: DataTypes.TEXT,       allowNull: true },
  reviewed_at:     { type: DataTypes.DATE,       allowNull: true },

  analysis_status:        { type: DataTypes.STRING(24), allowNull: true },
  analysis_result:        { type: DataTypes.JSONB,      allowNull: true },
  analysis_model_version: { type: DataTypes.STRING(40), allowNull: true },

  created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  updated_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  tableName: 'handwriting_worksheet_submissions',
  timestamps: false,
  indexes: [
    { fields: ['worksheet_id', 'submitted_at'] },
    { fields: ['student_id', 'submitted_at'] },
  ],
});

module.exports = HandwritingWorksheetSubmission;
