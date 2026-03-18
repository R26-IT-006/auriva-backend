'use strict';

const router          = require('express').Router();
const { verifyToken } = require('../middleware/auth');
const { isPrincipal } = require('../middleware/roleGuard');
const { singleUpload } = require('../middleware/upload');
const ctrl            = require('../controllers/principalController');
const {
  createTeacherValidation,
  updateTeacherValidation,
  assignStudentValidation,
} = require('../validations/teacherValidation');
const {
  createStudentValidation,
  updateStudentValidation,
} = require('../validations/studentValidation');

// All routes require JWT + principal role
router.use(verifyToken, isPrincipal);

/**
 * @swagger
 * tags:
 *   name: Principal
 *   description: Principal-only management endpoints
 */

// ─── Dashboard ────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/principal/dashboard:
 *   get:
 *     summary: Get principal dashboard statistics
 *     tags: [Principal]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard stats
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PrincipalDashboard'
 *       403:
 *         description: Forbidden
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/dashboard', ctrl.getDashboard);

// ─── Teachers ─────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/principal/teachers:
 *   post:
 *     summary: Create a new teacher
 *     description: >
 *       Creates a teacher account. The `teacher_code` (e.g. TCH-0001) is
 *       auto-generated. The supplied `password` becomes the teacher's
 *       temporary system password — they must change it on first login.
 *       Optionally attach a profile photo as `multipart/form-data`.
 *     tags: [Principal]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             allOf:
 *               - $ref: '#/components/schemas/CreateTeacherRequest'
 *               - type: object
 *                 properties:
 *                   photo:
 *                     type: string
 *                     format: binary
 *                     description: Profile photo (JPEG, PNG, or WebP, max 5 MB)
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateTeacherRequest'
 *     responses:
 *       201:
 *         description: Teacher created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Teacher'
 *       409:
 *         description: Email already in use
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
router.post('/teachers', singleUpload('photo'), createTeacherValidation, ctrl.createTeacher);

/**
 * @swagger
 * /api/principal/teachers:
 *   get:
 *     summary: List all teachers
 *     tags: [Principal]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Array of teachers (each includes their allocated students)
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Teacher'
 */
router.get('/teachers', ctrl.getTeachers);

/**
 * @swagger
 * /api/principal/teachers/{id}:
 *   get:
 *     summary: Get a teacher's profile and allocated students
 *     tags: [Principal]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Teacher ID (tid)
 *     responses:
 *       200:
 *         description: Teacher profile with students
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Teacher'
 *       404:
 *         description: Teacher not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/teachers/:id', ctrl.getTeacherById);

/**
 * @swagger
 * /api/principal/teachers/{id}:
 *   put:
 *     summary: Update a teacher's details
 *     tags: [Principal]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             allOf:
 *               - $ref: '#/components/schemas/UpdateTeacherRequest'
 *               - type: object
 *                 properties:
 *                   photo:
 *                     type: string
 *                     format: binary
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateTeacherRequest'
 *     responses:
 *       200:
 *         description: Updated teacher
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Teacher'
 *       404:
 *         description: Teacher not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.put('/teachers/:id', singleUpload('photo'), updateTeacherValidation, ctrl.updateTeacher);

/**
 * @swagger
 * /api/principal/teachers/{id}:
 *   delete:
 *     summary: Delete a teacher
 *     description: Blocked if the teacher has any active sessions.
 *     tags: [Principal]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Teacher deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string, example: "Teacher deleted successfully" }
 *       404:
 *         description: Teacher not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: Cannot delete — teacher has active sessions
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.delete('/teachers/:id', ctrl.deleteTeacher);

// ─── Students ─────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/principal/students:
 *   post:
 *     summary: Create a new student
 *     description: >
 *       The `student_code` (e.g. STU-0001) is auto-generated.
 *       Optionally attach a profile photo as `multipart/form-data`.
 *     tags: [Principal]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             allOf:
 *               - $ref: '#/components/schemas/CreateStudentRequest'
 *               - type: object
 *                 properties:
 *                   photo:
 *                     type: string
 *                     format: binary
 *                     description: Profile photo (JPEG, PNG, or WebP, max 5 MB)
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateStudentRequest'
 *     responses:
 *       201:
 *         description: Student created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Student'
 *       422:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post('/students', singleUpload('photo'), createStudentValidation, ctrl.createStudent);

/**
 * @swagger
 * /api/principal/students:
 *   get:
 *     summary: List all students
 *     tags: [Principal]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Array of students (each includes their assigned teacher)
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
 * /api/principal/students/{id}:
 *   get:
 *     summary: Get a student's profile
 *     tags: [Principal]
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
 *         description: Student profile with assigned teacher
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Student'
 *       404:
 *         description: Student not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/students/:id', ctrl.getStudentById);

/**
 * @swagger
 * /api/principal/students/{id}:
 *   put:
 *     summary: Update a student's details
 *     tags: [Principal]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             allOf:
 *               - $ref: '#/components/schemas/CreateStudentRequest'
 *               - type: object
 *                 properties:
 *                   photo:
 *                     type: string
 *                     format: binary
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateStudentRequest'
 *     responses:
 *       200:
 *         description: Updated student
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Student'
 *       404:
 *         description: Student not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.put('/students/:id', singleUpload('photo'), updateStudentValidation, ctrl.updateStudent);

/**
 * @swagger
 * /api/principal/students/{id}:
 *   delete:
 *     summary: Delete a student
 *     tags: [Principal]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Student deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string, example: "Student deleted successfully" }
 *       404:
 *         description: Student not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.delete('/students/:id', ctrl.deleteStudent);

/**
 * @swagger
 * /api/principal/students/{id}/assign:
 *   put:
 *     summary: Assign or unassign a student to a teacher
 *     description: >
 *       Pass `teacher_id` as an integer to assign, or `null` to unassign.
 *       A teacher can have at most 3 students — the request is rejected if
 *       the target teacher is already at capacity.
 *     tags: [Principal]
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
 *             $ref: '#/components/schemas/AssignStudentRequest'
 *     responses:
 *       200:
 *         description: Student with updated assignment
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Student'
 *       400:
 *         description: Teacher already has 3 students
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Student or teacher not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.put('/students/:id/assign', assignStudentValidation, ctrl.assignStudent);

module.exports = router;
