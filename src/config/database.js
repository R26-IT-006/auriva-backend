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
  // Prevent a lost/locked remote connection from holding a pronunciation
  // audio INSERT (and then the whole pool) beyond the mobile scoring timeout.
  statement_timeout: getPositiveIntegerEnv('DB_STATEMENT_TIMEOUT_MS', 60000),
  query_timeout: getPositiveIntegerEnv('DB_QUERY_TIMEOUT_MS', 60000),
  keepAlive: true,
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
      acquire: getPositiveIntegerEnv('DB_POOL_ACQUIRE_TIMEOUT_MS', 15000),
      idle: 10000,
    },
    logging: (msg) => logger.debug(msg),
  }
);

module.exports = sequelize;
