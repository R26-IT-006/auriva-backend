'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const bcrypt = require('bcryptjs');
const { sequelize, Principal } = require('../models');

async function seed() {
  await sequelize.authenticate();
  console.log('Connected to database');

  // Schema changes belong in migrations now — this used to unconditionally
  // sync({ alter: true }) with no environment check at all, which is unsafe
  // once real data exists. Same opt-in flag as index.js: off by default,
  // and refuses to run against a production-flagged environment even if set.
  const allowSync = process.env.ALLOW_DB_SYNC === 'true' && process.env.NODE_ENV !== 'production';
  if (allowSync) {
    // alter: { drop: false } — see index.js for why: this DB is shared across
    // dev machines, and alter:true's default (drop: true) has repeatedly
    // dropped columns that just weren't in whichever Student model ran sync.
    await sequelize.sync({ alter: { drop: false } });
    console.log('Schema synced via ALLOW_DB_SYNC=true (alter: true, drop: false) — should only happen on a local/dev database');
  } else {
    console.log('Schema sync skipped (set ALLOW_DB_SYNC=true on a non-production, disposable database to enable) — run migrations instead');
  }

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
