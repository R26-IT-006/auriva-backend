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

// ── Adaptive Support Recommendation (Feature 3 Step 6, read-only) ─────────────
// Narrowly scoped to one (letter, caseType) rather than the whole student —
// support is family-specific, and this is the exact shape the writing
// screens need at session start (one letter at a time). No PATCH/PUT/DELETE.
router.get('/support-recommendation/:studentId/:letter/:caseType', ctrl.getSupportRecommendation);

// ── Adaptive Pre-Writing Recommendation (Feature 4 Step 5, read-only) ─────────
// Same narrow (studentId, letter, caseType) scope as support-recommendation
// above — pre-writing recommendation is also family-specific and resolved
// one target letter at a time. No PATCH/PUT/DELETE.
router.get('/pre-writing-recommendation/:studentId/:letter/:caseType', ctrl.getPreWritingRecommendation);

// ── Adaptive Repetition Recommendation (Feature 5 Step 3, read-only) ──────────
// Same narrow (studentId, letter, caseType) scope as the two recommendation
// endpoints above, plus an optional ?adaptiveRepetitionsUsed= query param
// (frontend-supplied interaction-scoped count). No PATCH/PUT/DELETE.
router.get('/repetition-recommendation/:studentId/:letter/:caseType', ctrl.getRepetitionRecommendation);

// ── Data Collection Mode: session tracking, teacher validation, ML export ─────
router.post('/collection-session/start',           collectionCtrl.startCollectionSession);
router.patch('/collection-session/:id/complete',   collectionCtrl.completeCollectionSession);
router.post('/teacher-validation',                 collectionCtrl.submitTeacherValidation);
router.get('/teacher-validation/:sessionId',        collectionCtrl.getTeacherValidation);
router.get('/ml-samples/export',                    collectionCtrl.exportMlSamples);

module.exports = router;
