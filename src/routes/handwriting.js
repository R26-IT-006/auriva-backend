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

// ── Feature 2 current family thresholds (Teacher Dashboard integration fix,
// read-only) ────────────────────────────────────────────────────────────────
// Student-wide (all three families at once), matching motor-baseline's own
// convention above — never the legacy /students/:id/personal_thresholds
// shape, and never merged into GET /teacher/students/:id itself (keeps the
// student-profile endpoint free of Feature 2 concerns). No PATCH/PUT/DELETE.
router.get('/family-thresholds/:studentId', ctrl.getFamilyThresholds);

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

// ── Demo-Speed Recommendation (Feature 6 Step 3, read-only) ───────────────────
// Same narrow (studentId, letter, caseType) scope as the other
// recommendation endpoints above — categorical only ('standard'/'slow'), no
// pixel/timing values. No PATCH/PUT/DELETE.
router.get('/demo-speed-recommendation/:studentId/:letter/:caseType', ctrl.getDemoSpeedRecommendation);

// ── Persistent-Difficulty Detection (Feature 7 Step 3, read-only) ─────────────
// Student-wide (NOT narrowed to one letter/caseType, unlike the
// recommendation endpoints above) — persistent difficulty is inherently a
// rollup across all six (caseType, family) streams at once. Computed on
// demand; no persistence table exists yet. No PATCH/PUT/DELETE.
router.get('/persistent-difficulty/:studentId', ctrl.getPersistentDifficulty);

// ── Worksheet Recommendation (Feature 8 Step 3, read-only) ────────────────────
// Same student-wide scope as persistent-difficulty above — plural path,
// since a student may have zero, one, or multiple recommendations at once
// (one per persistent stream). Computed on demand from Feature 7's own
// live result; no persistence table exists yet. No PATCH/PUT/DELETE.
router.get('/worksheet-recommendations/:studentId', ctrl.getWorksheetRecommendations);

// ── Teacher Validation + Long-Term History (Feature 9 Step 4) ─────────────────
// Deliberately distinct route names from the pre-existing, unrelated
// collection-mode `/teacher-validation` pair below (session-quality
// ratings) — these two families of routes must never collide or shadow
// one another. GET returns Feature 9's own persisted history only (never
// re-runs Feature 7/8); POST records one explicit teacher judgement
// against the server-verified current Feature 8 recommendation. Both are
// ownership-protected exactly like every recommendation endpoint above.
router.get('/worksheet-recommendation-validations/:studentId',       ctrl.getWorksheetRecommendationValidations);
router.post('/worksheet-recommendation-validations/:studentId',      ctrl.postWorksheetRecommendationValidation);
// Separate top-level route (not a nested /:studentId/current path) to
// avoid any Express route-precedence ambiguity against the plain
// /:studentId route directly above.
router.get('/worksheet-recommendation-validation-state/:studentId',  ctrl.getWorksheetRecommendationValidationState);

// ── Data Collection Mode: session tracking, teacher validation, ML export ─────
router.post('/collection-session/start',           collectionCtrl.startCollectionSession);
router.patch('/collection-session/:id/complete',   collectionCtrl.completeCollectionSession);
router.post('/teacher-validation',                 collectionCtrl.submitTeacherValidation);
router.get('/teacher-validation/:sessionId',        collectionCtrl.getTeacherValidation);
router.get('/ml-samples/export',                    collectionCtrl.exportMlSamples);

module.exports = router;
