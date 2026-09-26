'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const DialogueWord = sequelize.define('DialogueWord', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  word: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  category: {
    type: DataTypes.ENUM('greetings', 'magic_words', 'abilities', 'days_of_week'),
    allowNull: false,
  },
  difficulty: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  teaching_order: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  asset_key: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },
  cue_grapheme: {
    type: DataTypes.STRING(10),
    allowNull: true,
  },
  keyword_triggers: {
    type: DataTypes.JSON,
    allowNull: false,
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'dialogue_words',
  timestamps: false,
  freezeTableName: true,
});

module.exports = DialogueWord;
