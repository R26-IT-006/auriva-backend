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

const PROFESSIONALS_SEQUENCE = [
  'baker', 'carpenter', 'cashier', 'doctor',
  'farmer', 'nurse', 'principal', 'teacher',
];

const ANIMALS_SEQUENCE = [
  'ant', 'bull', 'butterfly', 'cat', 'caterpillar', 'cock',
  'cow', 'crow', 'dog', 'elephant', 'goat', 'hen',
  'horse', 'lion', 'owl', 'parrot', 'peacock', 'rabbit',
  'snake', 'sparrow', 'tiger',
];

const HOUSE_SEQUENCE = [
  'door', 'roof', 'wall', 'windows',
];

const NUMBERS_SEQUENCE = [
  'one', 'two', 'three', 'four', 'five',
  'six', 'seven', 'eight', 'nine', 'ten',
];

const SHAPES_SEQUENCE = [
  'circle', 'square', 'rectangle', 'triangle',
];

const COLORS_SEQUENCE = [
  'red', 'blue', 'green', 'yellow', 'orange',
  'pink', 'purple', 'brown', 'black', 'white',
];

const CLASSROOM_SEQUENCE = [
  'bag', 'blackboard', 'book', 'bottle', 'chair',
  'desk', 'dustbin', 'eraser', 'pencil', 'ruler', 'table',
];

const HOUSEHOLD_SEQUENCE = [
  'bed', 'brush', 'comb', 'cup', 'fork',
  'glass', 'knife', 'mug', 'pillows', 'plate',
  'soap', 'spoon', 'toothbrush', 'toothpaste',
];

const CATEGORY_SEQUENCES = {
  fruits:        FRUIT_SEQUENCE,
  professionals: PROFESSIONALS_SEQUENCE,
  animals:       ANIMALS_SEQUENCE,
  house:     HOUSE_SEQUENCE,
  numbers:   NUMBERS_SEQUENCE,
  shapes:    SHAPES_SEQUENCE,
  colors:    COLORS_SEQUENCE,
  classroom: CLASSROOM_SEQUENCE,
  household: HOUSEHOLD_SEQUENCE,
};

function getSequence(categoryKey) {
  return CATEGORY_SEQUENCES[categoryKey] || [];
}

// ─── Service functions ────────────────────────────────────────────────────────

/**
 * Returns concept items for a category with this student's progress rows.
 * When GKB confusion data is available the sequence is reordered so that
 * concepts the student mixed up are inserted right after the concept they
 * were confused during, and the unlock chain is recalculated accordingly.
 *
 * Example: original order Apple→Banana→Cherry→Grapes→Guava→Mango
 *   Student passes Grapes but confuses Mango.
 *   Reordered: Apple→Banana→Cherry→Grapes→Mango→Guava→…
 *   Mango becomes unlocked (Grapes passed), Guava becomes locked (Mango not yet passed).
 */
async function getConceptItems(categoryKey, studentId) {
  const sequence = getSequence(categoryKey);
  if (!sequence.length) throw new ApiError(404, `Category '${categoryKey}' not found`);

  const progressRows = await StudentConceptProgress.findAll({
    where: { student_id: studentId, category_key: categoryKey },
  });

  const progressMap = {};
  progressRows.forEach((row) => { progressMap[row.concept_key] = row; });

  // Determine the working sequence (default = original)
  let orderedSequence = sequence;

  try {
    const resp = await axios.get(
      `${GNN_BASE}/gkb/student/${studentId}/category/${categoryKey}/confusions`,
      { timeout: 500 },
    );
    const confusions = resp.data?.confusions || [];

    if (confusions.length > 0) {
      // Build map: correctKey → [confusedKey sorted by weight desc]
      const confusionMap = {};
      confusions.forEach((c) => {
        const correct  = c.correct_key.split('/').pop();
        const confused = c.confused_key.split('/').pop();
        if (!confusionMap[correct]) confusionMap[correct] = [];
        confusionMap[correct].push({ key: confused, weight: c.weight });
      });
      Object.values(confusionMap).forEach((arr) => arr.sort((a, b) => b.weight - a.weight));

      // Walk the original sequence; after each concept insert its confused
      // siblings (if not already placed) immediately behind it.
      const placed = new Set();
      const result = [];
      for (const key of sequence) {
        if (placed.has(key)) continue;
        placed.add(key);
        result.push(key);
        for (const { key: confused } of confusionMap[key] || []) {
          if (!placed.has(confused) && sequence.includes(confused)) {
            placed.add(confused);
            result.push(confused);
          }
        }
      }
      orderedSequence = result;
    }
  } catch { /* GKB unavailable — keep standard order */ }

  // Build items using the (possibly reordered) sequence.
  // Unlock rule: passed concepts are always unlocked; others unlock when
  // the preceding concept in the adaptive order has been passed.
  return orderedSequence.map((conceptKey, index) => {
    const row            = progressMap[conceptKey];
    const prevKey        = index > 0 ? orderedSequence[index - 1] : null;
    const prevRow        = prevKey ? progressMap[prevKey] : null;
    const isPassed       = row?.tier1_status === 'passed';
    const isUnlocked     = isPassed || index === 0 || !!(prevRow && prevRow.tier1_status === 'passed');
    const originalIndex  = sequence.indexOf(conceptKey);
    // Priority: moved earlier in the sequence AND unlocked AND not yet passed
    const isPriority     = isUnlocked && !isPassed && originalIndex !== index;

    return {
      concept_key:    conceptKey,
      category_key:   categoryKey,
      sequence_index: index,
      is_unlocked:    isUnlocked,
      is_priority:    isPriority,
      tier1_status:   row?.tier1_status || 'not_started',
      tier1_score:    row?.tier1_score  ?? null,
      tier2_status:   row?.tier2_status || 'locked',
      tier3_status:   row?.tier3_status || 'locked',
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

  if (!created) {
    if (row.tier1_status === 'not_started') {
      await row.update({ tier1_status: 'in_progress' });
    } else if (row.tier1_status === 'failed') {
      await row.update({ tier1_status: 'in_progress', tier1_retry_count: row.tier1_retry_count + 1 });
    }
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
    event_data:   { score, attempt_count: attemptCount, confused_with: confusedWith, retry_count: row.tier1_retry_count ?? 0 },
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

/**
 * Returns unique concept keys this student confused with the given conceptKey,
 * sourced from the GKB confusion edges (sorted by weight desc).
 * Falls back to PostgreSQL interaction logs if GKB is unreachable.
 */
async function getConfusions(studentId, conceptKey) {
  try {
    // Primary: query GKB via FastAPI
    const resp = await axios.get(
      `${GNN_BASE}/gkb/student/${studentId}/concept/fruits/${conceptKey}/confusions`
    );
    const confusedKeys = (resp.data?.confused_keys || []).slice(0, 2);
    if (confusedKeys.length > 0) return { confused_keys: confusedKeys };
  } catch { /* fall through to PostgreSQL fallback */ }

  // Fallback: derive from the most recent tier1_fail interaction log
  const failLog = await ConceptInteractionLog.findOne({
    where: { student_id: studentId, concept_key: conceptKey, event_type: 'tier1_fail', tier: 1 },
    order: [['created_at', 'DESC']],
  });

  const confusedWith = failLog?.event_data?.confused_with || [];
  const confusedKeys = [...new Set(confusedWith.map((c) => c.selected_key))].slice(0, 2);
  return { confused_keys: confusedKeys };
}

/**
 * Logs a single adaptive (2-image) quiz attempt to concept_interaction_logs.
 */
async function logAdaptiveAttempt(studentId, sessionId, categoryKey, conceptKey, confusedConceptKey, roundNumber, wasCorrect, timeTakenMs) {
  const log = await ConceptInteractionLog.create({
    student_id:   studentId,
    session_id:   sessionId || null,
    category_key: categoryKey,
    concept_key:  conceptKey,
    tier:         1,
    event_type:   'adaptive_attempt',
    event_data:   {
      confused_concept_key: confusedConceptKey,
      round_number:         roundNumber,
      was_correct:          wasCorrect,
      time_taken_ms:        timeTakenMs || null,
    },
    created_at: new Date(),
  });
  return { id: log.id };
}

/**
 * Completes an adaptive quiz session: logs the outcome and forwards any
 * remaining confusion increments to GKB (fire-and-forget).
 */
async function completeAdaptive(studentId, sessionId, categoryKey, conceptKey, confusedKeys, roundResults, allPassed) {
  await ConceptInteractionLog.create({
    student_id:   studentId,
    session_id:   sessionId || null,
    category_key: categoryKey,
    concept_key:  conceptKey,
    tier:         1,
    event_type:   allPassed ? 'adaptive_pass' : 'adaptive_fail',
    event_data:   { confused_keys: confusedKeys, round_results: roundResults, all_passed: allPassed },
    created_at:   new Date(),
  });

  // Passing the adaptive quiz promotes the concept to 'passed' in PostgreSQL
  if (allPassed) {
    const now = new Date();
    const [row, created] = await StudentConceptProgress.findOrCreate({
      where:    { student_id: studentId, category_key: categoryKey, concept_key: conceptKey },
      defaults: { tier1_status: 'passed', tier1_passed_at: now },
    });
    if (!created && row.tier1_status !== 'passed') {
      await row.update({ tier1_status: 'passed', tier1_passed_at: now });
    }
  }

  // If student got any rounds wrong, increment CONFUSION edges in GKB
  const wrongKeys = (roundResults || [])
    .filter((r) => !r.was_correct)
    .map((r) => r.confused_concept_key)
    .filter(Boolean);

  if (wrongKeys.length > 0) {
    syncToGkb('/gkb/adaptive/confusion', {
      correct_key:   conceptKey,
      category_key:  categoryKey,
      confused_with: wrongKeys,
    });
  }

  return { completed: true, all_passed: allPassed };
}

/**
 * Marks a concept's Tier 2 as in_progress.
 */
async function startTier2(studentId, categoryKey, conceptKey) {
  const [row, created] = await StudentConceptProgress.findOrCreate({
    where:    { student_id: studentId, category_key: categoryKey, concept_key: conceptKey },
    defaults: { tier2_status: 'in_progress' },
  });
  if (!created) {
    if (row.tier2_status === 'locked' || row.tier2_status === 'not_started') {
      await row.update({ tier2_status: 'in_progress' });
    } else if (row.tier2_status === 'failed') {
      await row.update({ tier2_status: 'in_progress', tier2_retry_count: row.tier2_retry_count + 1 });
    }
  }
  return { started: true };
}

/**
 * Finalises Tier 2 (pass or fail), logs the outcome, and syncs GKB edges.
 */
async function completeTier2(studentId, categoryKey, conceptKey, passed, score, attemptCount, confusedWith) {
  const now = new Date();
  const updateFields = { tier2_status: passed ? 'passed' : 'failed' };

  const [row, created] = await StudentConceptProgress.findOrCreate({
    where:    { student_id: studentId, category_key: categoryKey, concept_key: conceptKey },
    defaults: updateFields,
  });
  if (!created && row.tier2_status !== 'passed') {
    await row.update(updateFields);
  }

  await ConceptInteractionLog.create({
    student_id:   studentId,
    category_key: categoryKey,
    concept_key:  conceptKey,
    tier:         2,
    event_type:   passed ? 'tier2_pass' : 'tier2_fail',
    event_data:   { score, attempt_count: attemptCount, confused_with: confusedWith, retry_count: row.tier2_retry_count ?? 0 },
    created_at:   now,
  });

  Student.findByPk(studentId).then((student) => {
    const fullName = student?.full_name || null;

    syncToGkb('/gkb/tier2/score', {
      student_id:    studentId,
      full_name:     fullName,
      concept_key:   conceptKey,
      category_key:  categoryKey,
      score,
      attempt_count: attemptCount,
      passed,
      confused_with: confusedWith || [],
    });

    return ConceptInteractionLog.findAll({
      where: { student_id: studentId, category_key: categoryKey, concept_key: conceptKey, event_type: 'image_tap', tier: 2 },
      order: [['created_at', 'DESC']],
      limit: 100,
    }).then((tapLogs) => {
      syncToGkb('/gkb/tier2/engagement', {
        student_id:    studentId,
        full_name:     fullName,
        concept_key:   conceptKey,
        category_key:  categoryKey,
        tap_count:     tapLogs.length,
        time_spent_ms: tapLogs.length > 0 ? (tapLogs[0].event_data?.time_ms || 0) : 0,
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

/**
 * Marks a concept's Tier 3 as in_progress.
 */
async function startTier3(studentId, categoryKey, conceptKey) {
  const [row, created] = await StudentConceptProgress.findOrCreate({
    where:    { student_id: studentId, category_key: categoryKey, concept_key: conceptKey },
    defaults: { tier3_status: 'in_progress' },
  });
  if (!created && (row.tier3_status === 'locked' || row.tier3_status === 'not_started')) {
    await row.update({ tier3_status: 'in_progress' });
  }
  return { started: true };
}

/**
 * Finalises Tier 3 (video watched), logs the outcome.
 */
async function completeTier3(studentId, categoryKey, conceptKey, timeSpentMs) {
  const now = new Date();

  const [row, created] = await StudentConceptProgress.findOrCreate({
    where:    { student_id: studentId, category_key: categoryKey, concept_key: conceptKey },
    defaults: { tier3_status: 'passed' },
  });
  if (!created && row.tier3_status !== 'passed') {
    await row.update({ tier3_status: 'passed' });
  }

  await ConceptInteractionLog.create({
    student_id:   studentId,
    category_key: categoryKey,
    concept_key:  conceptKey,
    tier:         3,
    event_type:   'tier3_complete',
    event_data:   { time_spent_ms: timeSpentMs || 0 },
    created_at:   now,
  });

  return { completed: true };
}

module.exports = { getConceptItems, startTier1, logInteraction, completeTier1, getConfusions, logAdaptiveAttempt, completeAdaptive, startTier2, completeTier2, startTier3, completeTier3 };
