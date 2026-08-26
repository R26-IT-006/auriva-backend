'use strict';

const { Op }                  = require('sequelize');
const { StudentConceptProgress, ConceptInteractionLog, Student } = require('../models');
const ApiError                = require('../utils/ApiError');
const logger                  = require('../utils/logger');
const axios                   = require('axios');

const GNN_BASE = process.env.GNN_SERVICE_URL || 'http://localhost:8000';

// Content similarity between concepts, precomputed offline by gnn-backend/ml/features.py
// from the artwork the child is actually shown and from the English/Sinhala labels.
//
// Deliberately a static require rather than a GKB lookup: this feeds the distractor
// FALLBACK, so it has to work in exactly the situation the fallback exists for —
// the graph being unreachable or empty. Loaded once at startup; ~66 KB.
//
// Not every category supports every kind. features.py drops a kind for a category
// when it does not actually separate that category's concepts — the number and
// shape icons are near-identical badges distinguished only by a small glyph, so
// ranking them visually would be noise dressed up as a recommendation.
let CONCEPT_SIMILARITY = { concepts: {} };
try {
  CONCEPT_SIMILARITY = require('../data/concept_similarity.json');
} catch {
  // Absent in a checkout that has not run features.py — getDistractors just falls
  // through to sequential neighbours, exactly as it did before.
  logger.warn('concept_similarity.json not found; content-based distractors disabled');
}

// ─── Shared scoring rules ────────────────────────────────────────────────────
// Both live here because this is the lowest-level concept module — activityService,
// conceptAnalyticsService and teacherService all depend on it, so a single home
// stops the pass bar and the meaning of "mastered" drifting apart again.

/** The pass bar every tier screen scores against (2 of 3 attempts). */
const PASS_SCORE = 2 / 3;

/**
 * A concept counts as mastered only once the child has done BOTH the image-match
 * (tier 1) and the name-match (tier 2). Tier 3 is excluded deliberately: it is a
 * video watch with no assessment, so counting it would measure exposure, not mastery.
 */
const isMastered = (row) =>
  row.tier1_status === 'passed' && row.tier2_status === 'passed';

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

// ─── Ordering helpers ─────────────────────────────────────────────────────────

/**
 * Builds a confusionMap from GKB-style records: [{ correct_key, confused_key, weight }]
 * Keys are bare (without category prefix).
 */
function buildConfusionMapFromGkb(confusions) {
  const map = {};
  confusions.forEach((c) => {
    const correct  = c.correct_key.split('/').pop();
    const confused = c.confused_key.split('/').pop();
    if (!map[correct]) map[correct] = [];
    map[correct].push({ key: confused, weight: c.weight });
  });
  Object.values(map).forEach((arr) => arr.sort((a, b) => b.weight - a.weight));
  return map;
}

/**
 * Derives a confusionMap from tier1_fail logs stored in PostgreSQL.
 * Used when GKB is unavailable or hasn't synced the latest results yet.
 */
async function buildConfusionMapFromLogs(studentId, categoryKey) {
  const failLogs = await ConceptInteractionLog.findAll({
    where: { student_id: studentId, category_key: categoryKey, event_type: 'tier1_fail', tier: 1 },
  });
  const map = {};
  failLogs.forEach((log) => {
    const confusedWith = log.event_data?.confused_with || [];
    confusedWith.forEach(({ correct_key, selected_key }) => {
      if (!correct_key || !selected_key) return;
      if (!map[correct_key]) map[correct_key] = [];
      if (!map[correct_key].find((x) => x.key === selected_key)) {
        map[correct_key].push({ key: selected_key, weight: 1 });
      }
    });
  });
  return map;
}

/**
 * Re-orders a concept sequence so that confused siblings appear immediately
 * after the concept they were confused during.
 */
function applyConfusionOrdering(sequence, confusionMap) {
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
  return result;
}

// ─── Service functions ────────────────────────────────────────────────────────

/**
 * Returns concept items for a category with this student's progress rows.
 * When confusion data is available (from GKB or PostgreSQL logs) the sequence
 * is reordered so confused concepts are inserted right after the concept they
 * were confused during, and the unlock chain is recalculated accordingly.
 *
 * Example: original order Apple→Banana→Cherry→Grapes→Guava→Mango
 *   Student passes Grapes but confuses Mango.
 *   Reordered: Apple→Banana→Cherry→Grapes→Mango→Guava→…
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
    let confusionMap = confusions.length > 0 ? buildConfusionMapFromGkb(confusions) : {};

    // GKB returned nothing — GKB sync may not have completed yet (fire-and-forget lag).
    // Fall back to PostgreSQL logs which are always written before completeTier1 returns.
    if (Object.keys(confusionMap).length === 0) {
      confusionMap = await buildConfusionMapFromLogs(studentId, categoryKey);
    }

    if (Object.keys(confusionMap).length > 0) {
      orderedSequence = applyConfusionOrdering(sequence, confusionMap);
    }
  } catch {
    // GKB service unreachable — derive ordering directly from PostgreSQL logs.
    try {
      const confusionMap = await buildConfusionMapFromLogs(studentId, categoryKey);
      if (Object.keys(confusionMap).length > 0) {
        orderedSequence = applyConfusionOrdering(sequence, confusionMap);
      }
    } catch { /* ignore — keep standard order */ }
  }

  // Build items using the (possibly reordered) sequence.
  //
  // Every concept is open. The sequence still carries the recommended order —
  // adaptive reordering and is_priority both still apply — but nothing is gated
  // behind passing the concept before it, so a teacher can start anywhere.
  return orderedSequence.map((conceptKey, index) => {
    const row            = progressMap[conceptKey];
    const isPassed       = row?.tier1_status === 'passed';
    const isUnlocked     = true;
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

  // Log the outcome event. Its id is the observation id sent to the GKB, which
  // makes the confusion increments idempotent — a retried delivery is a no-op
  // rather than an inflated weight.
  const outcomeLog = await ConceptInteractionLog.create({
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
      observation_id: outcomeLog.id,
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
 * Logs a single adaptive (2-image) quiz attempt to concept_interaction_logs.
 */
async function logAdaptiveAttempt(studentId, sessionId, categoryKey, conceptKey, confusedConceptKey, roundNumber, wasCorrect, timeTakenMs, exposure = {}) {
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
      // What the child was shown, and which distractor source picked it. See the
      // note in conceptController.logMatchAttempt.
      option_keys:          exposure.option_keys || null,
      distractor_source:    exposure.distractor_source || null,
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
  const adaptiveLog = await ConceptInteractionLog.create({
    student_id:   studentId,
    session_id:   sessionId || null,
    category_key: categoryKey,
    concept_key:  conceptKey,
    tier:         1,
    event_type:   allPassed ? 'adaptive_pass' : 'adaptive_fail',
    event_data:   { confused_keys: confusedKeys, round_results: roundResults, all_passed: allPassed },
    created_at:   new Date(),
  });

  // Passing the adaptive quiz promotes the concept to 'passed' in PostgreSQL.
  //
  // The score has to move up with the status. Leaving it at the failing value the
  // first quiz wrote would store the concept as passed-at-0.33, and that number is
  // read as strength — activityService would keep the concept at the top of its
  // weakest-first re-test queue and let it drag activity difficulty down, while the
  // teacher screens would show a failing percentage on a concept the child passed.
  //
  // We raise it to exactly the pass bar rather than to 1.0: the adaptive quiz is a
  // 2-choice remediation that requires every round correct, so scoring it on its own
  // terms would always yield a perfect score and rank a remediated concept above one
  // passed 2/3 first time. `max` so a re-run can never lower an existing better score.
  if (allPassed) {
    const now = new Date();
    const [row, created] = await StudentConceptProgress.findOrCreate({
      where:    { student_id: studentId, category_key: categoryKey, concept_key: conceptKey },
      defaults: { tier1_status: 'passed', tier1_score: PASS_SCORE, tier1_passed_at: now },
    });
    if (!created && row.tier1_status !== 'passed') {
      await row.update({
        tier1_status:    'passed',
        tier1_score:     Math.max(row.tier1_score ?? 0, PASS_SCORE),
        tier1_passed_at: now,
      });
    }
  }

  // If student got any rounds wrong, increment CONFUSION edges in GKB
  const wrongKeys = (roundResults || [])
    .filter((r) => !r.was_correct)
    .map((r) => r.confused_concept_key)
    .filter(Boolean);

  if (wrongKeys.length > 0) {
    syncToGkb('/gkb/adaptive/confusion', {
      observation_id: adaptiveLog?.id ?? null,
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

  const t2Log = await ConceptInteractionLog.create({
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
      observation_id: t2Log?.id ?? null,
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

/**
 * Returns 2 personalised distractor concept keys for a student + concept + tier.
 *
 * Priority order:
 *  1. GKB bidirectional confusion query (personalised, live)
 *  2. PostgreSQL interaction logs (always available, handles GKB sync lag)
 *  3. Sequential neighbours (last resort)
 */
async function getDistractors(studentId, categoryKey, conceptKey, tier) {
  const sequence = getSequence(categoryKey);
  const idx      = sequence.indexOf(conceptKey);
  const sequential = [
    sequence[(idx + 1) % sequence.length],
    sequence[(idx + 2) % sequence.length],
  ].filter((k) => k && k !== conceptKey);

  // Exploration: with probability EXPLORE_RATE, swap one distractor for a random
  // in-category concept.
  //
  // Without this the system only ever collects evidence about pairs it already
  // believes are confusable, so it can never discover a new one — and neither can
  // any model trained on its logs. ml/PHASE1-FINDINGS.md measured the result: 97%
  // of observed confusions were with a sequential neighbour, because those were
  // the only options ever shown. That makes offline evaluation of distractor
  // quality impossible, for the current heuristic and for any future model.
  //
  // Deliberately small, and it only ever substitutes a real concept from the same
  // category the child is already working in — so a round stays answerable and on
  // topic. Set EXPLORE_RATE=0 to disable.
  const explore = (picked, source) => {
    const rate = Number(process.env.EXPLORE_RATE ?? 0.15);
    if (!(rate > 0) || Math.random() >= rate || picked.length === 0) {
      return { distractors: picked, distractor_source: source };
    }
    const pool = sequence.filter((k) => k !== conceptKey && !picked.includes(k));
    if (pool.length === 0) return { distractors: picked, distractor_source: source };
    const swapIn  = pool[Math.floor(Math.random() * pool.length)];
    const swapPos = Math.floor(Math.random() * picked.length);
    const out = [...picked];
    out[swapPos] = swapIn;
    return { distractors: out, distractor_source: `${source}+explore` };
  };

  // 1. Try GKB
  //
  // 800ms, not 400. At 400 this call had never once succeeded: the endpoint makes
  // four sequential round trips to Neo4j AuraDB and measures ~590ms steady-state
  // (10 consecutive calls: 0.59-0.64s), so the deadline expired before the answer
  // arrived every single time. The graph was returning correct, personalised
  // distractors the whole while — nothing downstream ever saw them, and no logged
  // attempt in the entire collection window carries distractor_source='gkb'.
  //
  // This is the quick fix and it buys the child's wait: ~600ms per question rather
  // than a 400ms write-off. The real fix is collapsing those four round trips into
  // one in gkb_service.get_student_confusions, which would bring this back under
  // 400ms — until then this timeout is the thing keeping the graph switched on.
  //
  // A cold first call was measured at 1.14s and will still miss. That degrades to
  // the fallback chain below, which is the intended behaviour.
  try {
    const resp = await axios.get(
      `${GNN_BASE}/gkb/student/${studentId}/distractors`,
      { params: { category_key: categoryKey, concept_key: conceptKey, tier }, timeout: 800 },
    );
    const distractors = resp.data?.distractors || [];
    if (distractors.length >= 2) return explore(distractors, 'gkb');
  } catch { /* fall through */ }

  // 2. Derive from PostgreSQL logs (bidirectional: FROM this concept + TO this concept)
  try {
    const eventType = tier === 2 ? 'tier2_fail' : 'tier1_fail';

    // FROM: this concept's fail logs → what the student picked instead
    const fromLogs = await ConceptInteractionLog.findAll({
      where: { student_id: studentId, category_key: categoryKey, concept_key: conceptKey, event_type: eventType },
      order: [['created_at', 'DESC']], limit: 10,
    });
    const fromKeys = [];
    fromLogs.forEach((log) => {
      (log.event_data?.confused_with || []).forEach(({ selected_key }) => {
        if (selected_key && selected_key !== conceptKey && !fromKeys.includes(selected_key))
          fromKeys.push(selected_key);
      });
    });

    // TO: other concepts' fail logs where the student picked THIS concept
    const allFailLogs = await ConceptInteractionLog.findAll({
      where: { student_id: studentId, category_key: categoryKey, event_type: eventType },
      order: [['created_at', 'DESC']], limit: 100,
    });
    const toKeys = [];
    allFailLogs.forEach((log) => {
      if (log.concept_key === conceptKey) return;
      (log.event_data?.confused_with || []).forEach(({ selected_key }) => {
        if (selected_key === conceptKey && !toKeys.includes(log.concept_key))
          toKeys.push(log.concept_key);
      });
    });

    const combined = [...new Set([...fromKeys, ...toKeys])].filter((k) => sequence.includes(k));
    if (combined.length >= 2) return explore(combined.slice(0, 2), 'logs');
    if (combined.length === 1) {
      const rest = sequential.filter((k) => !combined.includes(k));
      return explore([...combined, ...rest].slice(0, 2), 'logs+sequential');
    }
  } catch { /* fall through */ }

  // 3. Content similarity — what the concepts look like (tier 1, the child is
  // matching pictures) or what their names sound like (tier 2, matching names).
  //
  // This tier exists because the sequential fallback below is arbitrary: apple got
  // banana and cherry purely by list order. Children confuse apple and tomato
  // because they look alike, and cat and cap because they sound alike, and until
  // now nothing in the system knew either.
  //
  // It also matters for the data. PHASE1-FINDINGS.md measured 97% of observed
  // confusions landing on a concept 1-2 positions ahead in the sequence — not a
  // fact about children, but an artefact of what the fallback showed them. Serving
  // something meaningful here breaks that confound at the source.
  const kind = tier === 2 ? 'phonetic' : 'visual';
  const similar = CONCEPT_SIMILARITY.concepts?.[`${categoryKey}/${conceptKey}`]?.[kind];
  if (similar?.length) {
    const picked = similar
      .map((s) => s.key)
      .filter((k) => k !== conceptKey && sequence.includes(k))
      .slice(0, 2);
    if (picked.length >= 2) return explore(picked, kind);
  }

  // 4. Sequential neighbours — the last resort, now reached only where content
  // similarity is unavailable or unusable for the category.
  return explore(sequential, 'sequential');
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

module.exports = { getConceptItems, startTier1, logInteraction, completeTier1, getDistractors, logAdaptiveAttempt, completeAdaptive, startTier2, completeTier2, startTier3, completeTier3, getSequence, CATEGORY_SEQUENCES, syncToGkb, PASS_SCORE, isMastered };
