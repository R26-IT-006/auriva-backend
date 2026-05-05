'use strict';

const router          = require('express').Router();
const { verifyToken } = require('../middleware/auth');
const { isTeacher }   = require('../middleware/roleGuard');
const { body }        = require('express-validator');
const ctrl            = require('../controllers/teacherController');

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

module.exports = router;
