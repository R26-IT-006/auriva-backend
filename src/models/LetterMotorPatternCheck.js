'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Writing Check session — see
// migrations/20260826000003-create-letter-motor-pattern-checks.js for the full
// rationale (why the dedicated route exists and why it reproduces the model's
// training regime).
//
// One row per teacher-initiated Writing Check. Purely a descriptive assessment:
// it never touches mastery, progression, thresholds, sequencing or word unlock.
const LetterMotorPatternCheck = sequelize.define('LetterMotorPatternCheck', {
  id: {
    type:          DataTypes.INTEGER,
    primaryKey:    true,
    autoIncrement: true,
  },
  student_id:            { type: DataTypes.INTEGER,    allowNull: false },
  collection_session_id: { type: DataTypes.UUID,       allowNull: false },
  status:                { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'in_progress' },
  started_at:            { type: DataTypes.DATE,       allowNull: false },
  completed_at:          { type: DataTypes.DATE,       allowNull: true },
  letters_captured:      { type: DataTypes.INTEGER,    allowNull: false, defaultValue: 0 },
  model_version:         { type: DataTypes.STRING(40), allowNull: true },

  created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  updated_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  tableName:  'letter_motor_pattern_checks',
  timestamps: false,
  indexes: [
    { unique: true, fields: ['collection_session_id'] },
    { fields: ['student_id', 'started_at'] },
  ],
});

// The status vocabulary itself lives in
// services/letterMotorPatternCheckService.js (its STATUS export) — this model
// only declares the column. Keeping one definition avoids two copies drifting,
// and avoids controller test suites that mock ../src/models partially breaking
// at import time.

module.exports = LetterMotorPatternCheck;
