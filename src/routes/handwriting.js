'use strict';

const router          = require('express').Router();
const { verifyToken } = require('../middleware/auth');
const { isTeacher }   = require('../middleware/roleGuard');
const ctrl            = require('../controllers/handwritingController');

router.use(verifyToken, isTeacher);

router.post('/assessment',                  ctrl.submitAssessment);
router.post('/letter-complete',             ctrl.recordLetterCompletion);
router.get('/progress/:studentId',          ctrl.getProgress);

// ── Explainability endpoints ──────────────────────────────────────────────────
router.post('/explain',                     ctrl.explainAssessment);
router.get('/explanation/:studentId',       ctrl.getLatestExplanation);

// ── Initial assessment finalize + teacher report ──────────────────────────────
router.patch('/assessment/:id/finalize',    ctrl.finalizeAssessment);
router.get('/initial-report/:studentId',    ctrl.getInitialReport);

module.exports = router;
