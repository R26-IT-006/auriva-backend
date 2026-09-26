'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Level2TopicProgress = sequelize.define('Level2TopicProgress', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  student_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  topic: {
    type: DataTypes.ENUM('self_introduction', 'describe_friend', 'describe_pet'),
    allowNull: false,
    defaultValue: 'self_introduction',
  },
  status: {
    type: DataTypes.ENUM('not_started', 'in_progress', 'mastered', 'struggling'),
    allowNull: false,
    defaultValue: 'not_started',
  },
  // How many sessions had combined SxS element score >= 4
  session_pass_count: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  last_pass_date: {
    type: DataTypes.DATEONLY,
    allowNull: true,
  },
  // Consecutive sessions with SxS element score <= 1
  consecutive_fail_count: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  total_sessions: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
  updated_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'level2_topic_progress',
  timestamps: false,
  freezeTableName: true,
  indexes: [
    { unique: true, fields: ['student_id', 'topic'] },
  ],
});

module.exports = Level2TopicProgress;
