'use strict';

const { StudentConceptProgress, StudentActivity } = require('../models');
const ApiError = require('../utils/ApiError');
const logger   = require('../utils/logger');
const {
  getSequence,
  getDistractors,
  syncToGkb,
  logInteraction,
  PASS_SCORE,
  isMastered,
} = require('./conceptService');

// Activity events share the concept_interaction_logs table but live in their own
// tier bucket, so every existing query (all of which filter on tier 1/2/3) ignores them.
const ACTIVITY_TIER = 4;

const THRESHOLD    = 3;      // concepts that must be mastered to trigger an activity
const MAX_REROLLS  = 5;      // signature-collision retries before we accept a repeat

// Requiring both tier 1 and tier 2 guarantees every round type an activity can
// produce tests a skill the child has actually been taught. Defined in
// conceptService so the dashboard and the analytics report agree with this.
const MASTERY_PREDICATE = isMastered;

// ─── Difficulty ──────────────────────────────────────────────────────────────

// Round types: I = image choice, N = name choice, D = drag & drop.
// Levers escalate in this order: option count → question-type mix → distractor
// similarity → distractor provenance → round count.
// Ordering rules baked into every sequence: always open on I (most familiar format,
// buys an early success), never end on D or N, never two D adjacent.
const ACTIVITY_LEVELS = {
  1: { rounds: 3, options: 2, sequence: ['I', 'I', 'I'],                     smartDistractors: false, preferTargets: false },
  2: { rounds: 3, options: 3, sequence: ['I', 'I', 'I'],                     smartDistractors: false, preferTargets: false },
  3: { rounds: 4, options: 3, sequence: ['I', 'I', 'N', 'I'],                smartDistractors: true,  preferTargets: false },
  4: { rounds: 5, options: 3, sequence: ['I', 'I', 'N', 'D', 'I'],           smartDistractors: true,  preferTargets: true  },
  5: { rounds: 6, options: 4, sequence: ['I', 'N', 'D', 'N', 'I', 'I'],      smartDistractors: true,  preferTargets: true  },
};

const QUESTION_TYPE = { I: 'image_choice', N: 'name_choice', D: 'drag_drop' };

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Fixed ladder — deliberately slow (two activities per level). */
function ladderLevel(activityNumber) {
  return Math.min(5, Math.ceil((activityNumber + 1) / 2));
}

/**
 * Nudges the ladder up or down from the child's recent results.
 * Asymmetric on purpose: an over-hard activity costs far more here than an
 * over-easy one, so it falls up to 2 levels but only ever rises 1.
 */
function difficultyFor(activityNumber, recentScores, conceptStrength) {
  const ladder = ladderLevel(activityNumber);
  const recent = recentScores.length
    ? recentScores.reduce((a, b) => a + b, 0) / recentScores.length
    : null;

  let delta = 0;
  if (recent !== null && recent >= 0.90) delta += 1;
  if (recent !== null && recent < 0.60)  delta -= 1;
  if (conceptStrength < 0.70)            delta -= 1;
  if (recentScores.length >= 2 && recentScores.every((s) => s < 0.60)) delta -= 1;

  delta = clamp(delta, -2, 1);

  return {
    level: clamp(ladder + delta, 1, 5),
    meta:  { ladder, delta, recent_score: recent, concept_strength: conceptStrength },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sequenceNeighbours(categoryKey, conceptKey) {
  const sequence = getSequence(categoryKey);
  const idx = sequence.indexOf(conceptKey);
  if (idx === -1) return [];
  return [
    sequence[(idx + 1) % sequence.length],
    sequence[(idx + 2) % sequence.length],
  ].filter((k) => k && k !== conceptKey);
}

function buildSignature(conceptKeys, roundTypes) {
  return `${[...conceptKeys].sort().join('|')}#${roundTypes.join('')}`;
}

// ─── Trigger detection ───────────────────────────────────────────────────────

/**
 * Eligibility is a set difference, not a counter: "mastered concepts in this
 * category that no completed activity has covered yet". That makes it
 * order-independent, timestamp-free, idempotent, and self-healing if rows are
 * edited by hand — none of which a counter column would be.
 */
async function getActivityStatus(studentId, categoryKey) {
  const sequence = getSequence(categoryKey);
  if (!sequence.length) throw new ApiError(404, 'Unknown category');

  const [progressRows, activities] = await Promise.all([
    StudentConceptProgress.findAll({ where: { student_id: studentId, category_key: categoryKey } }),
    StudentActivity.findAll({
      where: { student_id: studentId, category_key: categoryKey },
      order: [['activity_number', 'DESC']],
    }),
  ]);

  const mastered = progressRows.filter(MASTERY_PREDICATE).map((r) => r.concept_key);
  const completed = activities.filter((a) => a.status === 'passed' || a.status === 'failed');
  const covered = new Set(completed.flatMap((a) => a.concept_keys || []));

  let uncovered = mastered.filter((k) => !covered.has(k));

  const threshold = Math.min(THRESHOLD, sequence.length);
  const fullyMastered = mastered.length === sequence.length;
  let eligible = uncovered.length >= threshold;

  // Review mode: once every concept in the category is mastered, small categories
  // (house/shapes have 4) would otherwise dead-end after one activity. Top the pool
  // back up from already-covered concepts, weakest first, so the tail of a category
  // becomes spaced repetition instead of nothing.
  if (!eligible && fullyMastered && uncovered.length >= 1) {
    eligible = true;
  }

  const pending = activities.find((a) => a.status === 'generated' || a.status === 'in_progress');
  const last = completed[0] || null;

  return {
    eligible,
    // Every concept in the category mastered (tier 1 and tier 2). Distinct from
    // `eligible`, which is about having uncovered concepts left to build an
    // activity from — a category can be eligible long before it is finished.
    // The client gates the end-of-category conclusion activity on this.
    fully_mastered: fullyMastered,
    threshold,
    next_activity_number: activities.length + 1,
    mastered_uncovered: uncovered,
    pending_activity_id: pending ? pending.id : null,
    last_activity: last && {
      id: last.id,
      activity_number: last.activity_number,
      score: last.score,
      difficulty_level: last.difficulty_level,
      completed_at: last.completed_at,
    },
  };
}

// ─── Generation ──────────────────────────────────────────────────────────────

/**
 * Picks which concepts this activity covers. Oldest mastery first, so the gap
 * between learning a concept and being re-tested on it is as long as possible.
 *
 * `offset` rotates the selection window through the pool. It is only ever non-zero
 * when the first choice collided with a recent activity's signature — the concept
 * set is the only part of the signature that can actually vary, since the round-type
 * sequence is fixed per level.
 */
function selectConcepts(progressRows, uncovered, covered, sequence, level, offset = 0) {
  const byKey = Object.fromEntries(progressRows.map((r) => [r.concept_key, r]));
  const sortKey = (k) => {
    const row = byKey[k];
    const passedAt = row?.tier1_passed_at ? new Date(row.tier1_passed_at).getTime() : 0;
    return [passedAt, sequence.indexOf(k)];
  };

  const pool = [...uncovered].sort((a, b) => {
    const [ta, ia] = sortKey(a);
    const [tb, ib] = sortKey(b);
    return ta - tb || ia - ib;
  });

  // Rotate rather than slice from `offset`, so we never run off the end of the pool.
  const rotated = pool.length
    ? pool.map((_, i) => pool[(i + offset) % pool.length])
    : [];

  const targets = rotated.slice(0, THRESHOLD);

  // Review mode top-up: fill from already-covered concepts, weakest score first.
  if (targets.length < THRESHOLD) {
    const weakestFirst = [...covered]
      .filter((k) => !targets.includes(k) && sequence.includes(k))
      .sort((a, b) => (byKey[a]?.tier1_score ?? 1) - (byKey[b]?.tier1_score ?? 1));
    targets.push(...weakestFirst.slice(0, THRESHOLD - targets.length));
  }

  // At L5 one round deliberately revisits an older, already-covered concept.
  let spacedRepetitionKey = null;
  if (level === 5) {
    spacedRepetitionKey = [...covered]
      .filter((k) => !targets.includes(k) && sequence.includes(k))
      .sort((a, b) => (byKey[a]?.tier1_score ?? 1) - (byKey[b]?.tier1_score ?? 1))[0] || null;
  }

  return { targets, spacedRepetitionKey, byKey, poolSize: pool.length };
}

/**
 * Turns a level + concept set into the frozen round blueprint. Stores concept
 * keys only — the app resolves images and builds the bilingual prompt text from
 * its own catalogue, so the label data lives in exactly one place.
 */
async function buildQuestionPlan({ studentId, categoryKey, level, targets, spacedRepetitionKey, byKey }) {
  const spec = ACTIVITY_LEVELS[level];
  const sequence = getSequence(categoryKey);

  // Assign a concept to each round slot. Extra rounds beyond the 3 targets re-test
  // the weakest target; at L5 one slot goes to the spaced-repetition concept.
  const weakestTarget = [...targets].sort(
    (a, b) => (byKey[a]?.tier1_score ?? 1) - (byKey[b]?.tier1_score ?? 1),
  )[0];

  const roundConcepts = spec.sequence.map((_, i) => {
    if (i < targets.length) return targets[i];
    if (spacedRepetitionKey && i === spec.sequence.length - 1) return spacedRepetitionKey;
    return weakestTarget;
  });

  // One getDistractors call per round. Run them together — a 400ms GKB timeout
  // times six sequential rounds would be 2.4s of dead time if the GKB is down.
  const distractorSets = await Promise.all(
    spec.sequence.map((type, i) => {
      if (!spec.smartDistractors) return Promise.resolve({ distractors: [] });
      // tier 2 maps to the name-confusion edges in the graph, tier 1 to image confusions
      const tierParam = type === 'N' ? 2 : 1;
      return getDistractors(studentId, categoryKey, roundConcepts[i], tierParam)
        .catch(() => ({ distractors: [] }));
    }),
  );

  return spec.sequence.map((type, i) => {
    const conceptKey = roundConcepts[i];
    const otherTargets = spec.preferTargets ? targets.filter((k) => k !== conceptKey) : [];

    // getDistractors returns at most 2, so padding from sequence neighbours is
    // mandatory — L5 needs 3 distractors for its 4-option rounds.
    const pool = [...new Set([
      ...otherTargets,
      ...(distractorSets[i].distractors || []),
      ...sequenceNeighbours(categoryKey, conceptKey),
      ...sequence,
    ])].filter((k) => k !== conceptKey && sequence.includes(k));

    const options = shuffle([conceptKey, ...pool.slice(0, spec.options - 1)]);

    // Which policy contributed, recorded per round so the logs can tell an
    // activity round apart from a tier round the child was given by the same
    // policy. The pool is a mixture — targets, then getDistractors, then sequence
    // padding — so this names the policy that fed it, tagged `+mixed` when
    // anything that actually reached the screen came from elsewhere.
    const policySource = distractorSets[i].distractor_source || null;
    const policyKeys   = new Set(distractorSets[i].distractors || []);
    const shown        = options.filter((k) => k !== conceptKey);
    const fromPolicy   = shown.filter((k) => policyKeys.has(k)).length;

    // If none of the policy's picks survived the padding, the child saw a
    // sequential set and calling it anything else would misreport the exposure.
    const source = (!policySource || fromPolicy === 0)
      ? 'sequential'
      : fromPolicy === shown.length ? policySource : `${policySource}+mixed`;

    return {
      round_number: i + 1,
      question_type: QUESTION_TYPE[type],
      concept_key: conceptKey,
      option_keys: options,
      distractor_source: source,
    };
  });
}

/**
 * Idempotent. An activity already generated or in progress is returned unchanged,
 * which both kills the double-tap race and means a child who backs out mid-activity
 * is re-presented with the same one rather than a surprising new set.
 */
async function startActivity(studentId, categoryKey, sessionId) {
  const existing = await StudentActivity.findOne({
    where: { student_id: studentId, category_key: categoryKey, status: ['generated', 'in_progress'] },
    order: [['activity_number', 'DESC']],
  });
  if (existing) return serializeActivity(existing);

  const status = await getActivityStatus(studentId, categoryKey);
  if (!status.eligible) throw new ApiError(409, 'Not enough mastered concepts yet');

  const sequence = getSequence(categoryKey);
  const [progressRows, activities] = await Promise.all([
    StudentConceptProgress.findAll({ where: { student_id: studentId, category_key: categoryKey } }),
    StudentActivity.findAll({
      where: { student_id: studentId, category_key: categoryKey },
      order: [['activity_number', 'DESC']],
    }),
  ]);

  const completed = activities.filter((a) => a.status === 'passed' || a.status === 'failed');
  const covered = new Set(completed.flatMap((a) => a.concept_keys || []));
  const activityNumber = activities.length + 1;

  const recentScores = completed.slice(0, 2).map((a) => a.score).filter((s) => s !== null);

  // Pick concepts at the ladder level first, then recompute the level now that we
  // know which concepts (and therefore what strength) we're working with.
  const provisional = selectConcepts(
    progressRows, status.mastered_uncovered, covered, sequence, ladderLevel(activityNumber),
  );
  const strengthOf = (keys) => {
    const scores = keys.map((k) => provisional.byKey[k]?.tier1_score ?? 1);
    return scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 1;
  };
  const { level, meta } = difficultyFor(activityNumber, recentScores, strengthOf(provisional.targets));

  // Avoid handing back the same concept-set + round-shape as the last few activities.
  // The round-type sequence is fixed per level, so the only thing that can vary is
  // which concepts we pick — hence rotating the selection window rather than
  // re-running an otherwise deterministic build.
  //
  // Never block on this: in a 4-concept category a collision is unavoidable, and a
  // child must never be told "no activity available".
  const recentSignatures = new Set(activities.slice(0, 3).map((a) => a.signature));

  let chosen = null;
  let signature = null;
  for (let offset = 0; offset < MAX_REROLLS; offset++) {
    chosen = selectConcepts(progressRows, status.mastered_uncovered, covered, sequence, level, offset);
    if (chosen.targets.length < 2) break;
    signature = buildSignature(chosen.targets, ACTIVITY_LEVELS[level].sequence);
    if (!recentSignatures.has(signature)) break;
    // Rotating past the end of the pool just repeats earlier windows.
    if (offset + 1 >= chosen.poolSize) break;
  }

  const { targets, spacedRepetitionKey, byKey } = chosen;
  if (targets.length < 2) throw new ApiError(409, 'Not enough concepts to build an activity');

  if (recentSignatures.has(signature)) {
    logger.warn(`Activity signature repeat for student ${studentId} / ${categoryKey}: ${signature}`);
  }

  const questionPlan = await buildQuestionPlan({
    studentId, categoryKey, level, targets, spacedRepetitionKey, byKey,
  });

  const now = new Date();
  const activity = await StudentActivity.create({
    student_id:       studentId,
    category_key:     categoryKey,
    activity_number:  activityNumber,
    difficulty_level: level,
    difficulty_meta:  meta,
    status:           'in_progress',
    concept_keys:     [...targets].sort(),
    signature,
    question_plan:    questionPlan,
    total_rounds:     questionPlan.length,
    started_at:       now,
    created_at:       now,
  });

  await logInteraction(
    studentId, sessionId, categoryKey, targets[0], ACTIVITY_TIER, 'activity_start',
    {
      activity_id: activity.id,
      activity_number: activityNumber,
      difficulty_level: level,
      concept_keys: [...targets].sort(),
      total_rounds: questionPlan.length,
    },
  );

  return serializeActivity(activity);
}

async function logActivityAttempt(studentId, sessionId, payload) {
  const { activity_id, category_key, concept_key, round_number, question_type,
          selected_key, was_correct, time_taken_ms, option_keys, distractor_source } = payload;

  await logInteraction(
    studentId, sessionId, category_key, concept_key, ACTIVITY_TIER, 'activity_attempt',
    {
      activity_id,
      round_number,
      question_type,
      selected_key,
      correct_key: concept_key,
      was_correct,
      time_taken_ms: time_taken_ms || 0,
      option_keys: option_keys || [],
      // Null for activities generated before the plan carried a source.
      distractor_source: distractor_source || null,
    },
  );

  return { logged: true };
}

async function completeActivity(studentId, activityId, roundResults, sessionId) {
  const activity = await StudentActivity.findOne({
    where: { id: activityId, student_id: studentId },
  });
  if (!activity) throw new ApiError(404, 'Activity not found');
  if (activity.status === 'passed' || activity.status === 'failed') {
    throw new ApiError(409, 'Activity already completed');
  }

  // Recompute server-side — never trust a client-supplied score.
  const correctCount = roundResults.filter((r) => r.was_correct).length;
  const score  = activity.total_rounds > 0 ? correctCount / activity.total_rounds : 0;
  const passed = score >= PASS_SCORE;

  const now = new Date();
  await activity.update({
    status:        passed ? 'passed' : 'failed',
    correct_count: correctCount,
    score,
    completed_at:  now,
  });

  // One summary row per covered concept, so "query the logs by concept_key" keeps
  // working the way every other feature in the app relies on.
  const perConcept = {};
  roundResults.forEach((r) => {
    const key = r.concept_key;
    if (!key) return;
    if (!perConcept[key]) perConcept[key] = { correct: 0, total: 0 };
    perConcept[key].total += 1;
    if (r.was_correct) perConcept[key].correct += 1;
  });

  await Promise.all((activity.concept_keys || []).map((conceptKey) =>
    logInteraction(
      studentId, sessionId, activity.category_key, conceptKey, ACTIVITY_TIER,
      passed ? 'activity_pass' : 'activity_fail',
      {
        activity_id: activity.id,
        activity_number: activity.activity_number,
        difficulty_level: activity.difficulty_level,
        score,
        per_concept: perConcept[conceptKey] || { correct: 0, total: 0 },
        concept_keys: activity.concept_keys,
      },
    )
  ));

  syncActivityConfusions(studentId, activity, roundResults);
  syncActivityScore(studentId, activity, perConcept, score, passed);

  const nextStatus = await getActivityStatus(studentId, activity.category_key);

  return {
    completed: true,
    passed,
    score,
    correct_count: correctCount,
    total_rounds: activity.total_rounds,
    next_status: nextStatus,
  };
}

/**
 * Feeds wrong answers back into the knowledge graph as per-student confusion edges.
 *
 * Split by what the round actually tested: tapping the right picture is visual
 * discrimination, while both name-choice and drag-drop are name↔image mapping — the
 * same split Tier 2 already makes when it routes drag-drop mistakes into
 * T2_NAME_CONFUSION.
 *
 * These edges carry student_id, unlike the global CONFUSION edges the tier flows
 * write, so one child's mistakes never weight another child's distractors.
 */
function syncActivityConfusions(studentId, activity, roundResults) {
  const KIND_FOR = {
    image_choice: 'image',
    name_choice:  'name',
    drag_drop:    'name',
  };

  const byKindAndConcept = {};   // kind -> correctKey -> Set(confusedKeys)

  roundResults.forEach((r) => {
    if (r.was_correct) return;
    if (!r.concept_key || !r.selected_key) return;
    const kind = KIND_FOR[r.question_type];
    if (!kind) return;
    byKindAndConcept[kind] ??= {};
    byKindAndConcept[kind][r.concept_key] ??= new Set();
    byKindAndConcept[kind][r.concept_key].add(r.selected_key);
  });

  Object.entries(byKindAndConcept).forEach(([kind, byCorrect]) => {
    Object.entries(byCorrect).forEach(([correctKey, confusedSet]) => {
      syncToGkb('/gkb/activity/confusion', {
        student_id:    studentId,
        correct_key:   correctKey,
        category_key:  activity.category_key,
        confused_with: [...confusedSet],
        kind,
        // The activity row id is the observation: one completed activity yields at
        // most one increment per (correct, confused) pair, so a retried delivery
        // cannot inflate the weight. confusedSet already de-duplicates within it.
        observation_id: activity.id,
      });
    });
  });
}

/**
 * Records how the child did on each concept the activity covered. Without this the
 * graph has no record an activity ever happened — a child who answers everything
 * correctly would otherwise contribute nothing at all.
 */
function syncActivityScore(studentId, activity, perConcept, score, passed) {
  (activity.concept_keys || []).forEach((conceptKey) => {
    const tally = perConcept[conceptKey] || { correct: 0, total: 0 };
    syncToGkb('/gkb/activity/score', {
      student_id:       studentId,
      concept_key:      conceptKey,
      category_key:     activity.category_key,
      // Per-concept accuracy where the activity tested it; falls back to the
      // activity-wide score for a concept that had no round of its own.
      score:            tally.total > 0 ? tally.correct / tally.total : score,
      correct_count:    tally.correct,
      total_rounds:     tally.total,
      difficulty_level: activity.difficulty_level,
      activity_number:  activity.activity_number,
      passed,
      // Same activity row id used for the confusion sync above — makes the
      // append-only Attempt history record idempotent against retries.
      observation_id:   activity.id,
    });
  });
}

function serializeActivity(activity) {
  return {
    activity_id:      activity.id,
    activity_number:  activity.activity_number,
    difficulty_level: activity.difficulty_level,
    concept_keys:     activity.concept_keys,
    total_rounds:     activity.total_rounds,
    rounds:           activity.question_plan,
  };
}

module.exports = {
  getActivityStatus,
  startActivity,
  logActivityAttempt,
  completeActivity,
  // exported for testing / tuning
  ACTIVITY_LEVELS,
  ladderLevel,
  difficultyFor,
};
