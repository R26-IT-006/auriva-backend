'use strict';

const router          = require('express').Router();
const { verifyToken } = require('../middleware/auth');
const { isTeacher }   = require('../middleware/roleGuard');
const ctrl            = require('../controllers/handwritingController');
const collectionCtrl  = require('../controllers/collectionController');
const liveSessionCtrl = require('../controllers/liveSessionController');
const reportCtrl      = require('../controllers/reportController');

router.use(verifyToken, isTeacher);

router.post('/assessment',                  ctrl.submitAssessment);
router.post('/pre-writing-activity',        ctrl.submitPreWritingActivity);
router.post('/letter-complete',             ctrl.recordLetterCompletion);
router.get('/progress/:studentId',          ctrl.getProgress);
router.post('/word-attempt',                ctrl.postWordAttempt);
router.post('/word-activity',               ctrl.postWordActivity);
router.get('/word-progress/:studentId',     ctrl.getWordProgress);
router.get('/word-attempts/:studentId',     ctrl.getWordAttempts);
router.get('/word-report/:studentId',       ctrl.getWordReport);

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

// ── Feature 11 pilot model (motor_cluster_v1, read-only) ──────────────────────
// Legacy experimental L2 shape-motor clustering. Retained for
// research/reference compatibility only. It is not used by the current
// teacher-facing baseline summary and does not influence adaptive
// progression.
//
// The active teacher-facing card reads motor-baseline above (which now
// carries the deterministic Initial Motor Baseline Summary). This route
// stays mounted so the legacy/experimental prediction remains callable for
// research inspection; no normal teacher-report flow invokes it.
//
// Same path convention as motor-baseline above. Node computes this from the
// SAME baseline motor-baseline exposes and calls auriva-ml-service — see
// motorClusterService.js/mlServiceClient.js. Nothing persisted; no
// PATCH/PUT/DELETE for this resource.
router.get('/motor-cluster/:studentId',     ctrl.getMotorCluster);

// ── Feature 2 current family thresholds (Teacher Dashboard integration fix,
// read-only) ────────────────────────────────────────────────────────────────
// Student-wide (all three families at once), matching motor-baseline's own
// convention above — never the legacy /students/:id/personal_thresholds
// shape, and never merged into GET /teacher/students/:id itself (keeps the
// student-profile endpoint free of Feature 2 concerns). No PATCH/PUT/DELETE.
router.get('/family-thresholds/:studentId', ctrl.getFamilyThresholds);

// ── Progression-decision EXPLANATION trace (read-only) ────────────────────────
// Explains the CURRENT Feature 2 decision per family — the rule, the evidence
// window, whether each recent attempt met the target, teacher-override
// protection, and a rule-derived counterfactual. Explanation only: it changes
// no decision, persists nothing, and never writes. Same student-scoped shape
// and ownership check as family-thresholds above. No PATCH/PUT/DELETE.
router.get('/threshold-trace/:studentId', ctrl.getThresholdDecisionTrace);

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

// ── Mastery-based Letter Motor State (Feature 11B Phase 5) ────────────────────
// Replaces Phase 4's explicit-reassessment routes (deleted — see
// letterMotorMasteryService.js's header comment). Every route here is
// READ-ONLY: evidence freeze + milestone prediction happen only inside
// recordLetterCompletion's own success path above, never from a GET.
// No POST/PUT/DELETE for this resource.
router.get('/letter-motor-state/latest/:studentId',        ctrl.getLatestLetterMotorState);
router.get('/letter-motor-state/history/:studentId',       ctrl.getLetterMotorStateHistory);
router.get('/letter-motor-evidence-trend/:studentId',      ctrl.getLetterMotorEvidenceTrend);

// ── Mastered-letter lookup + category completion (normal-progression fix,
// Feature 11B Phase 5 §3/§4/§5/§6 — NOT a Feature 11B adaptation change;
// see letterCategoryCompletionService.js) ──────────────────────────────────
router.get('/mastered-letters/:studentId',                 ctrl.getMasteredLetters);
router.get('/category-completion/:studentId',               ctrl.getCategoryCompletionStatus);

// ── Data Collection Mode: session tracking, teacher validation, ML export ─────
router.post('/collection-session/start',           collectionCtrl.startCollectionSession);
router.patch('/collection-session/:id/complete',   collectionCtrl.completeCollectionSession);
router.post('/teacher-validation',                 collectionCtrl.submitTeacherValidation);
router.get('/teacher-validation/:sessionId',        collectionCtrl.getTeacherValidation);
router.get('/ml-samples/export',                    collectionCtrl.exportMlSamples);

// ── Real-Time Teacher Session Monitoring (Proposal FR-16, Phase 7B) ───────────
// Near-real-time snapshot, not a stroke/biometric stream — see
// services/liveSessionService.js's header. PUT is called from the child-side
// learning screens (via LearningSessionContext.js) on meaningful events
// only, never per pen-movement (spec §8); GET is polled by the teacher UI
// every ~5s (spec §15, TeacherStudentDetailScreen's Live Session card). No
// DELETE — "Finish for Now"/natural navigation-out uses status='ended'
// instead (spec §11's documented alternative).
router.put('/live-session/:studentId',              liveSessionCtrl.putLiveSession);
router.get('/live-session/:studentId',               liveSessionCtrl.getLiveSession);

// ── Periodic Progress Report (Proposal FR-19/FR-20, Phase 7C/7D) ──────────
// Read-only — see services/periodicReportService.js's own header for the
// full read-only guarantee. Explicit start_date/end_date query params
// (YYYY-MM-DD, UTC, inclusive — see utils/reportDateRange.js).
router.get('/report/:studentId',                     reportCtrl.getPeriodicReport);

module.exports = router;
