'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const { LETTER_SUPPORT_LEVELS } = require('../config/letterSupportLevels');

const LetterAttempt = sequelize.define('LetterAttempt', {
  id: {
    type:          DataTypes.INTEGER,
    primaryKey:    true,
    autoIncrement: true,
  },
  student_id: {
    type:      DataTypes.INTEGER,
    allowNull: false,
  },
  letter: {
    type:      DataTypes.CHAR(1),
    allowNull: false,
  },
  case_type: {
    type:      DataTypes.ENUM('lowercase', 'uppercase'),
    allowNull: false,
  },
  // UUID generated on the backend once per POST call; groups all attempt rows
  // from the same session so ML can reconstruct full session history.
  session_key: {
    type:      DataTypes.UUID,
    allowNull: false,
  },
  // attempt_number as sent by the client (1–3 within the session)
  attempt_number: {
    type:         DataTypes.INTEGER,
    allowNull:    false,
    defaultValue: 1,
  },
  // true when bestScore >= threshold for this call; false on quality block
  passed: {
    type:      DataTypes.BOOLEAN,
    allowNull: false,
  },
  best_score: {
    type:      DataTypes.FLOAT,
    allowNull: true,
  },
  threshold: {
    type:      DataTypes.FLOAT,
    allowNull: true,
  },
  // per-attempt features: {smoothness, pauseCount, completionTime, strokeCount, dtw_distance}
  features: {
    type:      DataTypes.JSONB,
    allowNull: true,
  },
  // per-attempt raw strokes: [{stroke_id, points:[{x,y,t,tAbs,stroke_id}]}]
  stroke_points: {
    type:      DataTypes.JSONB,
    allowNull: true,
  },
  // Feature 3 Step 3 — per-attempt support level as actually RENDERED by the
  // frontend for this specific attempt ('high'|'medium'|'low' — see
  // src/config/letterSupportLevels.js and the frontend's
  // constants/handwritingSupportLevels.js, Feature 3 Step 2). Genuinely
  // per-attempt, like `features` above — never a session-level value copied
  // across a session's rows (see saveLetterAttempts() in
  // handwritingController.js, which reads it from each attempt's own
  // payload object, never from a session-level field).
  //
  // Nullable by design and NEVER backfilled: rows saved before this column
  // existed, and any row whose client omitted or sent an invalid value,
  // simply have support_level = null — never a guessed value derived from
  // attempt_number. See the Feature 3 Step 1 audit for why attempt_number
  // cannot safely stand in for support_level (collection-mode attempt 3's
  // presentation does not match either 'medium' or a bare 'no support'
  // case), and the migration's header comment for the historical-row policy.
  //
  // DATA CAPTURE ONLY as of Step 3 — nothing in this codebase reads this
  // column to make an adaptive decision yet.
  //
  // Deliberately a plain VARCHAR + application-level `isIn` validation
  // rather than a native PostgreSQL ENUM: matches this column's own
  // `case_type`/`capture_status` siblings only loosely — those two DO use
  // DataTypes.ENUM — but a native enum type is more expensive to alter later
  // (adding a 4th support tier, should one ever be needed, requires an
  // `ALTER TYPE ... ADD VALUE` migration outside a transaction on some PG
  // versions) and Feature 3's own vocabulary is still young; a plain string
  // with the SAME validation enforced at the model layer keeps rollback and
  // future vocabulary changes simple. Revisit only if this column's shape
  // proves genuinely stable long-term.
  support_level: {
    type:      DataTypes.STRING(10),
    allowNull: true,
    validate: {
      isIn: [LETTER_SUPPORT_LEVELS],
    },
  },
  // true when this row was recorded during a fixed research protocol session
  collection_mode: {
    type:         DataTypes.BOOLEAN,
    allowNull:    false,
    defaultValue: false,
  },

  // ── Collection-session tracking ────────────────────────────────────────────
  collection_session_id: { type: DataTypes.UUID,       allowNull: true },
  protocol_version:      { type: DataTypes.STRING(20), allowNull: true },
  task_order:            { type: DataTypes.INTEGER,    allowNull: true },
  capture_status: {
    type:         DataTypes.ENUM('complete', 'incomplete', 'abandoned', 'network_failed'),
    allowNull:    false,
    defaultValue: 'complete',
  },

  // ── Device / capture metadata ──────────────────────────────────────────────
  canvas_width:     { type: DataTypes.INTEGER,    allowNull: true },
  canvas_height:    { type: DataTypes.INTEGER,    allowNull: true },
  device_type:      { type: DataTypes.STRING(20), allowNull: true },
  app_version:      { type: DataTypes.STRING(20), allowNull: true },
  feature_version:  { type: DataTypes.STRING(20), allowNull: true },
  template_version: { type: DataTypes.STRING(20), allowNull: true },
  // dtw_norm_v1 — see frontend utils/dtwNormalization.js. Which coordinate
  // normalization method produced this row's dtw_distance.
  normalization_version: { type: DataTypes.STRING(20), allowNull: true },

  // ── ML-normalized features + score (see src/utils/featureNormalization.js,
  //    src/utils/motorScore.js). `features` above is left untouched (raw, as
  //    sent by the client) for backward compatibility. ─────────────────────
  normalized_features: { type: DataTypes.JSONB, allowNull: true },
  feature_validity:    { type: DataTypes.JSONB, allowNull: true },
  motor_score:         { type: DataTypes.FLOAT, allowNull: true },
  quality_score:       { type: DataTypes.FLOAT, allowNull: true },
  score_version:       { type: DataTypes.STRING(20), allowNull: true },

  // ── Collection acceptance vs. quality ──────────────────────────────────────
  // `passed` (above) keeps its exact original meaning — untouched.
  // `collection_accepted` = row was captured & saved successfully (always
  // true once the row exists); NEVER use this as an ML quality label.
  // `threshold_passed` = the real bestScore >= threshold comparison,
  // computed in both modes but only used to gate/block in normal mode.
  collection_accepted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  threshold_passed:    { type: DataTypes.BOOLEAN, allowNull: true },

  // Flat, queryable copy of normalized_features.stroke_order_meta
  // .strokeOrderMatchesTemplate (multi-stroke letters only — see
  // computeMultiStrokeDTW in the frontend's utils/dtw.js). Null when no
  // stroke-order comparison was possible (single-stroke letter/template).
  stroke_order_matches_template: { type: DataTypes.BOOLEAN, allowNull: true },

  created_at: {
    type:         DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName:       'letter_attempts',
  timestamps:      false,
  freezeTableName: true,
  indexes: [
    { fields: ['student_id', 'letter', 'case_type'] },
    { fields: ['session_key'] },
    { fields: ['collection_session_id'] },
    { fields: ['capture_status'] },
  ],
});

module.exports = LetterAttempt;
