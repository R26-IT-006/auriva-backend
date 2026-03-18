'use strict';

const router          = require('express').Router();
const { verifyToken } = require('../middleware/auth');
const authController  = require('../controllers/authController');
const { loginValidation, setPasswordValidation } = require('../validations/teacherValidation');

/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: Authentication endpoints
 */

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Login as principal or teacher
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/LoginRequest'
 *           examples:
 *             principal:
 *               summary: Principal login
 *               value: { role: "principal", username: "principal", password: "Admin@1234" }
 *             teacher:
 *               summary: Teacher login
 *               value: { role: "teacher", email: "nimal@school.lk", password: "TempPass@1" }
 *     responses:
 *       200:
 *         description: JWT token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LoginResponse'
 *       401:
 *         description: Invalid credentials
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
router.post('/login', loginValidation, authController.login);

/**
 * @swagger
 * /api/auth/set-password:
 *   post:
 *     summary: Set password on first login (teacher only)
 *     description: >
 *       Called by a teacher after their first login. The existing JWT (with
 *       `is_first_login: true`) must be provided. Returns a new JWT with
 *       `is_first_login: false` — the client must replace the stored token.
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SetPasswordRequest'
 *     responses:
 *       200:
 *         description: Password updated, new JWT returned
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/LoginResponse'
 *                 - type: object
 *                   properties:
 *                     message: { type: string, example: "Password updated successfully" }
 *       400:
 *         description: Password already set
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Missing or invalid token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post('/set-password', verifyToken, setPasswordValidation, authController.setPassword);

module.exports = router;
