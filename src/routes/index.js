'use strict';

const router = require('express').Router();

router.use('/auth',      require('./auth'));
router.use('/principal', require('./principal'));
router.use('/teacher',   require('./teacher'));

module.exports = router;
