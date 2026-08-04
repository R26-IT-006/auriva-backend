'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const CollectionSession = sequelize.define('CollectionSession', {
  id: {
    type:         DataTypes.UUID,
    primaryKey:   true,
    allowNull:    false,
  },
  student_id: {
    type:      DataTypes.INTEGER,
    allowNull: false,
  },
  protocol_version: {
    type:      DataTypes.STRING(20),
    allowNull: true,
  },
  device_type: {
    type:      DataTypes.STRING(20),
    allowNull: true,
  },
  app_version: {
    type:      DataTypes.STRING(20),
    allowNull: true,
  },
  capture_status: {
    type:         DataTypes.ENUM('in_progress', 'complete', 'incomplete', 'abandoned', 'network_failed'),
    allowNull:    false,
    defaultValue: 'in_progress',
  },
  started_at: {
    type:         DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
  completed_at: {
    type:      DataTypes.DATE,
    allowNull: true,
  },
  created_at: {
    type:         DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName:       'collection_sessions',
  timestamps:      false,
  freezeTableName: true,
});

module.exports = CollectionSession;
