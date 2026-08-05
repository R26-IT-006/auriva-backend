'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const StudentMotorFeature = sequelize.define('StudentMotorFeature', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  student_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  assessment_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    unique: true,
  },
  is_initial: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  shape_count: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  avg_duration_ms: {
    type: DataTypes.FLOAT,
    allowNull: true,
  },
  avg_total_distance: {
    type: DataTypes.FLOAT,
    allowNull: true,
  },
  avg_speed: {
    type: DataTypes.FLOAT,
    allowNull: true,
  },
  avg_smoothness: {
    type: DataTypes.FLOAT,
    allowNull: true,
  },
  avg_pause_count: {
    type: DataTypes.FLOAT,
    allowNull: true,
  },
  avg_accuracy: {
    type: DataTypes.FLOAT,
    allowNull: true,
  },
  avg_stroke_count: {
    type: DataTypes.FLOAT,
    allowNull: true,
  },
  feature_vector: {
    type: DataTypes.JSON,
    allowNull: false,
    defaultValue: {},
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'student_motor_features',
  timestamps: false,
  freezeTableName: true,
});

module.exports = StudentMotorFeature;
