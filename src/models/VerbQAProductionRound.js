'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const VerbQAProductionRound = sequelize.define('VerbQAProductionRound', {
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
  intended_response: {
    type: DataTypes.ENUM('yes_i_can', 'no_i_cant'),
    allowNull: false,
  },
  speech_score: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  transcript: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  match_type: {
    type: DataTypes.ENUM('none', 'exact', 'keyword', 'fuzzy', 'non_verbal'),
    allowNull: true,
  },
  non_verbal_fallback_used: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  tap_response: {
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
  tableName: 'verb_qa_production_rounds',
  timestamps: false,
  freezeTableName: true,
});

module.exports = VerbQAProductionRound;
