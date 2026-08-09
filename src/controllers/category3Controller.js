'use strict';

const { validationResult } = require('express-validator');
const cat3Service          = require('../services/category3Service');
const ApiError             = require('../utils/ApiError');

async function getCat3Overview(req, res) {
  const data = await cat3Service.getCat3Overview(req.user.id, req.params.studentId);
  res.json(data);
}

async function getNextWord(req, res) {
  const word = await cat3Service.getNextWord(req.user.id, req.params.studentId);
  res.json(word ?? { done: true });
}

async function recordPhase1Tap(req, res) {
  const result = await cat3Service.recordPhase1Tap(
    req.user.id,
    req.params.studentId,
    req.params.wordId
  );
  res.json(result);
}

async function recordDragToLine(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());
  const result = await cat3Service.recordDragToLine(
    req.user.id,
    req.params.studentId,
    req.params.wordId,
    req.body
  );
  res.json(result);
}

async function assessPhase2Speech(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());
  const result = await cat3Service.assessPhase2Speech(
    req.user.id,
    req.params.studentId,
    req.params.wordId,
    req.body
  );
  res.json(result);
}

async function recordPhase2NonVerbal(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());
  const result = await cat3Service.recordPhase2NonVerbal(
    req.user.id,
    req.params.studentId,
    req.params.wordId,
    req.body
  );
  res.json(result);
}

async function recordPhase3Check(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());
  const result = await cat3Service.recordPhase3Check(
    req.user.id,
    req.params.studentId,
    req.params.wordId,
    req.body
  );
  res.json(result);
}

async function completeWordSession(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());
  const result = await cat3Service.completeWordSession(
    req.user.id,
    req.params.studentId,
    req.params.wordId,
    req.body
  );
  res.json(result);
}

async function getCanYouSession(req, res) {
  const data = await cat3Service.getCanYouSession(req.user.id, req.params.studentId);
  res.json(data);
}

async function recordCanYouRound(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());
  const result = await cat3Service.recordCanYouRound(
    req.user.id,
    req.params.studentId,
    req.body
  );
  res.json(result);
}

async function getActionIdentificationSession(req, res) {
  const data = await cat3Service.getActionIdentificationSession(req.user.id, req.params.studentId);
  res.json(data);
}

async function recordActionIdentificationRound(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());
  const result = await cat3Service.recordActionIdentificationRound(
    req.user.id,
    req.params.studentId,
    req.body
  );
  res.json(result);
}

async function getVerbQASession(req, res) {
  const data = await cat3Service.getVerbQASession(req.user.id, req.params.studentId);
  res.json(data);
}

async function assessVerbQARound(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());
  const result = await cat3Service.assessVerbQARound(
    req.user.id,
    req.params.studentId,
    req.body
  );
  res.json(result);
}

async function recordVerbQANonVerbal(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());
  const result = await cat3Service.recordVerbQANonVerbal(
    req.user.id,
    req.params.studentId,
    req.body
  );
  res.json(result);
}

async function recordProbeResult(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());
  const result = await cat3Service.recordProbeResult(
    req.user.id,
    req.params.studentId,
    req.params.wordId,
    req.body
  );
  res.json(result);
}

module.exports = {
  getCat3Overview,
  getNextWord,
  recordPhase1Tap,
  recordDragToLine,
  assessPhase2Speech,
  recordPhase2NonVerbal,
  recordPhase3Check,
  completeWordSession,
  getCanYouSession,
  recordCanYouRound,
  getActionIdentificationSession,
  recordActionIdentificationRound,
  getVerbQASession,
  assessVerbQARound,
  recordVerbQANonVerbal,
  recordProbeResult,
};
