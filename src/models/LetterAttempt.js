'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const LetterAttempt = sequelize.define('LetterAttempt', {
  id: {
    type:          DataTypes.INTEGER,
    primaryKey:    true,
    autoIncrement: true,
  },
  student_id: {
    type:      DataTypes.INTEGER,
    allowNull: false,
  },
  letter: {
    type:      DataTypes.CHAR(1),
    allowNull: false,
  },
  case_type: {
    type:      DataTypes.ENUM('lowercase', 'uppercase'),
    allowNull: false,
  },
  // UUID generated on the backend once per POST call; groups all attempt rows
  // from the same session so ML can reconstruct full session history.
  session_key: {
    type:      DataTypes.UUID,
    allowNull: false,
  },
  // attempt_number as sent by the client (1–3 within the session)
  attempt_number: {
    type:         DataTypes.INTEGER,
    allowNull:    false,
    defaultValue: 1,
  },
  // true when bestScore >= threshold for this call; false on quality block
  passed: {
    type:      DataTypes.BOOLEAN,
    allowNull: false,
  },
  best_score: {
    type:      DataTypes.FLOAT,
    allowNull: true,
  },
  threshold: {
    type:      DataTypes.FLOAT,
    allowNull: true,
  },
  // per-attempt features: {smoothness, pauseCount, completionTime, strokeCount, dtw_distance}
  features: {
    type:      DataTypes.JSONB,
    allowNull: true,
  },
  // per-attempt raw strokes: [{stroke_id, points:[{x,y,t,tAbs,stroke_id}]}]
  stroke_points: {
    type:      DataTypes.JSONB,
    allowNull: true,
  },
  // true when this row was recorded during a fixed research protocol session
  collection_mode: {
    type:         DataTypes.BOOLEAN,
    allowNull:    false,
    defaultValue: false,
  },
  created_at: {
    type:         DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName:       'letter_attempts',
  timestamps:      false,
  freezeTableName: true,
  indexes: [
    { fields: ['student_id', 'letter', 'case_type'] },
    { fields: ['session_key'] },
  ],
});

module.exports = LetterAttempt;
