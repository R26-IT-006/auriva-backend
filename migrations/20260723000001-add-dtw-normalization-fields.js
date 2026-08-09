'use strict';

// DTW research-safety pass: adds the two ML fields not already covered by
// 20260714000003/000004 —
//   normalization_version    — which coordinate-normalization method
//                               (see frontend utils/dtwNormalization.js,
//                               currently 'dtw_norm_v1') produced this row's
//                               dtw_distance. Sent alongside the existing
//                               feature_version/template_version metadata.
//   stroke_order_matches_template — flat, queryable boolean extracted from
//                               normalized_features.stroke_order_meta (the
//                               full object stays in the JSONB column for
//                               debug/ML detail; this column exists so SQL
//                               can filter/aggregate on it directly without
//                               reaching into JSONB).
// Both are nullable: null means "not available for this row" (e.g. rows
// captured before this migration, or shapes/single-stroke letters that have
// no stroke-order concept), never a fabricated value.
//
// Applied to both shape_features and letter_attempts so the two tables keep
// a matching ML column set (see 20260714000003's header for why), even
// though shapes never populate stroke_order_matches_template today.
//
// Idempotent by design — see 20260714000002 for why.
async function columnExists(queryInterface, table, column) {
  const description = await queryInterface.describeTable(table);
  return Object.prototype.hasOwnProperty.call(description, column);
}

const TABLES = ['shape_features', 'letter_attempts'];
const COLUMN_NAMES = ['normalization_version', 'stroke_order_matches_template'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const columns = {
      normalization_version:         { type: Sequelize.STRING(20), allowNull: true },
      stroke_order_matches_template: { type: Sequelize.BOOLEAN,    allowNull: true },
    };

    for (const table of TABLES) {
      for (const [name, def] of Object.entries(columns)) {
        if (!(await columnExists(queryInterface, table, name))) {
          await queryInterface.addColumn(table, name, def);
        }
      }
    }
  },

  async down(queryInterface, Sequelize) {
    for (const table of TABLES) {
      for (const name of COLUMN_NAMES) {
        if (await columnExists(queryInterface, table, name)) {
          await queryInterface.removeColumn(table, name);
        }
      }
    }
  },
};
