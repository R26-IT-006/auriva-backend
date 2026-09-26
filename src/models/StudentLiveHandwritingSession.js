'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const {
  LIVE_ACTIVITY_TYPES, LIVE_SESSION_STATUSES, LIVE_CASE_TYPES,
} = require('../config/liveSessionPolicy');

// Proposal FR-16, Phase 7B — current live-session snapshot, one row per
// student (student_id is the primary key — see the migration's own header
// for why). CURRENT STATE ONLY; never a history table (spec §7).
const StudentLiveHandwritingSession = sequelize.define('StudentLiveHandwritingSession', {
  student_id: {
    type:       DataTypes.INTEGER,
    primaryKey: true,
    allowNull:  false,
  },
  activity_type: {
    type:      DataTypes.STRING(20),
    allowNull: false,
    validate:  { isIn: [LIVE_ACTIVITY_TYPES] },
  },
  status: {
    type:      DataTypes.STRING(10),
    allowNull: false,
    validate:  { isIn: [LIVE_SESSION_STATUSES] },
  },
  current_item: {
    type:      DataTypes.STRING(30),
    allowNull: true,
  },
  case_type: {
    type:      DataTypes.STRING(10),
    allowNull: true,
    validate:  { isIn: [LIVE_CASE_TYPES] },
  },
  attempt_number: {
    type:      DataTypes.INTEGER,
    allowNull: true,
  },
  support_level: {
    type:      DataTypes.STRING(20),
    allowNull: true,
  },
  elapsed_active_seconds: {
    type:         DataTypes.INTEGER,
    allowNull:    false,
    defaultValue: 0,
  },
  latest_saved_score: {
    type:      DataTypes.FLOAT,
    allowNull: true,
  },
  started_at: {
    type:      DataTypes.DATE,
    allowNull: false,
  },
  last_updated_at: {
    type:      DataTypes.DATE,
    allowNull: false,
  },
}, {
  tableName:       'student_live_handwriting_sessions',
  timestamps:      false,
  freezeTableName: true,
});

module.exports = StudentLiveHandwritingSession;
