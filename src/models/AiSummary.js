'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Cache of generated teacher-facing summaries, keyed by a hash of the exact input
// that produced them. The analytics payloads are deterministic, so an unchanged
// hash means an unchanged summary — regenerating would spend a model call to
// produce the same paragraph.
//
// Note what this table does *not* hold: the cached payload is built from the
// pseudonymised input, so no student name or id ever lands here.
const AiSummary = sequelize.define('AiSummary', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  scope: {
    type: DataTypes.STRING(40),
    allowNull: false,
  },
  // Student sid for 'concept_report', teacher tid for 'class_digest'. Deliberately
  // not a foreign key — the column points at two different tables depending on
  // scope, and a constraint could only ever be right for one of them.
  subject_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  input_hash: {
    type: DataTypes.STRING(64),
    allowNull: false,
  },
  // Stored so a model change is visible in the data rather than silently
  // producing summaries of two different vintages under one cache.
  model: {
    type: DataTypes.STRING(80),
    allowNull: false,
  },
  payload: {
    type: DataTypes.JSONB,
    allowNull: false,
  },
  generated_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'ai_summaries',
  timestamps: false,
  freezeTableName: true,
  indexes: [
    { unique: true, fields: ['scope', 'subject_id', 'input_hash'] },
  ],
});

module.exports = AiSummary;
