'use strict';

const { QueryTypes } = require('sequelize');
const {
  sequelize, CollectionSession, TeacherValidation, ShapeFeature, LetterAttempt,
} = require('../models');
const ApiError = require('../utils/ApiError');
const { validateSession } = require('../utils/collectionProtocolValidation');

// POST /handwriting/collection-session/start
// Called once when a teacher taps "Data Collection" — the id returned here
// is generated client-side (UUID v4) and threaded through every subsequent
// shape/letter POST as collection_session_id.
async function startCollectionSession(req, res) {
  const { id, student_id, protocol_version, device_type, app_version } = req.body;

  if (!id || !student_id) {
    throw new ApiError(422, 'id and student_id are required');
  }

  const session = await CollectionSession.create({
    id, student_id, protocol_version, device_type, app_version,
    capture_status: 'in_progress',
  });

  res.status(201).json({ id: session.id });
}

// PATCH /handwriting/collection-session/:id/complete
// Runs the item-8 protocol checks and returns any warnings for the app to
// surface to the teacher — never blocks or deletes anything.
async function completeCollectionSession(req, res) {
  const { id } = req.params;

  const session = await CollectionSession.findByPk(id);
  if (!session) throw new ApiError(404, 'Collection session not found');

  const [shapeRows, letterRows] = await Promise.all([
    ShapeFeature.findAll({ where: { collection_session_id: id }, raw: true }),
    LetterAttempt.findAll({ where: { collection_session_id: id }, raw: true }),
  ]);
  const lowercaseRows = letterRows.filter(r => r.case_type === 'lowercase');
  const uppercaseRows = letterRows.filter(r => r.case_type === 'uppercase');

  const warnings = validateSession({ shapeRows, lowercaseRows, uppercaseRows });

  await session.update({
    capture_status: warnings.length > 0 ? 'incomplete' : 'complete',
    completed_at:   new Date(),
  });

  res.json({ id: session.id, capture_status: session.capture_status, warnings });
}

// POST /handwriting/teacher-validation
// Upserts one row per (student_id, collection_session_id) — a teacher may
// submit/update ratings after reviewing a session.
async function submitTeacherValidation(req, res) {
  const {
    student_id, collection_session_id,
    teacher_straight_rating, teacher_curve_rating, teacher_complex_rating,
    teacher_speed_rating, teacher_fatigue_rating, teacher_overall_rating,
    teacher_notes,
  } = req.body;

  if (!student_id || !collection_session_id) {
    throw new ApiError(422, 'student_id and collection_session_id are required');
  }

  const [record] = await TeacherValidation.findOrCreate({
    where:    { student_id, collection_session_id },
    defaults: { student_id, collection_session_id },
  });

  await record.update({
    teacher_straight_rating, teacher_curve_rating, teacher_complex_rating,
    teacher_speed_rating, teacher_fatigue_rating, teacher_overall_rating,
    teacher_notes,
    teacher_validated: true,
    validated_at:      new Date(),
  });

  res.status(200).json({ id: record.id, teacher_validated: true });
}

// GET /handwriting/teacher-validation/:sessionId
async function getTeacherValidation(req, res) {
  const { sessionId } = req.params;

  const record = await TeacherValidation.findOne({ where: { collection_session_id: sessionId } });
  if (!record) return res.json({ data: null });

  res.json({ data: record });
}

// GET /handwriting/ml-samples/export
// item 12: only rows that are collection-mode, fully captured, AND accepted.
// collection_accepted is never a quality label — it's ANDed with
// capture_status here purely to exclude rows we know are broken/partial.
async function exportMlSamples(req, res) {
  const rows = await sequelize.query(
    `SELECT * FROM handwriting_ml_samples
     WHERE collection_mode = true
       AND capture_status = 'complete'
       AND collection_accepted = true
     ORDER BY student_id, collection_session_id, task_order`,
    { type: QueryTypes.SELECT }
  );

  res.json({ count: rows.length, data: rows });
}

module.exports = {
  startCollectionSession,
  completeCollectionSession,
  submitTeacherValidation,
  getTeacherValidation,
  exportMlSamples,
};
