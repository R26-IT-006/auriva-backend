'use strict';

// Pre-writing warm-up activities (motor-primitive practice shown before a
// letter set, see frontend constants/preWritingActivities.js) store their
// results as shape_features rows too — same shape-tracing template/DTW
// mechanism as the initial 6-shape assessment. Unlike that assessment,
// warm-ups have no handwriting_assessments parent (that table is specific
// to the one-time initial battery: is_initial flag, required shapes JSON,
// and it feeds student_motor_features). So assessment_id must become
// optional, and `source` distinguishes which population a row belongs to
// for any future query against this table.

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('shape_features', 'assessment_id', {
      type:      Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addColumn('shape_features', 'source', {
      type:         Sequelize.STRING(30),
      allowNull:    false,
      defaultValue: 'initial_assessment',
    });
    await queryInterface.addIndex('shape_features', ['source'], { name: 'shape_features_source_idx' });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex('shape_features', 'shape_features_source_idx');
    await queryInterface.removeColumn('shape_features', 'source');
    await queryInterface.changeColumn('shape_features', 'assessment_id', {
      type:      Sequelize.INTEGER,
      allowNull: false,
    });
  },
};
