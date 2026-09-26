'use strict';

// Column set is intentionally identical to the letter_attempts migration
// (20260714000004) so both tables can feed the handwriting_ml_samples view
// with matching shapes. threshold/threshold_passed are nullable here since
// shapes have no quality-gating concept today — left honestly NULL rather
// than fabricated.
//
// Idempotent by design — see 20260714000002 for why: sync({ alter: true })
// may have already created some of these columns/indexes directly from the
// ShapeFeature model before this migration ever ran.
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

const TABLE = 'shape_features';
const COLUMN_NAMES = [
  'collection_session_id', 'protocol_version', 'task_order', 'capture_status',
  'canvas_width', 'canvas_height', 'device_type', 'app_version',
  'feature_version', 'template_version', 'normalized_features', 'feature_validity',
  'motor_score', 'quality_score', 'score_version', 'collection_accepted',
  'threshold', 'threshold_passed',
];
const INDEXES = [
  { name: 'shape_features_collection_session_id_idx', fields: ['collection_session_id'] },
  { name: 'shape_features_capture_status_idx',         fields: ['capture_status'] },
];

module.exports = {
  async up(queryInterface, Sequelize) {
    const columns = {
      collection_session_id: { type: Sequelize.UUID,      allowNull: true },
      protocol_version:      { type: Sequelize.STRING(20), allowNull: true },
      task_order:            { type: Sequelize.INTEGER,    allowNull: true },
      // VARCHAR, not a native enum — see collection_sessions migration for rationale.
      capture_status:        { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'complete' },
      canvas_width:           { type: Sequelize.INTEGER,    allowNull: true },
      canvas_height:          { type: Sequelize.INTEGER,    allowNull: true },
      device_type:            { type: Sequelize.STRING(20), allowNull: true },
      app_version:            { type: Sequelize.STRING(20), allowNull: true },
      feature_version:        { type: Sequelize.STRING(20), allowNull: true },
      template_version:       { type: Sequelize.STRING(20), allowNull: true },
      // Canonical 10-field ML schema (see src/utils/featureNormalization.js)
      normalized_features:    { type: Sequelize.JSONB,      allowNull: true },
      // { duration_ms: bool, total_distance: bool, ... } — which normalized
      // fields were actually derivable from the raw payload.
      feature_validity:       { type: Sequelize.JSONB,      allowNull: true },
      motor_score:            { type: Sequelize.FLOAT,      allowNull: true },
      quality_score:          { type: Sequelize.FLOAT,      allowNull: true },
      score_version:          { type: Sequelize.STRING(20), allowNull: true },
      // true once the row is successfully captured & saved — NOT a quality label.
      collection_accepted:    { type: Sequelize.BOOLEAN,    allowNull: false, defaultValue: true },
      threshold:              { type: Sequelize.FLOAT,      allowNull: true },
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
