'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('letter_progress', 'attempt_data', {
      type:      Sequelize.JSONB,
      allowNull: true,   // null on old rows — old clients never send this field
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('letter_progress', 'attempt_data');
  },
};
