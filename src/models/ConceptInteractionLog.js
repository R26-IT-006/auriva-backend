'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ConceptInteractionLog = sequelize.define('ConceptInteractionLog', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  student_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  session_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  category_key: {
    type: DataTypes.STRING(50),
    allowNull: false,
  },
  concept_key: {
    type: DataTypes.STRING(50),
    allowNull: false,
  },
  tier: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
  },
  event_type: {
    // image_tap | match_attempt | tier1_pass | tier1_fail | relearn_start
    type: DataTypes.STRING(50),
    allowNull: false,
  },
  event_data: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'concept_interaction_logs',
  timestamps: false,
  freezeTableName: true,
  // This table grows at per-tap granularity and had no indexes at all, so every
  // teacher-analytics read sequential-scanned it. These three cover the access
  // patterns in conceptAnalyticsService: time-bounded scans, event_type filters,
  // and per-concept roll-ups.
  indexes: [
    { name: 'cil_student_created',        fields: ['student_id', 'created_at'] },
    { name: 'cil_student_event',          fields: ['student_id', 'event_type'] },
    { name: 'cil_student_cat_concept',    fields: ['student_id', 'category_key', 'concept_key'] },
  ],
});

module.exports = ConceptInteractionLog;
