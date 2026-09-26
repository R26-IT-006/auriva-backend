'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('letter_attempts', {
      id: {
        type:          Sequelize.INTEGER,
        primaryKey:    true,
        autoIncrement: true,
      },
      // No FK constraint — table was created via sequelize.sync(); integrity
      // is enforced at the application layer.
      student_id: {
        type:      Sequelize.INTEGER,
        allowNull: false,
      },
      letter: {
        type:      Sequelize.CHAR(1),
        allowNull: false,
      },
      // VARCHAR avoids PostgreSQL enum-type management complexity on rollback
      case_type: {
        type:      Sequelize.STRING(10),
        allowNull: false,
      },
      // Groups all attempt rows that arrived in one POST call so ML can
      // reconstruct "one session = N attempts" even across multiple failures.
      session_key: {
        type:      Sequelize.UUID,
        allowNull: false,
      },
      // attempt_number as sent by the client (1–3 within the session)
      attempt_number: {
        type:         Sequelize.INTEGER,
        allowNull:    false,
        defaultValue: 1,
      },
      // true if bestScore >= threshold for this POST call; false on quality block
      passed: {
        type:      Sequelize.BOOLEAN,
        allowNull: false,
      },
      // bestScore / threshold at the time of this POST call — shared across rows
      // that belong to the same session (they all have the same scores)
      best_score: {
        type:      Sequelize.FLOAT,
        allowNull: true,
      },
      threshold: {
        type:      Sequelize.FLOAT,
        allowNull: true,
      },
      // per-attempt features: {smoothness, pauseCount, completionTime, strokeCount, dtw_distance}
      features: {
        type:      Sequelize.JSONB,
        allowNull: true,
      },
      // per-attempt raw strokes: [{stroke_id, points:[{x,y,t,tAbs,stroke_id}]}]
      stroke_points: {
        type:      Sequelize.JSONB,
        allowNull: true,
      },
      created_at: {
        type:         Sequelize.DATE,
        defaultValue: Sequelize.fn('NOW'),
      },
    });

    await queryInterface.addIndex(
      'letter_attempts',
      ['student_id', 'letter', 'case_type'],
      { name: 'letter_attempts_student_letter_case_idx' }
    );
    await queryInterface.addIndex(
      'letter_attempts',
      ['session_key'],
      { name: 'letter_attempts_session_key_idx' }
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('letter_attempts');
  },
};
