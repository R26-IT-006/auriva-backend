'use strict';

const { validationResult } = require('express-validator');
const dialogueService      = require('../services/dialogueService');
const ApiError             = require('../utils/ApiError');

async function getLevel1Overview(req, res) {
  const data = await dialogueService.getLevel1Overview(req.user.id, req.params.studentId);
  res.json(data);
}

async function getNextWord(req, res) {
  const { category, exclude_word_id, session_passed, status } = req.query;
  const word = await dialogueService.getNextWord(req.user.id, req.params.studentId, {
    category:        category        ?? null,
    exclude_word_id: exclude_word_id ?? null,
    session_passed:  session_passed === 'true' ? true : session_passed === 'false' ? false : null,
    status:          status          ?? null,
  });
  res.json(word ?? { done: true });
}

async function getWordById(req, res) {
  const word = await dialogueService.getWordById(req.params.wordId);
  res.json(word);
}

async function recordPhase1Exposure(req, res) {
  const result = await dialogueService.recordPhase1Exposure(
    req.user.id,
    req.params.studentId,
    req.params.wordId
  );
  res.json(result);
}

async function recordPhase1Gate(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  const result = await dialogueService.recordPhase1Gate(
    req.user.id,
    req.params.studentId,
    req.params.wordId,
    req.body.gate_passed
  );
  res.json(result);
}

async function assessPhase2Speech(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  const result = await dialogueService.assessPhase2Speech(
    req.user.id,
    req.params.studentId,
    req.params.wordId,
    req.body
  );
  res.json(result);
}

async function recordNonVerbalResult(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  const result = await dialogueService.recordNonVerbalResult(
    req.user.id,
    req.params.studentId,
    req.params.wordId,
    req.body
  );
  res.json(result);
}

async function recordPhase3Scenario(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  const result = await dialogueService.recordPhase3Scenario(
    req.user.id,
    req.params.studentId,
    req.params.wordId,
    req.body
  );
  res.json(result);
}

async function recordPhase3Result(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  const result = await dialogueService.recordPhase3Result(
    req.user.id,
    req.params.studentId,
    req.params.wordId,
    req.body
  );
  res.json(result);
}

async function getProbeCandidate(req, res) {
  const { category } = req.query;
  const word = await dialogueService.getProbeCandidate(
    req.user.id,
    req.params.studentId,
    category ?? null
  );
  res.json(word ?? { done: true });
}

async function recordProbeResult(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  const result = await dialogueService.recordProbeResult(
    req.user.id,
    req.params.studentId,
    req.params.wordId,
    req.body
  );
  res.json(result);
}

module.exports = {
  getLevel1Overview,
  getNextWord,
  getWordById,
  recordPhase1Exposure,
  recordPhase1Gate,
  assessPhase2Speech,
  recordNonVerbalResult,
  recordPhase3Scenario,
  recordPhase3Result,
  getProbeCandidate,
  recordProbeResult,
};
