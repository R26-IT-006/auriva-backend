'use strict';

// student_activities gains an activity_type, so the card-game activities
// (pair match, memory) can keep their own history and their own coverage
// without consuming the mixed practice activity's uncovered concept pool.
//
// Also relaxes three columns to nullable. They describe a round-based activity —
// its ladder level, its round shape signature, its frozen question plan and
// round count — and a card game has none of those. Writing a placeholder would
// leave rows that read as real practice activities to anything inspecting them.
//
// Idempotent throughout — safe to re-run.
const TABLE  = 'student_activities';
const COLUMN = 'activity_type';
const ENUM   = 'enum_student_activities_activity_type';
const INDEX  = 'student_activities_student_id_category_key_activity_type';

async function columnExists(queryInterface, table, column) {
  const description = await queryInterface.describeTable(table);
  return Object.prototype.hasOwnProperty.call(description, column);
}

module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await columnExists(queryInterface, TABLE, COLUMN))) {
      await queryInterface.addColumn(TABLE, COLUMN, {
        type: Sequelize.ENUM('practice', 'pair_match', 'memory'),
        allowNull: false,
        defaultValue: 'practice',
      });

      // Every row that predates this column is a mixed practice activity. The
      // column default covers new rows; this covers the ones already there.
      await queryInterface.sequelize.query(
        `UPDATE ${TABLE} SET ${COLUMN} = 'practice' WHERE ${COLUMN} IS NULL`,
      );
    }

    // Nullable only in the "was NOT NULL" direction — changeColumn is safe to
    // repeat, so no existence check is needed here.
    await queryInterface.changeColumn(TABLE, 'difficulty_level', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.changeColumn(TABLE, 'signature', {
      type: Sequelize.STRING(120),
      allowNull: true,
    });
    await queryInterface.changeColumn(TABLE, 'question_plan', {
      type: Sequelize.JSONB,
      allowNull: true,
    });
    await queryInterface.changeColumn(TABLE, 'total_rounds', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });

    const indexes = await queryInterface.showIndex(TABLE);
    if (!indexes.some((i) => i.name === INDEX)) {
      await queryInterface.addIndex(TABLE, ['student_id', 'category_key', COLUMN], {
        name: INDEX,
      });
    }
  },

  async down(queryInterface, Sequelize) {
    const indexes = await queryInterface.showIndex(TABLE);
    if (indexes.some((i) => i.name === INDEX)) {
      await queryInterface.removeIndex(TABLE, INDEX);
    }

    if (await columnExists(queryInterface, TABLE, COLUMN)) {
      await queryInterface.removeColumn(TABLE, COLUMN);
      // Postgres keeps the enum type behind after the column goes.
      await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "${ENUM}"`);
    }

    // Deliberately not restoring the NOT NULL constraints: any card-game row
    // written since this migration ran would have nulls in them, and failing the
    // rollback on that data is worse than leaving the columns permissive.
  },
};
