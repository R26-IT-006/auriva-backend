'use strict';

const { Sequelize } = require('sequelize');
const logger = require('../utils/logger');

function getPositiveIntegerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function shouldUseSsl() {
  if (process.env.DB_SSL) {
    return process.env.DB_SSL === 'true';
  }

  return String(process.env.DB_HOST || '').includes('postgres.database.azure.com');
}

function getRequiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

const dialectOptions = {
  connectionTimeoutMillis: getPositiveIntegerEnv('DB_CONNECTION_TIMEOUT_MS', 10000),
};

if (shouldUseSsl()) {
  dialectOptions.ssl = {
    require: true,
    rejectUnauthorized: false, // Required for Azure PostgreSQL
  };
}

const sequelize = new Sequelize(
  getRequiredEnv('DB_NAME'),
  getRequiredEnv('DB_USER'),
  getRequiredEnv('DB_PASSWORD'),
  {
    host: getRequiredEnv('DB_HOST'),
    port: getPositiveIntegerEnv('DB_PORT', 5432),
    dialect: 'postgres',
    dialectOptions,
    pool: {
      max: 10,
      min: 2,
      acquire: 30000,
      idle: 10000,
    },
    logging: (msg) => logger.debug(msg),
  }
);

module.exports = sequelize;
