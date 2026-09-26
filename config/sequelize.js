'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

module.exports = {
  [process.env.NODE_ENV || 'development']: {
    username:       process.env.DB_USER,
    password:       process.env.DB_PASSWORD,
    database:       process.env.DB_NAME,
    host:           process.env.DB_HOST,
    port:           parseInt(process.env.DB_PORT, 10),
    dialect:        'postgres',
    dialectOptions: {
      ssl: {
        require:            true,
        rejectUnauthorized: false,
      },
    },
  },
};
