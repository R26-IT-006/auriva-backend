'use strict';

const sequelize = require('../config/database');
const logger    = require('./logger');

// Drops any existing FK constraints on the Cat3 tables' word_id column so that
// sequelize.sync({ alter: true }) can recreate them pointing at dialogue_words(id).
// Safe to run multiple times — all statements use IF EXISTS.

const DROP_STMTS = [
  `ALTER TABLE action_word_progress
     DROP CONSTRAINT IF EXISTS action_word_progress_word_id_fkey`,
  `ALTER TABLE action_word_attempts
     DROP CONSTRAINT IF EXISTS action_word_attempts_word_id_fkey`,
  `ALTER TABLE can_you_game_rounds
     DROP CONSTRAINT IF EXISTS can_you_game_rounds_word_id_fkey`,
  `ALTER TABLE action_identification_rounds
     DROP CONSTRAINT IF EXISTS action_identification_rounds_word_id_fkey`,
  `ALTER TABLE verb_qa_production_rounds
     DROP CONSTRAINT IF EXISTS verb_qa_production_rounds_word_id_fkey`,
];

async function fixCat3ForeignKeys() {
  for (const sql of DROP_STMTS) {
    try {
      await sequelize.query(sql);
    } catch (err) {
      logger.warn(`fixCat3ForeignKeys: could not run "${sql.trim().split('\n')[0]}" — ${err.message}`);
    }
  }
  logger.info('fixCat3ForeignKeys: stale FK constraints cleared');
}

module.exports = fixCat3ForeignKeys;
