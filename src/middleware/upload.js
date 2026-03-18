'use strict';

const multer   = require('multer');
const ApiError = require('../utils/ApiError');

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_SIZE     = 5 * 1024 * 1024; // 5 MB

const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  if (ALLOWED_MIME.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new ApiError(400, 'Only JPEG, PNG, and WebP images are allowed'));
  }
};

const upload = multer({ storage, fileFilter, limits: { fileSize: MAX_SIZE } });

/**
 * Returns a middleware that wraps multer's single-file upload and routes
 * multer errors through Express's error handler (needed for Express 5).
 * @param {string} fieldName - Form field name for the file
 */
function singleUpload(fieldName) {
  return (req, res, next) => {
    upload.single(fieldName)(req, res, (err) => {
      if (err) return next(new ApiError(400, err.message));
      next();
    });
  };
}

module.exports = { singleUpload };
