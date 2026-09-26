'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('shape_features', {
      id: {
        type:          Sequelize.INTEGER,
        primaryKey:    true,
        autoIncrement: true,
      },
      // No FK constraints — tables were created via sequelize.sync(); integrity
      // is enforced at the application layer (assessment must exist before bulkCreate).
      assessment_id: {
        type:      Sequelize.INTEGER,
        allowNull: false,
      },
      student_id: {
        type:      Sequelize.INTEGER,
        allowNull: false,
      },
      // shape_id string (e.g. 'horizontal_line') — VARCHAR avoids enum type management
      shape_type: {
        type:      Sequelize.STRING(50),
        allowNull: false,
      },
      // always 1 for initial assessments; >1 reserved for future retake support
      attempt_number: {
        type:         Sequelize.INTEGER,
        allowNull:    false,
        defaultValue: 1,
      },
      // full features object: {duration_ms, total_distance, avg_speed, smoothness, pause_count, accuracy}
      features: {
        type:         Sequelize.JSONB,
        allowNull:    false,
        defaultValue: {},
      },
      // array of {stroke_id, points:[{x,y,t,tAbs,stroke_id}]} — raw pen data for each stroke
      stroke_points: {
        type:         Sequelize.JSONB,
        allowNull:    false,
        defaultValue: [],
      },
      created_at: {
        type:         Sequelize.DATE,
        defaultValue: Sequelize.fn('NOW'),
      },
    });

    await queryInterface.addIndex('shape_features', ['assessment_id'], { name: 'shape_features_assessment_id_idx' });
    await queryInterface.addIndex('shape_features', ['student_id'],    { name: 'shape_features_student_id_idx' });
    await queryInterface.addIndex('shape_features', ['shape_type'],    { name: 'shape_features_shape_type_idx' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('shape_features');
  },
};
