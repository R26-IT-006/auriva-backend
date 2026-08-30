'use strict';

const { DataTypes, Op } = require('sequelize');
const sequelize = require('../config/database');

// Feature 2 Step 1: append-only threshold CHANGE HISTORY / provenance store
// — see migrations/20260808000001-create-student-threshold-history.js for
// full schema rationale. Immutable: no route updates or deletes rows here.
// NOT the live threshold store — students.personal_thresholds is untouched.

const SOURCE_VALUES          = ['initial_from_baseline', 'automatic', 'teacher_override', 'legacy'];
const SCOPE_TYPE_VALUES      = ['family', 'letter', 'default'];
const BASELINE_FAMILY_VALUES = ['straight', 'curved', 'complex'];

const ThresholdHistory = sequelize.define('ThresholdHistory', {
  id: {
    type:          DataTypes.INTEGER,
    primaryKey:    true,
    autoIncrement: true,
  },
  student_id: {
    type:      DataTypes.INTEGER,
    allowNull: false,
  },

  scope_type: {
    type:      DataTypes.STRING(20),
    allowNull: false,
    validate:  { isIn: [SCOPE_TYPE_VALUES] },
  },
  scope_key: {
    type:      DataTypes.STRING(20),
    allowNull: false,
  },

  // Sequelize's built-in validators (isIn included) are skipped when the
  // value is null and allowNull:true — so this stays optional for
  // non-family-scoped events while still being constrained whenever set.
  baseline_family: {
    type:      DataTypes.STRING(20),
    allowNull: true,
    validate:  { isIn: [BASELINE_FAMILY_VALUES] },
  },

  old_threshold: {
    type:      DataTypes.FLOAT,
    allowNull: true,
  },
  new_threshold: {
    type:      DataTypes.FLOAT,
    allowNull: false,
  },

  source: {
    type:      DataTypes.STRING(30),
    allowNull: false,
    validate:  { isIn: [SOURCE_VALUES] },
  },
  reason: {
    type:      DataTypes.STRING(100),
    allowNull: false,
  },

  baseline_id: {
    type:      DataTypes.INTEGER,
    allowNull: true,
  },
  baseline_version: {
    type:      DataTypes.STRING(20),
    allowNull: true,
  },
  mapping_version: {
    type:      DataTypes.STRING(30),
    allowNull: true,
  },

  recent_window_snapshot: {
    type:      DataTypes.JSONB,
    allowNull: true,
  },

  // Feature 2 Step 6B — sha256 hex digest identifying the exact evidence
  // (student, family, current-target history event, attempt IDs, window
  // size, mapping version) an 'automatic' decision was based on. Null for
  // every other source — see
  // migrations/20260808000003-add-evidence-fingerprint-to-threshold-history.js
  // for why this is its own column rather than folded into `reason` or
  // `recent_window_snapshot`. Computed in dynamicThresholdService.js
  // (computeEvidenceFingerprint) — never set directly by a caller.
  evidence_fingerprint: {
    type:      DataTypes.STRING(64),
    allowNull: true,
  },

  created_at: {
    type:         DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName:       'student_threshold_history',
  timestamps:      false,
  freezeTableName: true,
  indexes: [
    { fields: ['student_id'] },
    { fields: ['baseline_family'] },
    { fields: ['student_id', 'scope_type', 'scope_key', 'created_at'] },
    // Feature 2 Step 3 — DB-backed idempotency for initial-from-baseline
    // events only (partial index, never constrains 'automatic'/
    // 'teacher_override' rows). See
    // migrations/20260808000002-add-initial-family-threshold-uniqueness.js.
    {
      name:   'student_threshold_history_initial_family_uniq',
      fields: ['student_id', 'scope_type', 'scope_key', 'baseline_id', 'mapping_version'],
      unique: true,
      where:  { source: 'initial_from_baseline' },
    },
    // Feature 2 Step 6B — DB-backed idempotency for automatic events only
    // (partial index, never constrains 'initial_from_baseline'/
    // 'teacher_override' rows). See
    // migrations/20260808000003-add-evidence-fingerprint-to-threshold-history.js.
    {
      name:   'student_threshold_history_automatic_evidence_uniq',
      fields: ['student_id', 'scope_type', 'scope_key', 'source', 'evidence_fingerprint'],
      unique: true,
      where:  { source: 'automatic', evidence_fingerprint: { [Op.ne]: null } },
    },
  ],
});

module.exports = ThresholdHistory;
