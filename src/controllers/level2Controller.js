'use strict';

const { validationResult } = require('express-validator');
const level2Service        = require('../services/level2Service');
const ApiError             = require('../utils/ApiError');

function validate(req) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());
}

// ── Questionnaire ─────────────────────────────────────────────────────────

async function saveQuestionnaire(req, res) {
  validate(req);
  const q = await level2Service.saveQuestionnaire(
    req.user.id,
    req.params.studentId,
    req.body
  );
  res.status(200).json({ message: 'Questionnaire saved', data: q });
}

async function getQuestionnaire(req, res) {
  const q = await level2Service.getQuestionnaire(req.user.id, req.params.studentId);
  res.json({ data: q });
}

async function savePortraitStrokes(req, res) {
  validate(req);
  const q = await level2Service.savePortraitStrokes(
    req.user.id,
    req.params.studentId,
    req.body.portrait_strokes ?? null
  );
  res.status(200).json({ message: 'Portrait saved', data: q });
}

// ── Session ───────────────────────────────────────────────────────────────

async function startSession(req, res) {
  const parentSessionId = req.body.session_id ?? null;
  const data = await level2Service.startSession(
    req.user.id,
    req.params.studentId,
    parentSessionId
  );
  res.status(201).json({ message: 'Level 2 session started', data });
}

async function completeSession(req, res) {
  const data = await level2Service.completeSession(
    req.user.id,
    req.params.studentId,
    req.params.sessionId
  );
  res.json({ message: 'Session complete', data });
}

async function getProgress(req, res) {
  const data = await level2Service.getProgress(req.user.id, req.params.studentId);
  res.json({ data });
}

// ── Teaching flow ─────────────────────────────────────────────────────────

async function recordStep3(req, res) {
  validate(req);
  const data = await level2Service.recordStep3(
    req.user.id,
    req.params.studentId,
    req.params.sessionId,
    Number(req.params.sentenceIndex),
    req.body.result
  );
  res.json({ message: 'Step 3 recorded', data });
}

async function assessStep4(req, res) {
  validate(req);
  const data = await level2Service.assessStep4(
    req.user.id,
    req.params.studentId,
    req.params.sessionId,
    Number(req.params.sentenceIndex),
    req.body.audio_base64,
    req.body.mime_type
  );
  res.json({ data });
}

async function recordNonVerbalTeaching(req, res) {
  validate(req);
  const data = await level2Service.recordNonVerbalTeaching(
    req.user.id,
    req.params.studentId,
    req.params.sessionId,
    Number(req.params.sentenceIndex),
    req.body
  );
  res.json({ message: 'Non-verbal teaching attempt recorded', data });
}

// ── Special sentence activities ───────────────────────────────────────────

async function recordGenderSelection(req, res) {
  validate(req);
  const data = await level2Service.recordGenderSelection(
    req.user.id,
    req.params.studentId,
    req.params.sessionId,
    req.body
  );
  res.json({ message: 'Gender selection recorded', data });
}

async function recordActivitySelection(req, res) {
  validate(req);
  const data = await level2Service.recordActivitySelection(
    req.user.id,
    req.params.studentId,
    req.params.sessionId,
    req.body
  );
  res.json({ message: 'Activity selection recorded', data });
}

// ── Independent production ────────────────────────────────────────────────

async function assessParagraph(req, res) {
  validate(req);
  const data = await level2Service.assessParagraph(
    req.user.id,
    req.params.studentId,
    req.params.sessionId,
    req.body.audio_base64,
    req.body.mime_type,
    req.body.silence_timeout ?? false
  );
  res.json({ data });
}

async function assessSentenceBySentence(req, res) {
  validate(req);
  const data = await level2Service.assessSentenceBySentence(
    req.user.id,
    req.params.studentId,
    req.params.sessionId,
    Number(req.params.sentenceIndex),
    req.body.audio_base64,
    req.body.mime_type,
    req.body.silence_timeout ?? false
  );
  res.json({ data });
}

async function recordNonVerbalWordMatch(req, res) {
  validate(req);
  const data = await level2Service.recordNonVerbalWordMatch(
    req.user.id,
    req.params.studentId,
    req.params.sessionId,
    Number(req.params.sentenceIndex),
    req.body
  );
  res.json({ message: 'Non-verbal word match recorded', data });
}

module.exports = {
  saveQuestionnaire,
  getQuestionnaire,
  savePortraitStrokes,
  startSession,
  completeSession,
  getProgress,
  recordStep3,
  assessStep4,
  recordNonVerbalTeaching,
  recordGenderSelection,
  recordActivitySelection,
  assessParagraph,
  assessSentenceBySentence,
  recordNonVerbalWordMatch,
};
