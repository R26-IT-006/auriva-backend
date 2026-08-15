'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Feature 9 Step 3: append-only teacher-judgement history for Feature 8
// worksheet recommendations — see
// migrations/20260814000001-create-teacher-recommendation-validations.js
// and docs/feature9-validation-history-design.md for full schema rationale.
// Immutable: no route or service in this codebase ever calls
// .update()/.destroy()/.save() on an existing row here — only
// teacherRecommendationValidationService.js's own findOrCreate() ever
// writes, and only to insert a brand-new row.
//
// NOT the same concept as:
//   - `TeacherValidation` (teacher_validation table) — collection-mode
//     quality ratings, unrelated to Feature 7/8/9.
//   - `RecommendationHistory` / `ExplanationResult` — the separate
//     initial-assessment explainability system.
//   - Feature 7's own still-deferred, never-created
//     `persistent_difficulty_history` table.

const CASE_TYPE_VALUES = ['lowercase', 'uppercase'];
const FAMILY_VALUES = ['straight', 'curved', 'complex'];
const VALIDATION_VALUES = ['confirmed', 'dismissed'];
// Feature 8's sole recommendation type as of this writing. The DB column
// itself is a plain STRING(50), not a native enum (migration's own
// rationale) — this application-level list is what actually constrains it,
// exactly like case_type/family/validation below, so a future second
// Feature 8 recommendation type is a one-line code change here, not a
// migration.
const RECOMMENDATION_TYPE_VALUES = ['motor_family_practice'];
const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/;

// Step 3 spec §17 — no existing project convention for a note-length bound
// was found during Step 1's audit; 2000 characters is a fresh, conservative
// implementation limit: large enough for a short professional note, small
// enough to prevent an accidental huge payload. Defined here (the storage
// layer) rather than only in the service layer, so the column-level
// constraint and the service's own pre-write rejection can never drift —
// teacherRecommendationValidationService.js imports this constant rather
// than redeclaring its own copy.
const MAX_TEACHER_NOTE_LENGTH = 2000;

const TeacherRecommendationValidation = sequelize.define('TeacherRecommendationValidation', {
  id: {
    type:          DataTypes.INTEGER,
    primaryKey:    true,
    autoIncrement: true,
  },
  student_id: {
    type:      DataTypes.INTEGER,
    allowNull: false,
    validate:  { min: 1 },
  },
  teacher_id: {
    type:      DataTypes.INTEGER,
    allowNull: false,
    validate:  { min: 1 },
  },

  case_type: {
    type:      DataTypes.STRING(20),
    allowNull: false,
    validate:  { isIn: [CASE_TYPE_VALUES] },
  },
  family: {
    type:      DataTypes.STRING(20),
    allowNull: false,
    validate:  { isIn: [FAMILY_VALUES] },
  },

  // Open string (Step 3 spec §10 — currently only 'motor_family_practice'
  // is valid at the service layer, but the column itself does not hard-code
  // a 1-value check, so a future second Feature 8 recommendation type does
  // not require a migration).
  recommendation_type: {
    type:      DataTypes.STRING(50),
    allowNull: false,
    validate:  { isIn: [RECOMMENDATION_TYPE_VALUES] },
  },
  recommendation_title: {
    type:      DataTypes.STRING(200),
    allowNull: false,
    validate:  { notEmpty: true },
  },

  focus_letters: {
    type:      DataTypes.JSONB,
    allowNull: false,
  },
  suggested_activities: {
    type:      DataTypes.JSONB,
    allowNull: false,
  },
  rationale: {
    type:      DataTypes.TEXT,
    allowNull: false,
    validate:  { notEmpty: true },
  },

  validation: {
    type:      DataTypes.STRING(20),
    allowNull: false,
    validate:  { isIn: [VALIDATION_VALUES] },
  },
  teacher_note: {
    type:      DataTypes.TEXT,
    allowNull: true,
    validate:  { len: [0, MAX_TEACHER_NOTE_LENGTH] },
  },

  evidence_fingerprint: {
    type:      DataTypes.STRING(64),
    allowNull: false,
    validate:  { is: SHA256_HEX_REGEX },
  },
  recommendation_fingerprint: {
    type:      DataTypes.STRING(64),
    allowNull: false,
    validate:  { is: SHA256_HEX_REGEX },
  },

  persistent_policy_version: {
    type:      DataTypes.STRING(30),
    allowNull: false,
    validate:  { notEmpty: true },
  },
  recommendation_policy_version: {
    type:      DataTypes.STRING(30),
    allowNull: false,
    validate:  { notEmpty: true },
  },
  mapping_version: {
    type:      DataTypes.STRING(30),
    allowNull: false,
    validate:  { notEmpty: true },
  },

  created_at: {
    type:         DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName:       'teacher_recommendation_validations',
  // No updated_at — this table is append-only by design, not just by
  // convention (Step 3 spec §23/§24). `timestamps: false` plus the explicit
  // `created_at` field above means Sequelize manages neither timestamp
  // itself; `created_at` is set once, at row-creation time, by its own
  // defaultValue.
  timestamps:      false,
  freezeTableName: true,
  indexes: [
    { fields: ['student_id', 'created_at'] },
    { fields: ['student_id', 'case_type', 'family', 'created_at'] },
    {
      name:   'teacher_recommendation_validations_idempotency_uniq',
      fields: ['student_id', 'teacher_id', 'case_type', 'family', 'validation', 'recommendation_fingerprint'],
      unique: true,
    },
  ],
});

module.exports = TeacherRecommendationValidation;
module.exports.CASE_TYPE_VALUES = CASE_TYPE_VALUES;
module.exports.FAMILY_VALUES = FAMILY_VALUES;
module.exports.VALIDATION_VALUES = VALIDATION_VALUES;
module.exports.RECOMMENDATION_TYPE_VALUES = RECOMMENDATION_TYPE_VALUES;
module.exports.MAX_TEACHER_NOTE_LENGTH = MAX_TEACHER_NOTE_LENGTH;
