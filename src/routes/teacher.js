'use strict';

const router          = require('express').Router();
// Named imports rather than the default export: ipKeyGenerator is only reachable
// that way, and pronunciationScoreLimiter below needs it for its IPv6-safe fallback.
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { verifyToken } = require('../middleware/auth');
const { isTeacher }   = require('../middleware/roleGuard');
const { body }        = require('express-validator');
const ctrl            = require('../controllers/teacherController');
const {
  savePronunciationResultValidation,
  scorePronunciationAttemptValidation,
  submitPronunciationReviewValidation,
} = require('../validations/pronunciationValidation');
const analyticsCtrl   = require('../controllers/conceptAnalyticsController');
const aiCtrl          = require('../controllers/aiController');
const archiveCtrl     = require('../controllers/conceptReportArchiveController');

// All routes require JWT + teacher role + first-login gate
router.use(verifyToken, isTeacher);

// The only routes in the app that cost money per call. Cached responses are free,
// but ?refresh=true is not, and a teacher leaning on the refresh button should
// not be able to run up a bill. Keyed per teacher rather than per IP — a whole
// school behind one NAT would otherwise share a budget.
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user.id),
  message: { message: 'Too many summary requests. Please wait a moment.' },
});

// Scoring spawns ffmpeg, whisper-cli, and a Python wav2vec2 worker per call —
// far heavier than the rest of the API, so it gets its own tighter cap keyed
// by teacher rather than the shared IP-based /api limit.
const pronunciationScoreLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user?.id ? `user:${req.user.id}` : ipKeyGenerator(req.ip)),
  message: { error: 'Too many pronunciation scoring requests, please slow down and try again shortly.' },
});

/**
 * @swagger
 * tags:
 *   name: Teacher
 *   description: Teacher workspace endpoints
 */

/**
 * @swagger
 * /api/teacher/dashboard:
 *   get:
 *     summary: Get teacher dashboard (profile + session statistics)
 *     tags: [Teacher]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard data
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TeacherDashboard'
 *       403:
 *         description: Forbidden or first-login password reset required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/dashboard', ctrl.getDashboard);

/**
 * @swagger
 * /api/teacher/dashboard/digest:
 *   get:
 *     summary: LLM-generated weekly digest of the teacher's class
 *     description: >
 *       Narrates the same figures /dashboard returns. Always 200 — when the
 *       feature is disabled, the model call fails, or the teacher has no
 *       students, the response is `{ available: false }` and the client renders
 *       nothing. Student names are never sent to the model; they are substituted
 *       server-side and restored in the response.
 *     tags: [Teacher]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: refresh
 *         schema:
 *           type: boolean
 *         description: Bypass the cache and regenerate
 *     responses:
 *       200:
 *         description: "Digest, or `{ available: false }`"
 *       429:
 *         description: Rate limited
 */
router.get('/dashboard/digest', aiLimiter, aiCtrl.getClassDigest);

/**
 * @swagger
 * /api/teacher/students:
 *   get:
 *     summary: List the teacher's allocated students (max 3)
 *     tags: [Teacher]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Array of allocated students
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Student'
 */
router.get('/students', ctrl.getStudents);

/**
 * @swagger
 * /api/teacher/students/{id}:
 *   get:
 *     summary: Get a student's profile (scoped to own allocated students)
 *     tags: [Teacher]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Student ID (sid)
 *     responses:
 *       200:
 *         description: Student profile
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Student'
 *       404:
 *         description: Student not found or not assigned to this teacher
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/students/:id', ctrl.getStudentById);

/**
 * @swagger
 * /api/teacher/session/start:
 *   post:
 *     summary: Open a teaching session for a student
 *     tags: [Teacher]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [student_id]
 *             properties:
 *               student_id:
 *                 type: integer
 *     responses:
 *       201:
 *         description: Session opened
 *       409:
 *         description: A session is already active for this student
 */
router.post('/session/start', [
  body('student_id').isInt({ min: 1 }).withMessage('student_id must be a positive integer'),
], ctrl.startSession);

/**
 * @swagger
 * /api/teacher/session/end:
 *   post:
 *     summary: End the active session for a student
 *     tags: [Teacher]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [student_id]
 *             properties:
 *               student_id:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Session ended
 *       404:
 *         description: No active session found for this student
 */
router.post('/session/end', [
  body('student_id').isInt({ min: 1 }).withMessage('student_id must be a positive integer'),
], ctrl.endSession);

router.post('/students/:id/avatar', [
  body('avatar_key')
    .isIn(['boba', 'glitter', 'lily', 'megatron'])
    .withMessage('avatar_key must be one of: boba, glitter, lily, megatron'),
], ctrl.setAvatar);

// Concept-learning analytics for one student. Split by cost: /summary reads only
// student_concept_progress so the profile renders immediately, while /report
// aggregates the per-tap interaction log and is lazy-loaded by the drill-down.
router.get('/students/:id/concepts/summary', analyticsCtrl.getConceptSummary);
router.get('/students/:id/concepts/report',  analyticsCtrl.getConceptReport);

/**
 * @swagger
 * /api/teacher/students/{id}/concepts/narrative:
 *   get:
 *     summary: LLM-generated summary of a student's concept report
 *     description: >
 *       Narrates the payload from /concepts/report — mastery, confusion pairs,
 *       response times and engagement — for the teacher. Advisory only: it never
 *       influences what the child sees. Always 200; `{ available: false }` when
 *       the feature is off, the model call fails, or the child has no logged
 *       activity. The student's name and id are never sent to the model.
 *     tags: [Teacher]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Student ID (sid)
 *       - in: query
 *         name: refresh
 *         schema:
 *           type: boolean
 *         description: Bypass the cache and regenerate
 *     responses:
 *       200:
 *         description: "Summary, or `{ available: false }`"
 *       404:
 *         description: Student not found or not assigned to this teacher
 *       429:
 *         description: Rate limited
 */
router.get('/students/:id/concepts/narrative', aiLimiter, aiCtrl.getConceptNarrative);

/**
 * @swagger
 * /api/teacher/students/{id}/concepts/reports:
 *   get:
 *     summary: List a student's saved concept reports, newest period first
 *     tags: [Teacher]
 *     security:
 *       - bearerAuth: []
 *   post:
 *     summary: Generate and store one period's concept report
 *     description: >
 *       Freezes the figures for a week or month so they can be revisited and
 *       shared without moving. Regenerating a period replaces it. Returns 422
 *       when nothing was recorded in the period — an empty report is worse than
 *       none, because a teacher cannot tell it apart from a broken one.
 *     tags: [Teacher]
 *     security:
 *       - bearerAuth: []
 */
// Sorted newest first by the server. The client must not re-sort: the order is
// part of the contract, and two screens sorting the same list differently is how
// a teacher ends up reading the wrong week's report.
router.get('/students/:id/concepts/periods', archiveCtrl.getPeriods);
router.get('/students/:id/concepts/reports', archiveCtrl.listReports);
// aiLimiter: generating makes a model call, so it is rate-limited like the other
// two endpoints that cost money.
router.post('/students/:id/concepts/reports', aiLimiter, [
  body('period_type')
    .isIn(['week', 'month'])
    .withMessage('period_type must be week or month'),
  body('period_start')
    .matches(/^\d{4}-\d{2}-\d{2}$/)
    .withMessage('period_start must be a YYYY-MM-DD date'),
], archiveCtrl.createReport);
// Declared after /reports so "reports" is never captured as a reportId.
router.get('/students/:id/concepts/reports/:reportId', archiveCtrl.getReport);
router.delete('/students/:id/concepts/reports/:reportId', archiveCtrl.deleteReport);

// Notes/reminders a teacher keeps about one of their own students.
router.get('/students/:id/notes', ctrl.getStudentNotes);
router.post('/students/:id/notes', [
  body('body')
    .trim()
    .isLength({ min: 1, max: 2000 })
    .withMessage('body must be between 1 and 2000 characters'),
], ctrl.addStudentNote);
router.delete('/students/:id/notes/:noteId', ctrl.deleteStudentNote);

router.patch('/students/:id/threshold', [
  body('letter')
    .isString().notEmpty()
    .withMessage('letter must be a non-empty string'),
  body('value')
    .isFloat({ min: 0, max: 100 })
    .withMessage('value must be a number between 0 and 100'),
], ctrl.setThreshold);

/**
 * Feature 2 Step 6A — family-level teacher override. Deliberately a
 * SEPARATE endpoint from PATCH /students/:id/threshold above (which writes
 * the legacy per-letter students.personal_thresholds, unchanged) — this one
 * writes an append-only student_threshold_history 'teacher_override' event
 * and never touches personal_thresholds.
 */
router.patch('/students/:id/family-threshold', [
  body('family')
    .isIn(['straight', 'curved', 'complex'])
    .withMessage('family must be one of: straight, curved, complex'),
  body('value')
    .isFloat({ min: 0, max: 100 })
    .withMessage('value must be a number between 0 and 100'),
], ctrl.setFamilyThreshold);

router.put('/students/:id/sensory-settings', [
  body('reduce_stimulation')
    .isBoolean()
    .withMessage('reduce_stimulation must be a boolean'),
], ctrl.setSensorySettings);

router.get('/students/:id/pronunciation-results', ctrl.getPronunciationResults);
router.get('/pronunciation-results/:resultId/audio', ctrl.getPronunciationResultAudio);
router.post(
  '/students/:id/pronunciation-score',
  pronunciationScoreLimiter,
  scorePronunciationAttemptValidation,
  ctrl.scorePronunciationAttempt
);

/**
 * @swagger
 * /api/teacher/students/{id}/pronunciation-results:
 *   post:
 *     summary: Save a pronunciation module result for a student
 *     tags: [Teacher]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Student ID (sid)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/PronunciationResultRequest'
 *     responses:
 *       201:
 *         description: Pronunciation result saved
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PronunciationSessionResult'
 *       404:
 *         description: Student not found or not assigned to this teacher
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       422:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post(
  '/students/:id/pronunciation-results',
  savePronunciationResultValidation,
  ctrl.savePronunciationResult
);

router.use('/concepts', require('./concept'));

/**
 * @swagger
 * /api/teacher/pronunciation-review-queue:
 *   get:
 *     summary: List not-yet-reviewed pronunciation attempts ranked by how informative labeling them would be
 *     description: >
 *       Uncertainty sampling (low model confidence) blended with coverage
 *       sampling (populations with few reviewed examples so far) — an
 *       active-learning queue for the layer-3 calibration model, not just a
 *       recency-ordered list of flagged attempts.
 *     tags: [Teacher]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Ranked review queue
 */
router.get('/pronunciation-review-queue', ctrl.getPronunciationReviewQueue);

/**
 * @swagger
 * /api/teacher/pronunciation-results/{resultId}/review:
 *   patch:
 *     summary: Submit a teacher-confirmed score for a saved pronunciation result
 *     description: >
 *       Writes ground truth onto an existing result row. This labeled corpus
 *       is what the layer-3 adaptive calibration model is fit against.
 *     tags: [Teacher]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: resultId
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [teacher_reviewed_score]
 *             properties:
 *               teacher_reviewed_score:
 *                 type: integer
 *                 minimum: 0
 *                 maximum: 100
 *     responses:
 *       200:
 *         description: Review recorded
 *       404:
 *         description: Pronunciation result not found
 *       422:
 *         description: Validation error
 */
router.patch(
  '/pronunciation-results/:resultId/review',
  submitPronunciationReviewValidation,
  ctrl.submitPronunciationReview
);

module.exports = router;
