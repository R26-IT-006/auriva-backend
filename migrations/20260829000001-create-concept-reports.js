'use strict';

// Frozen concept reports — one row per child per named period. See
// src/models/ConceptReport.js for why the derived figures are stored rather than
// recomputed on read.
const TABLE = 'concept_reports';

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
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      // No FK. A report should outlive the teacher account that produced it —
      // staff change between terms, and losing a child's history with them would
      // be worse than losing the provenance.
      teacher_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      period_type: {
        type: Sequelize.STRING(10),
        allowNull: false,
      },
      // DATEONLY: these are local calendar days in the school's timezone. Stored
      // as timestamps they would drift by the UTC offset and a report could end
      // up labelled with the wrong month.
      period_start: {
        type: Sequelize.DATEONLY,
        allowNull: false,
      },
      period_end: {
        type: Sequelize.DATEONLY,
        allowNull: false,
      },
      schema_version: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 1,
      },
      payload: {
        type: Sequelize.JSONB,
        allowNull: false,
      },
      narrative: {
        type: Sequelize.JSONB,
        allowNull: true,
      },
      headline: {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: {},
      },
      generated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    // Regenerating a period must replace it, not add a second row for the same
    // seven days that differs only by when the button was pressed.
    await queryInterface.addIndex(TABLE, ['student_id', 'period_type', 'period_start'], {
      name: 'concept_reports_student_period',
      unique: true,
    });

    // The only listing path: one child's archive, newest first.
    await queryInterface.addIndex(TABLE, ['student_id', 'period_start'], {
      name: 'concept_reports_student_start',
    });

    // period_type is a two-value set and belongs in the schema, not only in the
    // model's validate block — a bad write from anywhere should fail loudly.
    await queryInterface.sequelize.query(
      `ALTER TABLE ${TABLE}
         ADD CONSTRAINT concept_reports_period_type_chk
         CHECK (period_type IN ('week','month'))`,
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable(TABLE);
  },
};
