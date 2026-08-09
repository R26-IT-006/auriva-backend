'use strict';

const router = require('express').Router();

router.use('/teacher',   require('./dialogue'));
router.use('/teacher',   require('./level2'));
router.use('/teacher',   require('./category3'));
router.use('/teacher',   require('./evaluation'));
router.use('/auth',        require('./auth'));
router.use('/principal',   require('./principal'));
router.use('/teacher',     require('./teacher'));
router.use('/handwriting', require('./handwriting'));

module.exports = router;
