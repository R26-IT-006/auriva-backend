'use strict';

const { validationResult }   = require('express-validator');
const level2Service          = require('../services/level2Service');
const level2AnalyticsService = require('../services/level2AnalyticsService');
const ApiError               = require('../utils/ApiError');

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

/**
 * PATCH — partial questionnaire update for friend/pet fields (FriendNameStep.js,
 * PetPicker.js). Reuses saveQuestionnaire's existing findOrCreate-then-update
 * (already partial, already calls validateFriendPet) — no service change
 * needed, only this route was missing. Unlike the PUT route, no self-
 * introduction fields are required here.
 */
async function patchQuestionnaire(req, res) {
  validate(req);
  const q = await level2Service.saveQuestionnaire(
    req.user.id,
    req.params.studentId,
    req.body
  );
  res.status(200).json({ message: 'Questionnaire updated', data: q });
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
  validate(req);
  const parentSessionId = req.body.session_id ?? null;
  const topic = req.body.topic ?? 'self_introduction';
  const data = await level2Service.startSession(
    req.user.id,
    req.params.studentId,
    topic,
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
  validate(req);
  const topic = req.query.topic ?? 'self_introduction';
  const data = await level2Service.getProgress(req.user.id, req.params.studentId, topic);
  res.json({ data });
}

// TASK-46 — one Level 2 report per student, all three topics in a single call.
// Read-only: it reports the data the session flow already records and changes
// none of it.
async function getReport(req, res) {
  const data = await level2AnalyticsService.getLevel2Report(req.params.studentId);
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
  patchQuestionnaire,
  savePortraitStrokes,
  startSession,
  completeSession,
  getProgress,
  getReport,
  recordStep3,
  assessStep4,
  recordNonVerbalTeaching,
  recordGenderSelection,
  recordActivitySelection,
  assessParagraph,
  assessSentenceBySentence,
  recordNonVerbalWordMatch,
};
