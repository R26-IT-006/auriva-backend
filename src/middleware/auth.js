'use strict';

const jwt     = require('jsonwebtoken');
const ApiError = require('../utils/ApiError');
const { JWT_SECRET } = require('../config/jwt');

/**
 * Verifies the Bearer JWT and attaches decoded payload to req.user.
 * Express 5 automatically forwards thrown errors to the global error handler.
 */
async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new ApiError(401, 'No token provided');
  }

  const token = authHeader.split(' ')[1];
  // jwt.verify throws JsonWebTokenError or TokenExpiredError on failure —
  // Express 5 catches and routes these to the global error handler.
  const decoded = jwt.verify(token, JWT_SECRET);
  req.user = decoded; // { id, role, is_first_login? }
  next();
}

module.exports = { verifyToken };
