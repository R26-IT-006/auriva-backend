'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const HandwritingAssessment = sequelize.define('HandwritingAssessment', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  student_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  session_start: {
    type: DataTypes.BIGINT,
    allowNull: false,
  },
  session_end: {
    type: DataTypes.BIGINT,
    allowNull: false,
  },
  shapes: {
    type: DataTypes.JSON,
    allowNull: false,
  },
  is_initial: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  motor_score: {
    type: DataTypes.FLOAT,
    allowNull: true,
  },
  motor_profile: {
    type: DataTypes.JSON,
    allowNull: true,
  },
  // true when this assessment was part of a fixed research protocol session
  collection_mode: {
    type:         DataTypes.BOOLEAN,
    allowNull:    false,
    defaultValue: false,
  },
  collection_session_id: {
    type:      DataTypes.UUID,
    allowNull: true,
  },
  protocol_version: {
    type:      DataTypes.STRING(20),
    allowNull: true,
  },
  task_order: {
    type:      DataTypes.INTEGER,
    allowNull: true,
  },
  capture_status: {
    type:         DataTypes.ENUM('complete', 'incomplete', 'abandoned', 'network_failed'),
    allowNull:    false,
    defaultValue: 'complete',
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'handwriting_assessments',
  timestamps: false,
  freezeTableName: true,
});

module.exports = HandwritingAssessment;
