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

router.post('/students/:id/avatar', [
  body('avatar_key')
    .isIn(['boba', 'glitter', 'lily', 'megatron'])
    .withMessage('avatar_key must be one of: boba, glitter, lily, megatron'),
], ctrl.setAvatar);

router.patch('/students/:id/threshold', [
  body('letter')
    .isString().notEmpty()
    .withMessage('letter must be a non-empty string'),
  body('value')
    .isFloat({ min: 0, max: 100 })
    .withMessage('value must be a number between 0 and 100'),
], ctrl.setThreshold);


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

module.exports = router;
