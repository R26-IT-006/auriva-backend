'use strict';

// STUB — always returns 'typical' until TASK-04's /predict-trajectory endpoint
// exists. Replace only the body of this function when wiring in real
// predictions; dialogueService.js and category3Service.js already depend on
// this exact signature, do not change it without updating both callers.
//
// This is a deliberate exception to this codebase's usual per-service
// duplication pattern (see TASK-37's getProbeCandidate for the precedent):
// this function has no category-specific table access today, and will
// eventually be a single external HTTP call to the microservice once TASK-04
// exists — that must never be duplicated once it's real, so don't duplicate
// the stub either.
async function getTrajectoryPrediction(studentId, wordId) {
  return 'typical';
}

module.exports = { getTrajectoryPrediction };
