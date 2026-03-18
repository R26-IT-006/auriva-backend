'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const bcrypt = require('bcryptjs');
const { sequelize, Principal } = require('../models');

async function seed() {
  await sequelize.authenticate();
  console.log('Connected to database');

  // Sync schema (creates tables if they don't exist)
  await sequelize.sync({ alter: true });
  console.log('Schema synced');

  const username = process.env.PRINCIPAL_USERNAME;
  const password = process.env.PRINCIPAL_PASSWORD;

  if (!username || !password) {
    console.error('PRINCIPAL_USERNAME and PRINCIPAL_PASSWORD must be set in .env');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 12);

  const [principal, created] = await Principal.findOrCreate({
    where: { username },
    defaults: { password_hash: hash },
  });

  if (created) {
    console.log(`Principal created: "${username}" (id: ${principal.id})`);
  } else {
    console.log(`Principal already exists: "${username}" (id: ${principal.id})`);
  }

  await sequelize.close();
}

seed().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
