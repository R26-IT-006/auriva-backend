'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const CanYouGameRound = sequelize.define('CanYouGameRound', {
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
  tap_response: {
    type: DataTypes.ENUM('yes', 'no'),
    allowNull: false,
  },
  voice_attempted: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  speech_detected: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
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
  tableName: 'can_you_game_rounds',
  timestamps: false,
  freezeTableName: true,
});

module.exports = CanYouGameRound;
