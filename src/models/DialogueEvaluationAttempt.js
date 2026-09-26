'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const DialogueEvaluationAttempt = sequelize.define('DialogueEvaluationAttempt', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  student_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: { model: 'students', key: 'sid' },
  },
  category: {
    type: DataTypes.STRING(32),
    allowNull: false,
  },
  word_ids: {
    type: DataTypes.ARRAY(DataTypes.INTEGER),
    allowNull: false,
  },
  pairs_detail: {
    type: DataTypes.JSONB,
    allowNull: false,
  },
  correct_count: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  total_count: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  attempted_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'dialogue_evaluation_attempts',
  timestamps: false,
  freezeTableName: true,
});

module.exports = DialogueEvaluationAttempt;
