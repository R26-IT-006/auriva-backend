'use strict';

function getRequiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

// Fail fast at boot rather than at first login: an unset JWT_SECRET would
// otherwise only surface as a cryptic verify failure on first request, and
// an unset JWT_EXPIRES_IN would silently issue tokens that never expire.
module.exports = {
  JWT_SECRET: getRequiredEnv('JWT_SECRET'),
  JWT_EXPIRES_IN: getRequiredEnv('JWT_EXPIRES_IN'),
};
