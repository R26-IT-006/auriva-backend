'use strict';
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

module.exports = sequelize.define('WordActivityProgress', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  student_id: { type: DataTypes.INTEGER, allowNull: false },
  word: { type: DataTypes.STRING(32), allowNull: false },
  source_letter: { type: DataTypes.CHAR(1), allowNull: false },
  activity_status: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
}, { tableName: 'handwriting_word_activity_progress', underscored: true, timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', indexes: [{ unique: true, fields: ['student_id', 'word'] }] });
