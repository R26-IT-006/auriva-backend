'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('students', 'personal_thresholds', {
      type:         Sequelize.JSONB,
      allowNull:    false,
      defaultValue: {},
    });
    await queryInterface.addColumn('letter_progress', 'blocked_attempts', {
      type:         Sequelize.INTEGER,
      allowNull:    false,
      defaultValue: 0,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('students',       'personal_thresholds');
    await queryInterface.removeColumn('letter_progress', 'blocked_attempts');
  },
};
