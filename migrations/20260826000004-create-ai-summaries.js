'use strict';

// Cache for LLM-generated teacher summaries. One row per (scope, subject, input
// hash) — the analytics payloads that feed the model are deterministic, so the
// hash is a complete cache key and a hit means the data has not moved.
const TABLE = 'ai_summaries';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.map(String).includes(TABLE)) return;

    await queryInterface.createTable(TABLE, {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      scope: {
        type: Sequelize.STRING(40),
        allowNull: false,
      },
      // No FK: this points at students.sid or teachers.tid depending on scope,
      // so any single constraint would be wrong half the time.
      subject_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      input_hash: {
        type: Sequelize.STRING(64),
        allowNull: false,
      },
      model: {
        type: Sequelize.STRING(80),
        allowNull: false,
      },
      payload: {
        type: Sequelize.JSONB,
        allowNull: false,
      },
      generated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    // The only read path is an exact cache lookup on all three.
    await queryInterface.addIndex(TABLE, ['scope', 'subject_id', 'input_hash'], {
      name: 'ai_summaries_scope_subject_hash',
      unique: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable(TABLE);
  },
};
