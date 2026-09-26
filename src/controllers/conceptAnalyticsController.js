'use strict';

const conceptAnalyticsService = require('../services/conceptAnalyticsService');

async function getConceptSummary(req, res) {
  const data = await conceptAnalyticsService.getConceptSummary(req.user.id, req.params.id);
  res.json(data);
}

async function getConceptReport(req, res) {
  const data = await conceptAnalyticsService.getConceptReport(
    req.user.id,
    req.params.id,
    req.query.days,
  );
  res.json(data);
}

module.exports = { getConceptSummary, getConceptReport };
