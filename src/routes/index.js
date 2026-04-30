'use strict';

const router = require('express').Router();

router.use('/auth',      require('./auth'));
router.use('/principal', require('./principal'));
router.use('/teacher',   require('./teacher'));
router.use('/teacher',   require('./dialogue'));

module.exports = router;
