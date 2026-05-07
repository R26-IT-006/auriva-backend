'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ActionWord = sequelize.define('ActionWord', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  word: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  word_type: {
    type: DataTypes.ENUM('standalone', 'action_verb'),
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
  animation_asset: {
    type: DataTypes.STRING,
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
  tableName: 'action_words',
  timestamps: false,
  freezeTableName: true,
});

module.exports = ActionWord;
