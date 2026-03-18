'use strict';

const ApiError = require('../utils/ApiError');

function isPrincipal(req, res, next) {
  if (req.user?.role !== 'principal') {
    throw new ApiError(403, 'Forbidden: Principal access only');
  }
  next();
}

function isTeacher(req, res, next) {
  if (req.user?.role !== 'teacher') {
    throw new ApiError(403, 'Forbidden: Teacher access only');
  }
  // First-login gate: block all teacher routes until password is set.
  // POST /api/auth/set-password is on a different router so it never hits this guard.
  if (req.user.is_first_login === true) {
    throw new ApiError(403, 'Password reset required before accessing this resource', {
      redirect: '/set-password',
    });
  }
  next();
}

module.exports = { isPrincipal, isTeacher };
