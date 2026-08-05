'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ExplanationResult = sequelize.define('ExplanationResult', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  assessment_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  student_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  difficulty_type: {
    type: DataTypes.STRING(100),
    allowNull: true,
  },
  difficulty_label: {
    type: DataTypes.STRING(200),
    allowNull: true,
  },
  confidence_score: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  motor_score: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  feature_contributions: {
    type: DataTypes.JSONB,
    allowNull: true,
    defaultValue: [],
  },
  explanation_lines: {
    type: DataTypes.JSONB,
    allowNull: true,
    defaultValue: [],
  },
  recommendations: {
    type: DataTypes.JSONB,
    allowNull: true,
    defaultValue: [],
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'explanation_results',
  timestamps: false,
  freezeTableName: true,
});

module.exports = ExplanationResult;