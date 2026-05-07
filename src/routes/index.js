'use strict';

const router = require('express').Router();

router.use('/auth',      require('./auth'));
router.use('/principal', require('./principal'));
router.use('/teacher',   require('./teacher'));
router.use('/teacher',   require('./dialogue'));
router.use('/teacher',   require('./daysOfWeek'));
router.use('/teacher',   require('./level2'));
router.use('/teacher',   require('./category3'));

module.exports = router;
