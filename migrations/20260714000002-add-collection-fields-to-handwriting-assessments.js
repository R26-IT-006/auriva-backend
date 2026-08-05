'use strict';

// Idempotent by design: the models for this table were updated with these
// same columns before these migrations were ever run, so
// sequelize.sync({ alter: true }) (called on every server boot, see
// index.js) may have already created some of them directly from the model
// definitions. Every add/remove below checks current state first so this
// migration is safe to run (or re-run) regardless of what sync already did.
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

const TABLE = 'handwriting_assessments';
const INDEX_NAME = 'handwriting_assessments_collection_session_id_idx';

module.exports = {
  async up(queryInterface, Sequelize) {
    const columns = {
      collection_session_id: { type: Sequelize.UUID,      allowNull: true },
      protocol_version:      { type: Sequelize.STRING(20), allowNull: true },
      task_order:            { type: Sequelize.INTEGER,    allowNull: true },
      // VARCHAR, not a native enum — see collection_sessions migration for rationale.
      capture_status:        { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'complete' },
    };

    for (const [name, def] of Object.entries(columns)) {
      if (!(await columnExists(queryInterface, TABLE, name))) {
        await queryInterface.addColumn(TABLE, name, def);
      }
    }

    if (!(await indexExists(queryInterface, Sequelize, TABLE, INDEX_NAME))) {
      await queryInterface.addIndex(TABLE, ['collection_session_id'], { name: INDEX_NAME });
    }
  },

  async down(queryInterface, Sequelize) {
    if (await indexExists(queryInterface, Sequelize, TABLE, INDEX_NAME)) {
      await queryInterface.removeIndex(TABLE, INDEX_NAME);
    }

    const columnNames = ['collection_session_id', 'protocol_version', 'task_order', 'capture_status'];
    for (const name of columnNames) {
      if (await columnExists(queryInterface, TABLE, name)) {
        await queryInterface.removeColumn(TABLE, name);
      }
    }
  },
};
