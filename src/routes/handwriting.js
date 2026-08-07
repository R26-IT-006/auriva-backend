'use strict';

const router          = require('express').Router();
const { verifyToken } = require('../middleware/auth');
const { isTeacher }   = require('../middleware/roleGuard');
const ctrl            = require('../controllers/handwritingController');
const collectionCtrl  = require('../controllers/collectionController');

router.use(verifyToken, isTeacher);

router.post('/assessment',                  ctrl.submitAssessment);
router.post('/pre-writing-activity',        ctrl.submitPreWritingActivity);
router.post('/letter-complete',             ctrl.recordLetterCompletion);
router.get('/progress/:studentId',          ctrl.getProgress);

// ── Explainability endpoints ──────────────────────────────────────────────────
router.post('/explain',                     ctrl.explainAssessment);
router.get('/explanation/:studentId',       ctrl.getLatestExplanation);

// ── Initial assessment finalize + teacher report ──────────────────────────────
router.patch('/assessment/:id/finalize',    ctrl.finalizeAssessment);
router.get('/initial-report/:studentId',    ctrl.getInitialReport);
router.get('/letter-progress-report/:studentId', ctrl.getLetterProgressReport);

// ── Individual Motor-Family Baseline (Feature 1, read-only) ───────────────────
// Path style matches the existing /progress/:studentId, /initial-report/:studentId,
// /letter-progress-report/:studentId convention on this router, not the
// nested /students/:studentId/... style — no PATCH/PUT/DELETE for this resource.
router.get('/motor-baseline/:studentId',    ctrl.getMotorBaseline);

// ── Data Collection Mode: session tracking, teacher validation, ML export ─────
router.post('/collection-session/start',           collectionCtrl.startCollectionSession);
router.patch('/collection-session/:id/complete',   collectionCtrl.completeCollectionSession);
router.post('/teacher-validation',                 collectionCtrl.submitTeacherValidation);
router.get('/teacher-validation/:sessionId',        collectionCtrl.getTeacherValidation);
router.get('/ml-samples/export',                    collectionCtrl.exportMlSamples);

module.exports = router;
