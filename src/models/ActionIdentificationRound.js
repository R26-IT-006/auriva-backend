'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ActionIdentificationRound = sequelize.define('ActionIdentificationRound', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  student_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  word_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: { model: 'dialogue_words', key: 'id' },
  },
  session_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  distractor_word_ids: {
    type: DataTypes.JSON,
    allowNull: false,
  },
  first_attempt_correct: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
  },
  required_hint: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  auto_advanced: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  response_given: {
    type: DataTypes.ENUM('yes_i_can', 'no_i_cant'),
    allowNull: true,
  },
  round_order: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  played_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'action_identification_rounds',
  timestamps: false,
  freezeTableName: true,
});

module.exports = ActionIdentificationRound;
