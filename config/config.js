'use strict';

// Connection settings for sequelize-cli (migrations). Deliberately reads the
// same .env the app does and mirrors src/config/database.js — two sources of
// truth for one database is how a migration ends up run against the wrong host.
require('dotenv').config();

const base = {
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  host:     process.env.DB_HOST,
  port:     parseInt(process.env.DB_PORT, 10),
  dialect:  'postgres',
  dialectOptions: {
    ssl: {
      require: true,
      rejectUnauthorized: false, // Required for Azure PostgreSQL
    },
  },
};

module.exports = {
  development: base,
  test:        base,
  production:  base,
};
