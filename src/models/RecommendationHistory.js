'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const RecommendationHistory = sequelize.define('RecommendationHistory', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
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
  recommendations: {
    type: DataTypes.JSONB,
    allowNull: true,
    defaultValue: [],
  },
  session_date: {
    type: DataTypes.DATEONLY,
    defaultValue: DataTypes.NOW,
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'recommendation_history',
  timestamps: false,
  freezeTableName: true,
});

module.exports = RecommendationHistory;