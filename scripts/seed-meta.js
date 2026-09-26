'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const { Sequelize } = require('sequelize');

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASSWORD,
  {
    host:    process.env.DB_HOST,
    port:    parseInt(process.env.DB_PORT, 10),
    dialect: 'postgres',
    dialectOptions: { ssl: { require: true, rejectUnauthorized: false } },
    logging: false,
  }
);

(async () => {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS "SequelizeMeta" (
      name VARCHAR(255) NOT NULL UNIQUE PRIMARY KEY
    )
  `);

  // Mark the migration that was applied manually before CLI tracking began
  await sequelize.query(`
    INSERT INTO "SequelizeMeta" (name)
    VALUES ('20260513000000-add-personal-thresholds-and-blocked-attempts.js')
    ON CONFLICT (name) DO NOTHING
  `);

  console.log('SequelizeMeta seeded — old migration marked as applied.');
  await sequelize.close();
})().catch(err => { console.error(err); process.exit(1); });
