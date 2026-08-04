'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('collection_sessions', {
      // Generated client-side (UUID v4) when a teacher starts Data Collection Mode,
      // so it's known before the first shape/letter POST is ever sent.
      id: {
        type:         Sequelize.UUID,
        primaryKey:   true,
        allowNull:    false,
      },
      // No FK constraint — matches existing convention in this schema
      // (letter_attempts, shape_features); integrity enforced at the app layer.
      student_id: {
        type:      Sequelize.INTEGER,
        allowNull: false,
      },
      protocol_version: {
        type:      Sequelize.STRING(20),
        allowNull: true,
      },
      device_type: {
        type:      Sequelize.STRING(20),
        allowNull: true,
      },
      app_version: {
        type:      Sequelize.STRING(20),
        allowNull: true,
      },
      // VARCHAR (not a native Postgres enum) — same rationale as case_type on
      // letter_attempts: avoids enum-type management complexity on rollback.
      // Values: in_progress | complete | incomplete | abandoned | network_failed
      capture_status: {
        type:         Sequelize.STRING(20),
        allowNull:    false,
        defaultValue: 'in_progress',
      },
      started_at: {
        type:         Sequelize.DATE,
        defaultValue: Sequelize.fn('NOW'),
      },
      completed_at: {
        type:      Sequelize.DATE,
        allowNull: true,
      },
      created_at: {
        type:         Sequelize.DATE,
        defaultValue: Sequelize.fn('NOW'),
      },
    });

    await queryInterface.addIndex('collection_sessions', ['student_id'],      { name: 'collection_sessions_student_id_idx' });
    await queryInterface.addIndex('collection_sessions', ['capture_status'],  { name: 'collection_sessions_capture_status_idx' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('collection_sessions');
  },
};
