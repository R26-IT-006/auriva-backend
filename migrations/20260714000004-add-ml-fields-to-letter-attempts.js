'use strict';

// Same column set as shape_features (20260714000003) minus threshold/passed,
// which already exist on this table from its original migration.
//
// Idempotent by design — see 20260714000002 for why: sync({ alter: true })
// may have already created some of these columns/indexes directly from the
// LetterAttempt model before this migration ever ran.
async function columnExists(queryInterface, table, column) {
  const description = await queryInterface.describeTable(table);
  return Object.prototype.hasOwnProperty.call(description, column);
}

async function indexExists(queryInterface, Sequelize, table, indexName) {
  const rows = await queryInterface.sequelize.query(
    'SELECT indexname FROM pg_indexes WHERE tablename = :table AND indexname = :indexName',
    { replacements: { table, indexName }, type: Sequelize.QueryTypes.SELECT }
  );
  return rows.length > 0;
}

const TABLE = 'letter_attempts';
const COLUMN_NAMES = [
  'collection_session_id', 'protocol_version', 'task_order', 'capture_status',
  'canvas_width', 'canvas_height', 'device_type', 'app_version',
  'feature_version', 'template_version', 'normalized_features', 'feature_validity',
  'motor_score', 'quality_score', 'score_version', 'collection_accepted',
  'threshold_passed',
];
const INDEXES = [
  { name: 'letter_attempts_collection_session_id_idx', fields: ['collection_session_id'] },
  { name: 'letter_attempts_capture_status_idx',         fields: ['capture_status'] },
];

module.exports = {
  async up(queryInterface, Sequelize) {
    const columns = {
      collection_session_id: { type: Sequelize.UUID,      allowNull: true },
      protocol_version:      { type: Sequelize.STRING(20), allowNull: true },
      task_order:            { type: Sequelize.INTEGER,    allowNull: true },
      capture_status:        { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'complete' },
      canvas_width:           { type: Sequelize.INTEGER,    allowNull: true },
      canvas_height:          { type: Sequelize.INTEGER,    allowNull: true },
      device_type:            { type: Sequelize.STRING(20), allowNull: true },
      app_version:            { type: Sequelize.STRING(20), allowNull: true },
      feature_version:        { type: Sequelize.STRING(20), allowNull: true },
      template_version:       { type: Sequelize.STRING(20), allowNull: true },
      normalized_features:    { type: Sequelize.JSONB,      allowNull: true },
      feature_validity:       { type: Sequelize.JSONB,      allowNull: true },
      motor_score:            { type: Sequelize.FLOAT,      allowNull: true },
      quality_score:          { type: Sequelize.FLOAT,      allowNull: true },
      score_version:          { type: Sequelize.STRING(20), allowNull: true },
      // true once the row is successfully captured & saved — NOT a quality
      // label; see the existing `passed`/new `threshold_passed` columns for
      // the real quality signal.
      collection_accepted:    { type: Sequelize.BOOLEAN,    allowNull: false, defaultValue: true },
      // Real bestScore >= threshold comparison, computed in BOTH normal and
      // collection mode. In collection mode this is never used to block —
      // it's purely a label for ML/analysis, unlike the existing `passed`
      // column (which in collection mode is always true, meaning "captured").
      threshold_passed:       { type: Sequelize.BOOLEAN,    allowNull: true },
    };

    for (const [name, def] of Object.entries(columns)) {
      if (!(await columnExists(queryInterface, TABLE, name))) {
        await queryInterface.addColumn(TABLE, name, def);
      }
    }

    for (const { name, fields } of INDEXES) {
      if (!(await indexExists(queryInterface, Sequelize, TABLE, name))) {
        await queryInterface.addIndex(TABLE, fields, { name });
      }
    }
  },

  async down(queryInterface, Sequelize) {
    for (const { name } of INDEXES) {
      if (await indexExists(queryInterface, Sequelize, TABLE, name)) {
        await queryInterface.removeIndex(TABLE, name);
      }
    }

    for (const name of COLUMN_NAMES) {
      if (await columnExists(queryInterface, TABLE, name)) {
        await queryInterface.removeColumn(TABLE, name);
      }
    }
  },
};
