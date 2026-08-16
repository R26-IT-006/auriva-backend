'use strict';

const router          = require('express').Router();
const { verifyToken } = require('../middleware/auth');
const { isTeacher }   = require('../middleware/roleGuard');
const { body }        = require('express-validator');
const ctrl            = require('../controllers/teacherController');
const analyticsCtrl   = require('../controllers/conceptAnalyticsController');

// All routes require JWT + teacher role + first-login gate
router.use(verifyToken, isTeacher);

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

// Concept-learning analytics for one student. Split by cost: /summary reads only
// student_concept_progress so the profile renders immediately, while /report
// aggregates the per-tap interaction log and is lazy-loaded by the drill-down.
router.get('/students/:id/concepts/summary', analyticsCtrl.getConceptSummary);
router.get('/students/:id/concepts/report',  analyticsCtrl.getConceptReport);

router.use('/concepts', require('./concept'));

module.exports = router;
