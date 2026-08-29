'use strict';

// Tier 3 colouring artwork: the finished picture the child coloured, captured as
// a PNG and stored in blob storage. One row per completed colouring, so the same
// concept coloured on two different days keeps both.
//
// Idempotent — safe to re-run if the table happens to exist already.
const TABLE = 'coloring_artworks';

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
      student_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'students', key: 'sid' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      category_key: {
        type: Sequelize.STRING(60),
        allowNull: false,
      },
      concept_key: {
        type: Sequelize.STRING(60),
        allowNull: false,
      },
      image_url: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      stroke_count: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      time_spent_ms: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    // The gallery reads newest-first for one student, which is the only query
    // this table serves.
    await queryInterface.addIndex(TABLE, ['student_id', 'created_at'], {
      name: 'coloring_artworks_student_id_created_at',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable(TABLE);
  },
};
