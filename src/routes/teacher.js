'use strict';

const router          = require('express').Router();
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

// All routes require JWT + teacher role + first-login gate
router.use(verifyToken, isTeacher);

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
 *     summary: Start a learning session for a student
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
 *                 example: 1
 *     responses:
 *       201:
 *         description: Session started
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Session'
 *       404:
 *         description: Student not found or not assigned to this teacher
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: A session is already active for this student
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
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
 *                 example: 1
 *     responses:
 *       200:
 *         description: Session ended
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Session'
 *       404:
 *         description: No active session found for this student
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post('/session/end', [
  body('student_id').isInt({ min: 1 }).withMessage('student_id must be a positive integer'),
], ctrl.endSession);

router.post('/students/:id/avatar', [
  body('avatar_key')
    .isIn(['boba', 'glitter', 'lily', 'megatron'])
    .withMessage('avatar_key must be one of: boba, glitter, lily, megatron'),
], ctrl.setAvatar);

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
