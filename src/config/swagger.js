'use strict';

const path = require('path');
const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Auriva Backend API',
      version: '1.0.0',
      description:
        'REST API for the Auriva learning and support platform — teaching English fundamentals to children with autism in Sri Lanka.',
    },
    servers: [
      { url: 'http://localhost:3000', description: 'Development server' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      schemas: {
        // ── Auth ────────────────────────────────────────────────────────────
        LoginRequest: {
          type: 'object',
          required: ['password', 'role'],
          properties: {
            role:     { type: 'string', enum: ['principal', 'teacher'], example: 'principal' },
            username: { type: 'string', example: 'principal', description: 'Required when role is principal' },
            email:    { type: 'string', format: 'email', example: 'teacher@school.lk', description: 'Required when role is teacher' },
            password: { type: 'string', example: 'Admin@1234' },
          },
        },
        LoginResponse: {
          type: 'object',
          properties: {
            token: { type: 'string', example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' },
          },
        },
        SetPasswordRequest: {
          type: 'object',
          required: ['newPassword'],
          properties: {
            newPassword: { type: 'string', minLength: 8, example: 'NewPass@123' },
          },
        },

        // ── Teacher ─────────────────────────────────────────────────────────
        Teacher: {
          type: 'object',
          properties: {
            tid:               { type: 'integer', example: 1 },
            teacher_code:      { type: 'string',  example: 'TCH-0001' },
            full_name:         { type: 'string',  example: 'Nimal Perera' },
            email:             { type: 'string',  example: 'nimal@school.lk' },
            is_first_login:    { type: 'boolean', example: false },
            profile_photo_url: { type: 'string',  nullable: true, example: 'https://auriva.blob.core.windows.net/auriva/teachers/TCH-0001/profile.jpg' },
            created_at:        { type: 'string',  format: 'date-time' },
            created_by:        { type: 'integer', example: 1 },
          },
        },
        CreateTeacherRequest: {
          type: 'object',
          required: ['full_name', 'email', 'password'],
          properties: {
            full_name: { type: 'string', example: 'Nimal Perera' },
            email:     { type: 'string', format: 'email', example: 'nimal@school.lk' },
            password:  { type: 'string', minLength: 8, example: 'TempPass@1' },
          },
        },
        UpdateTeacherRequest: {
          type: 'object',
          properties: {
            full_name: { type: 'string', example: 'Nimal K. Perera' },
            email:     { type: 'string', format: 'email', example: 'nimal.new@school.lk' },
          },
        },

        // ── Student ─────────────────────────────────────────────────────────
        Student: {
          type: 'object',
          properties: {
            sid:               { type: 'integer', example: 1 },
            student_code:      { type: 'string',  example: 'STU-0001' },
            full_name:         { type: 'string',  example: 'Kamal Silva' },
            date_of_birth:     { type: 'string',  format: 'date', example: '2018-04-12' },
            disability:        { type: 'string',  example: 'ASD Level 1' },
            father_name:       { type: 'string',  nullable: true, example: 'Sunil Silva' },
            mother_name:       { type: 'string',  nullable: true, example: 'Kamala Silva' },
            address:           { type: 'string',  nullable: true, example: '12 Main St, Colombo 7' },
            marital_status:    { type: 'string',  nullable: true },
            mobile_number:     { type: 'string',  nullable: true, example: '+94771234567' },
            home_number:       { type: 'string',  nullable: true },
            profile_photo_url: { type: 'string',  nullable: true },
            teacher_id:        { type: 'integer', nullable: true, example: 1 },
            created_at:        { type: 'string',  format: 'date-time' },
          },
        },
        CreateStudentRequest: {
          type: 'object',
          required: ['full_name', 'date_of_birth', 'disability'],
          properties: {
            full_name:      { type: 'string', example: 'Kamal Silva' },
            date_of_birth:  { type: 'string', format: 'date', example: '2018-04-12' },
            disability:     { type: 'string', example: 'ASD Level 1' },
            father_name:    { type: 'string', example: 'Sunil Silva' },
            mother_name:    { type: 'string', example: 'Kamala Silva' },
            address:        { type: 'string', example: '12 Main St, Colombo 7' },
            marital_status: { type: 'string', example: 'N/A' },
            mobile_number:  { type: 'string', example: '+94771234567' },
            home_number:    { type: 'string', example: '+94112345678' },
          },
        },
        AssignStudentRequest: {
          type: 'object',
          properties: {
            teacher_id: { type: 'integer', nullable: true, example: 1, description: 'Set to null to unassign' },
          },
        },

        // ── Session ─────────────────────────────────────────────────────────
        Session: {
          type: 'object',
          properties: {
            id:         { type: 'integer', example: 1 },
            teacher_id: { type: 'integer', example: 1 },
            student_id: { type: 'integer', example: 1 },
            started_at: { type: 'string', format: 'date-time' },
            ended_at:   { type: 'string', format: 'date-time', nullable: true },
            is_active:  { type: 'boolean', example: true },
          },
        },
        PronunciationResultRequest: {
          type: 'object',
          required: ['mode', 'word_id', 'word_label', 'overall_score'],
          properties: {
            mode:                   { type: 'string', enum: ['word', 'alphabet'], example: 'word' },
            category_id:            { type: 'string', nullable: true, example: 'animals' },
            word_id:                { type: 'string', example: 'cat' },
            word_label:             { type: 'string', example: 'cat' },
            overall_score:          { type: 'integer', minimum: 0, maximum: 100, example: 69 },
            phoneme_scores: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  text:  { type: 'string', example: 'k' },
                  type:  { type: 'string', nullable: true, example: 'consonant' },
                  score: { type: 'integer', minimum: 0, maximum: 100, example: 91 },
                },
              },
            },
            listen_choose_data: {
              type: 'object',
              nullable: true,
              properties: {
                activity_type:         { type: 'string', example: 'listen_choose' },
                target_word_id:        { type: 'string', example: 'cat' },
                target_word_label:     { type: 'string', example: 'cat' },
                selected_choice_id:    { type: 'string', nullable: true, example: 'cat' },
                selected_choice_label: { type: 'string', nullable: true, example: 'cat' },
                is_correct:            { type: 'boolean', example: true },
                attempts:              { type: 'integer', minimum: 1, example: 1 },
                choice_ids: {
                  type: 'array',
                  items: { type: 'string' },
                  example: ['cat', 'dog', 'fish', 'bird'],
                },
                attempted_choice_ids: {
                  type: 'array',
                  items: { type: 'string' },
                  example: ['dog', 'cat'],
                },
              },
            },
            response_duration:      { type: 'number', nullable: true, example: 2.1 },
            hesitation_time:        { type: 'number', nullable: true, example: 1.2 },
            recommendation_type:    { type: 'string', nullable: true, example: 'reinforce' },
            recommendation_message: { type: 'string', nullable: true, example: 'Try another word with the k sound.' },
            next_word_id:           { type: 'string', nullable: true, example: 'dog' },
            attempt_number:         { type: 'integer', minimum: 1, example: 1 },
            workflow_completed:     { type: 'boolean', example: true },
            recording_uri:          { type: 'string', nullable: true, example: 'file:///recording.m4a' },
            raw_audio_base64:       { type: 'string', nullable: true, description: 'Base64 encoded raw recorded audio, max 8MB decoded.' },
            raw_audio_mime_type:    { type: 'string', nullable: true, example: 'audio/mp4' },
            raw_audio_size:         { type: 'integer', nullable: true, example: 84231 },
          },
        },
        PronunciationSessionResult: {
          allOf: [
            { $ref: '#/components/schemas/PronunciationResultRequest' },
            {
              type: 'object',
              properties: {
                id:         { type: 'integer', example: 1 },
                teacher_id: { type: 'integer', example: 1 },
                student_id: { type: 'integer', example: 1 },
                created_at: { type: 'string', format: 'date-time' },
              },
            },
          ],
        },

        // ── Dashboard ───────────────────────────────────────────────────────
        PrincipalDashboard: {
          type: 'object',
          properties: {
            teacherCount:       { type: 'integer', example: 5 },
            studentCount:       { type: 'integer', example: 12 },
            activeSessionCount: { type: 'integer', example: 2 },
          },
        },
        TeacherDashboard: {
          type: 'object',
          properties: {
            profile: { $ref: '#/components/schemas/Teacher' },
            stats: {
              type: 'object',
              properties: {
                totalSessions:  { type: 'integer', example: 24 },
                weeklySessions: { type: 'integer', example: 3 },
                lastSession: {
                  nullable: true,
                  type: 'object',
                  properties: {
                    studentName: { type: 'string', example: 'Kamal Silva' },
                    studentCode: { type: 'string', example: 'STU-0001' },
                    date:        { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
        },

        // ── Errors ──────────────────────────────────────────────────────────
        ErrorResponse: {
          type: 'object',
          properties: {
            error:   { type: 'string', example: 'Invalid credentials' },
            details: { type: 'array', items: { type: 'object' }, nullable: true },
          },
        },
      },
    },
    security: [],
  },
  apis: [
    path.join(__dirname, '../routes/auth.js'),
    path.join(__dirname, '../routes/principal.js'),
    path.join(__dirname, '../routes/teacher.js'),
  ],
};

const swaggerSpec = swaggerJsdoc(options);

module.exports = swaggerSpec;
