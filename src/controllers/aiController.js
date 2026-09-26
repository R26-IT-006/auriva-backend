'use strict';

const aiSummaryService = require('../services/aiSummaryService');

// Both handlers always answer 200. An unavailable summary is a normal state, not
// an error — the screens that call these render fine without one, and a 500 here
// would surface as a failure banner on a report that loaded perfectly well.

async function getConceptNarrative(req, res) {
  const data = await aiSummaryService.getConceptNarrative(req.user.id, req.params.id, {
    refresh: req.query.refresh === 'true',
  });
  res.json(data);
}

async function getClassDigest(req, res) {
  const data = await aiSummaryService.getClassDigest(req.user.id, {
    refresh: req.query.refresh === 'true',
  });
  res.json(data);
}

module.exports = { getConceptNarrative, getClassDigest };
