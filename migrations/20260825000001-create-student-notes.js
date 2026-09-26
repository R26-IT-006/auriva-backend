'use strict';

// Teacher reminders/notes about a particular student. One row per note, newest
// first — a teacher's running scratchpad for one child, not a shared journal.
const TABLE = 'student_notes';

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
      teacher_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'teachers', key: 'tid' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      body: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    // Notes are always read newest-first for one student.
    await queryInterface.addIndex(TABLE, ['student_id', 'created_at'], {
      name: 'student_notes_student_id_created_at',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable(TABLE);
  },
};
