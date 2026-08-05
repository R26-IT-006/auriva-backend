'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // ── letter_attempts ──────────────────────────────────────────────────────
    await queryInterface.addColumn('letter_attempts', 'collection_mode', {
      type:         Sequelize.BOOLEAN,
      allowNull:    false,
      defaultValue: false,
    });
    await queryInterface.addIndex(
      'letter_attempts',
      ['collection_mode'],
      { name: 'letter_attempts_collection_mode_idx' }
    );

    // ── shape_features ───────────────────────────────────────────────────────
    await queryInterface.addColumn('shape_features', 'collection_mode', {
      type:         Sequelize.BOOLEAN,
      allowNull:    false,
      defaultValue: false,
    });
    await queryInterface.addIndex(
      'shape_features',
      ['collection_mode'],
      { name: 'shape_features_collection_mode_idx' }
    );

    // ── handwriting_assessments ──────────────────────────────────────────────
    await queryInterface.addColumn('handwriting_assessments', 'collection_mode', {
      type:         Sequelize.BOOLEAN,
      allowNull:    false,
      defaultValue: false,
    });
    await queryInterface.addIndex(
      'handwriting_assessments',
      ['collection_mode'],
      { name: 'handwriting_assessments_collection_mode_idx' }
    );
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('letter_attempts',          'collection_mode');
    await queryInterface.removeColumn('shape_features',           'collection_mode');
    await queryInterface.removeColumn('handwriting_assessments',  'collection_mode');
  },
};
