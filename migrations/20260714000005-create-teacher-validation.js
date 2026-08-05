'use strict';

// Idempotent by design — same root cause as 20260714000002/3/4: the
// TeacherValidation model is also new, so sync({ alter: true }) (called on
// every server boot) may have already created this table before this
// migration ever ran.
async function tableExists(queryInterface, table) {
  const tables = await queryInterface.showAllTables();
  return tables.map(t => (typeof t === 'string' ? t : t.tableName)).includes(table);
}

async function indexExists(queryInterface, Sequelize, table, indexName) {
  const rows = await queryInterface.sequelize.query(
    'SELECT indexname FROM pg_indexes WHERE tablename = :table AND indexname = :indexName',
    { replacements: { table, indexName }, type: Sequelize.QueryTypes.SELECT }
  );
  return rows.length > 0;
}

const TABLE = 'teacher_validation';
const INDEXES = [
  { name: 'teacher_validation_student_id_idx',            fields: ['student_id'] },
  { name: 'teacher_validation_collection_session_id_idx', fields: ['collection_session_id'] },
];

module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface, TABLE))) {
      await queryInterface.createTable(TABLE, {
        id: {
          type:          Sequelize.INTEGER,
          primaryKey:    true,
          autoIncrement: true,
        },
        student_id: {
          type:      Sequelize.INTEGER,
          allowNull: false,
        },
        collection_session_id: {
          type:      Sequelize.UUID,
          allowNull: false,
        },
        // Rating scale: 1 = Weak, 2 = Moderate, 3 = Good. Nullable — a teacher
        // may skip a dimension that doesn't apply to that session.
        teacher_straight_rating: { type: Sequelize.SMALLINT, allowNull: true },
        teacher_curve_rating:    { type: Sequelize.SMALLINT, allowNull: true },
        teacher_complex_rating:  { type: Sequelize.SMALLINT, allowNull: true },
        teacher_speed_rating:    { type: Sequelize.SMALLINT, allowNull: true },
        teacher_fatigue_rating:  { type: Sequelize.SMALLINT, allowNull: true },
        teacher_overall_rating:  { type: Sequelize.SMALLINT, allowNull: true },
        teacher_notes: {
          type:      Sequelize.TEXT,
          allowNull: true,
        },
        teacher_validated: {
          type:         Sequelize.BOOLEAN,
          allowNull:    false,
          defaultValue: false,
        },
        validated_at: {
          type:      Sequelize.DATE,
          allowNull: true,
        },
        created_at: {
          type:         Sequelize.DATE,
          defaultValue: Sequelize.fn('NOW'),
        },
      });
    }

    for (const { name, fields } of INDEXES) {
      if (!(await indexExists(queryInterface, Sequelize, TABLE, name))) {
        await queryInterface.addIndex(TABLE, fields, { name });
      }
    }
  },

  async down(queryInterface, Sequelize) {
    // Table-level down still drops the table (this table has no pre-existing
    // production data to protect — it's brand new). Indexes are dropped
    // implicitly with it, so no separate removeIndex calls are needed here.
    if (await tableExists(queryInterface, TABLE)) {
      await queryInterface.dropTable(TABLE);
    }
  },
};
