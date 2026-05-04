'use strict';

const { Op }                  = require('sequelize');
const { StudentConceptProgress, ConceptInteractionLog, Student } = require('../models');
const ApiError                = require('../utils/ApiError');
const logger                  = require('../utils/logger');
const axios                   = require('axios');

const GNN_BASE = process.env.GNN_SERVICE_URL || 'http://localhost:8000';

// ─── GKB forwarding (fire-and-forget) ────────────────────────────────────────

function syncToGkb(path, payload) {
  axios.post(`${GNN_BASE}${path}`, payload).catch((err) =>
    logger.warn(`GKB sync failed [${path}]: ${err.message}`)
  );
}

// ─── Concept catalogue (static, matches frontend conceptData.js) ─────────────

const FRUIT_SEQUENCE = [
  'apple', 'banana', 'cherry', 'grapes', 'guava',
  'mango', 'orange', 'papaya', 'passion', 'pineapple', 'watermelon',
];

const CATEGORY_SEQUENCES = {
  fruits: FRUIT_SEQUENCE,
};

function getSequence(categoryKey) {
  return CATEGORY_SEQUENCES[categoryKey] || [];
}

// ─── Service functions ────────────────────────────────────────────────────────

/**
 * Returns concept items for a category with this student's progress rows.
 */
async function getConceptItems(categoryKey, studentId) {
  const sequence = getSequence(categoryKey);
  if (!sequence.length) throw new ApiError(404, `Category '${categoryKey}' not found`);

  const progressRows = await StudentConceptProgress.findAll({
    where: { student_id: studentId, category_key: categoryKey },
  });

  const progressMap = {};
  progressRows.forEach((row) => { progressMap[row.concept_key] = row; });

  return sequence.map((conceptKey, index) => {
    const row = progressMap[conceptKey];
    const prevConceptKey = index > 0 ? sequence[index - 1] : null;
    const prevRow = prevConceptKey ? progressMap[prevConceptKey] : null;

    // First item always unlocked; subsequent items unlock after previous passes tier1
    const isUnlocked =
      index === 0 ||
      (prevRow && prevRow.tier1_status === 'passed');

    return {
      concept_key:    conceptKey,
      category_key:   categoryKey,
      sequence_index: index,
      is_unlocked:    isUnlocked,
      tier1_status:   row?.tier1_status   || 'not_started',
      tier1_score:    row?.tier1_score    ?? null,
      tier2_status:   row?.tier2_status   || 'locked',
      tier3_status:   row?.tier3_status   || 'locked',
    };
  });
}

/**
 * Marks a concept's Tier 1 as in_progress and ensures GKB student node.
 * Never overwrites a 'passed' or 'failed' status — only advances from 'not_started'.
 */
async function startTier1(studentId, categoryKey, conceptKey) {
  const student = await assertStudentExists(studentId);

  const [row, created] = await StudentConceptProgress.findOrCreate({
    where:    { student_id: studentId, category_key: categoryKey, concept_key: conceptKey },
    defaults: { tier1_status: 'in_progress' },
  });

  if (!created && row.tier1_status === 'not_started') {
    await row.update({ tier1_status: 'in_progress' });
  }

  syncToGkb(`/gkb/student/${studentId}`, {
    student_key: `student/${studentId}`,
    full_name:   student.full_name || null,
  });

  return { started: true };
}

/**
 * Appends a raw interaction event to concept_interaction_logs.
 */
async function logInteraction(studentId, sessionId, categoryKey, conceptKey, tier, eventType, eventData) {
  const log = await ConceptInteractionLog.create({
    student_id:   studentId,
    session_id:   sessionId || null,
    category_key: categoryKey,
    concept_key:  conceptKey,
    tier,
    event_type:   eventType,
    event_data:   eventData || {},
    created_at:   new Date(),
  });
  return { id: log.id };
}

/**
 * Finalises Tier 1 (pass or fail), updates progress, unlocks next concept,
 * and forwards GKB edge updates to the FastAPI service.
 */
async function completeTier1(studentId, categoryKey, conceptKey, passed, score, attemptCount, confusedWith) {
  const now = new Date();

  const updateFields = {
    tier1_status:   passed ? 'passed' : 'failed',
    tier1_score:    score,
    tier1_attempts: attemptCount,
    ...(passed && { tier1_passed_at: now }),
  };

  const [row, created] = await StudentConceptProgress.findOrCreate({
    where:    { student_id: studentId, category_key: categoryKey, concept_key: conceptKey },
    defaults: updateFields,
  });

  // Never downgrade a passed concept — once passed, always passed
  if (!created && row.tier1_status !== 'passed') {
    await row.update(updateFields);
  }

  // Log the outcome event
  await ConceptInteractionLog.create({
    student_id:   studentId,
    category_key: categoryKey,
    concept_key:  conceptKey,
    tier:         1,
    event_type:   passed ? 'tier1_pass' : 'tier1_fail',
    event_data:   { score, attempt_count: attemptCount, confused_with: confusedWith },
    created_at:   now,
  });

  // Look up student name once, then fire both GKB syncs
  Student.findByPk(studentId).then((student) => {
    const fullName = student?.full_name || null;

    syncToGkb('/gkb/tier1/score', {
      student_id:    studentId,
      full_name:     fullName,
      concept_key:   conceptKey,
      category_key:  categoryKey,
      score,
      attempt_count: attemptCount,
      passed,
      confused_with: confusedWith || [],
    });

    // Aggregate image-tap logs to build the T1_ENGAGEMENT edge
    return ConceptInteractionLog.findAll({
      where: { student_id: studentId, category_key: categoryKey, concept_key: conceptKey, event_type: 'image_tap', tier: 1 },
      order: [['created_at', 'DESC']],
      limit: 100,
    }).then((tapLogs) => {
      syncToGkb('/gkb/tier1/engagement', {
        student_id:    studentId,
        full_name:     fullName,
        concept_key:   conceptKey,
        category_key:  categoryKey,
        tap_count:     tapLogs.length,
        time_spent_ms: tapLogs.length > 0 ? (tapLogs[0].event_data?.time_ms || 0) : 0,
        image_format:  'real',
      });
    });
  }).catch(() => {});

  return { completed: true, passed };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function assertStudentExists(studentId) {
  const student = await Student.findByPk(studentId);
  if (!student) throw new ApiError(404, `Student ${studentId} not found`);
  return student;
}

module.exports = { getConceptItems, startTier1, logInteraction, completeTier1 };
