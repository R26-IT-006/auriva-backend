'use strict';

const { validationResult } = require('express-validator');
const evaluationService     = require('../services/evaluationService');
const ApiError               = require('../utils/ApiError');

async function getEvaluationStatus(req, res) {
  const data = await evaluationService.getEvaluationStatus(req.user.id, req.params.studentId);
  res.json(data);
}

async function buildEvaluation(req, res) {
  const data = await evaluationService.buildEvaluation(
    req.user.id,
    req.params.studentId,
    req.params.category
  );
  res.json(data);
}

async function recordEvaluation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  const result = await evaluationService.recordEvaluation(
    req.user.id,
    req.params.studentId,
    req.params.category,
    req.body.pairs
  );
  res.json(result);
}

module.exports = {
  getEvaluationStatus,
  buildEvaluation,
  recordEvaluation,
};
