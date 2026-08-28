'use strict';

const crypto = require('crypto');
const { AiSummary } = require('../models');
const gemini = require('./geminiService');
const conceptAnalyticsService = require('./conceptAnalyticsService');
const teacherService = require('./teacherService');
const logger = require('../utils/logger');

const { CATEGORY_LABELS } = conceptAnalyticsService;

// ─── Prompting ────────────────────────────────────────────────────────────────

// Shared across both endpoints. The constraints here are not style preferences —
// they are §6.2 of the GAT feasibility report applied to a language model. The
// model narrates numbers the system already computed; it does not decide anything
// about a child.
const SYSTEM_INSTRUCTION = `You write short factual summaries of learning-activity data for special-education teachers.

The learner is an autistic child using a concept-learning app. The teacher knows this child; you do not. You are reading interaction logs.

Rules, in order of importance:
1. Describe, never diagnose. No clinical, developmental, or diagnostic language. Do not speculate about the child's abilities, cognition, or condition. Report what the logged data shows.
2. Never recommend changing difficulty level, tier progression, or sensory settings. Those are the teacher's decisions and the system's thresholds. You may point out where a child is struggling; you may not say what the system should do about it.
3. Ground every statement in a number you were given. If you cannot point to a figure in the data, do not make the statement.
4. When the data is thin, say so. A summary of four attempts must read like a summary of four attempts. Never pad a weak signal into a confident claim.
5. Plain, concrete language. No motivational filler, no praise for the teacher, no "keep up the great work".
6. Refer to concepts by their key as given (e.g. "mango", "banana").
7. The reader is a special-education teacher, not a technician. Never use the words
   tier, distractor, mastery, engagement, sample size, model, confidence, or score.
   Say "picture round" and "word round"; say "got it right 4 of 6 times".
8. For mix-ups you may say why a pair is plausibly confusable, but ONLY from the two
   things you are given: how alike the pictures look (visual_similarity, 0-1), how
   alike the names sound (phonetic_similarity, 0-1), and which rounds it happened in
   (tiers: 1 = choosing a picture, 2 = choosing the written name). Read those as:
     tiers [1]    - tells the names apart, it is the pictures that look alike
     tiers [2]    - tells the pictures apart, the name has not attached yet
     tiers [1,2]  - muddled whichever way it is asked; the two things themselves
                    may not have come apart yet
   If neither similarity figure is high and the rounds do not explain it, say plainly
   that the data does not show why. Never invent a reason about the child.
9. The similarity figures are INPUTS TO YOUR JUDGEMENT, never output. Never print a
   similarity number, never name the field, never write anything like "(visual
   similarity 0.94)". Say "these two look very alike" or "the names sound similar".
   A teacher cannot act on 0.94 and has no scale to judge it against.
10. Do not narrate the mechanism. The teacher does not need to know a round was a
   "word round showing the child tells the pictures apart" — say what it means for
   them: "she knows the picture but the written name has not stuck yet." One
   sentence, about the child, in words a parent would also understand.

Every field must be safe for a teacher to read at a glance. Keep list items to one sentence each.`;

// Gemini's responseSchema is an OpenAPI subset. Being explicit about required
// fields is what stops the shape drifting between calls and breaking the UI.
const NARRATIVE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    headline:        { type: 'STRING', description: 'One sentence: where this child currently stands.' },
    strengths:       { type: 'ARRAY', items: { type: 'STRING' }, description: 'Up to 3 things the data shows going well.' },
    watch_areas:     { type: 'ARRAY', items: { type: 'STRING' }, description: 'Up to 3 areas where the data shows difficulty.' },
    mix_ups:         { type: 'ARRAY', items: { type: 'STRING' }, description: 'Plain-language narration of the confusion pairs. Empty if none were recorded.' },
    // Keyed so the report screen can put each sentence on the right pair's card.
    // A flat array would have to be matched back by position, which silently
    // mis-attributes an explanation the moment the model returns them out of order
    // or omits one — and a wrong explanation on a mix-up card is worse than none.
    mix_up_notes: {
      type: 'ARRAY',
      description: 'One entry per pair in mix_ups_detail, explaining why that pair is plausibly confusable. Omit a pair entirely rather than guessing about it.',
      items: {
        type: 'OBJECT',
        properties: {
          pair: { type: 'STRING', description: 'Exactly the `pair` value given for that entry, unchanged.' },
          note: { type: 'STRING', description: 'One sentence, grounded in the similarity figures and the rounds it happened in.' },
        },
        required: ['pair', 'note'],
      },
    },
    suggested_focus: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Up to 3 concepts the teacher may want to revisit, phrased as options to consider.' },
    caveat:          { type: 'STRING', description: 'What this summary does not know, including the size of the sample it is based on.' },
  },
  // mix_up_notes is deliberately NOT required: a child with no recorded mix-ups has
  // nothing to explain, and forcing the field would invite the model to fill it.
  required: ['headline', 'strengths', 'watch_areas', 'mix_ups', 'suggested_focus', 'caveat'],
  propertyOrdering: ['headline', 'strengths', 'watch_areas', 'mix_ups', 'mix_up_notes', 'suggested_focus', 'caveat'],
};

const DIGEST_SCHEMA = {
  type: 'OBJECT',
  properties: {
    headline:    { type: 'STRING', description: 'One sentence covering the class this week.' },
    highlights:  { type: 'ARRAY', items: { type: 'STRING' }, description: 'Up to 3 notable things from this week.' },
    watch_areas: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Up to 3 students or patterns worth attention, referred to by their given label.' },
    caveat:      { type: 'STRING', description: 'What this summary does not know.' },
  },
  required: ['headline', 'highlights', 'watch_areas', 'caveat'],
  propertyOrdering: ['headline', 'highlights', 'watch_areas', 'caveat'],
};

// ─── Pseudonymisation ─────────────────────────────────────────────────────────

// Everything below builds the outgoing payload by *picking* permitted fields.
// This is deliberate and worth preserving: a delete-list would keep working
// silently on the day someone adds a field to getConceptReport, right up until
// that field happened to be a name.

/** 0 → "Student A", 25 → "Student Z", 26 → "Student AA". */
function labelFor(index) {
  let n = index, out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `Student ${out}`;
}

/**
 * One student's concept report, stripped to the fields the model may see.
 *
 * No label substitution here — a single-student summary has no one to
 * disambiguate, so the prompt refers to "the child" and nothing needs
 * rehydrating on the way out.
 */
function buildNarrativeInput(report) {
  const attention = new Set();
  for (const c of report.categories || []) {
    for (const k of c.needs_attention || []) attention.add(k);
  }

  return {
    window_days: report.window_days,
    totals: {
      catalogue_concepts: report.totals?.catalogue_concepts,
      started:            report.totals?.started,
      tier1_passed:       report.totals?.tier1_passed,
      tier2_passed:       report.totals?.tier2_passed,
      tier3_passed:       report.totals?.tier3_passed,
      mastered:           report.totals?.mastered,
      mastery_pct:        report.totals?.mastery_pct,
    },
    // Only categories the child has actually touched. Sending the nine empty ones
    // invites the model to comment on the absence as though it were a finding.
    categories: (report.categories || [])
      .filter((c) => c.started > 0)
      .map((c) => ({
        label:           c.label,
        total:           c.total,
        started:         c.started,
        mastered:        c.mastered,
        mastery_pct:     c.mastery_pct,
        avg_tier1_score: c.avg_tier1_score,
        needs_attention: c.needs_attention,
      })),
    concepts: (report.concepts || []).map((c) => ({
      concept_key:      c.concept_key,
      category:         CATEGORY_LABELS[c.category_key] || c.category_key,
      tier1_status:     c.tier1_status,
      tier1_score:      c.tier1_score,
      tier2_status:     c.tier2_status,
      tier3_status:     c.tier3_status,
      retries:          (c.tier1_retry_count || 0) + (c.tier2_retry_count || 0),
      mastered:         c.mastered,
      attempts:         c.real_attempts,
      correct:          c.correct_attempts,
      avg_response_ms:  c.avg_response_ms,
      needs_attention:  attention.has(c.concept_key),
    })),
    confusions: (report.confusions || []).map((c) => ({
      shown:    c.correct_key,
      chosen:   c.selected_key,
      tier:     c.tier,
      times:    c.count,
    })),
    // One entry per pair, carrying the only two things the model is permitted to
    // reason from — how alike the pictures look, how alike the names sound — plus
    // which rounds it happened in. `pair` is the key mix_up_notes must echo back so
    // each sentence lands on the right card.
    mix_ups_detail: (report.mix_ups || []).map((m) => ({
      pair:                `${m.concept_a}|${m.concept_b}`,
      concepts:            [m.concept_a, m.concept_b],
      category:            CATEGORY_LABELS[m.category_key] || m.category_key,
      times:               m.count,
      tiers:               m.tiers,
      visual_similarity:   m.visual_similarity,
      phonetic_similarity: m.phonetic_similarity,
    })),
    response_times: report.response_times,
    engagement:     report.engagement,
    activities: (report.activities || []).map((a) => ({
      category:         CATEGORY_LABELS[a.category_key] || a.category_key,
      difficulty_level: a.difficulty_level,
      score:            a.score,
      correct_count:    a.correct_count,
      total_rounds:     a.total_rounds,
      status:           a.status,
    })),
    timeline: (report.timeline || []).map((t) => ({
      date:     t.date,
      attempts: t.attempts,
      accuracy: t.accuracy,
    })),
  };
}

/**
 * The teacher's whole class for the current week, with names replaced by stable
 * labels. Returns the payload plus the label→name map, which stays on this server
 * and is only used to rehydrate the model's output before it reaches the client.
 */
function buildDigestInput(dashboard, weekStartIso) {
  // Keyed on studentId, never on fullName. Two children sharing a name would
  // collapse to one label, and rehydrate would then substitute one child's name
  // into statements about the other — silently, in a summary a teacher reads and
  // may act on.
  const labels = new Map();   // studentId → "Student A"
  const names  = new Map();   // "Student A" → full name

  (dashboard.proficiency || []).forEach((p, i) => {
    const label = labelFor(i);
    labels.set(p.studentId, label);
    names.set(label, p.fullName);
  });

  const weekStart = new Date(weekStartIso);
  const sessionsThisWeek = (dashboard.sessionDates || [])
    .filter((d) => new Date(d) >= weekStart).length;

  const payload = {
    // Rotates the cache key weekly on its own — no expiry logic needed.
    week_starting: weekStartIso,
    class_size: dashboard.stats?.totalStudents,
    all_time: {
      concepts_mastered: dashboard.stats?.conceptsMastered,
      avg_engagement:    dashboard.stats?.avgEngagement,
    },
    this_week: {
      activities_assigned:  dashboard.weekStats?.activitiesAssigned,
      activities_completed: dashboard.weekStats?.activitiesCompleted,
      avg_progress:         dashboard.weekStats?.avgProgress,
      milestones:           dashboard.weekStats?.milestones,
      sessions:             sessionsThisWeek,
    },
    students: (dashboard.proficiency || []).map((p) => ({
      label:              labels.get(p.studentId),
      concepts_assigned:  p.conceptsAssigned,
      concepts_mastered:  p.conceptsMastered,
      avg_score:          p.avgScore,
      last_session_at:    p.lastSessionAt,
    })),
    recent_achievements: (dashboard.recentAchievements || []).map((a) => ({
      student:  labels.get(a.studentId) || 'a student',
      concept:  a.conceptKey,
      category: CATEGORY_LABELS[a.categoryKey] || a.categoryKey,
      passed_at: a.passedAt,
    })),
  };

  return { payload, names };
}

/**
 * Put the real names back. The cached row stays pseudonymous — only what the
 * client receives is rehydrated.
 */
function rehydrate(value, names) {
  if (typeof value === 'string') {
    let out = value;
    // Longest label first: replacing "Student A" before "Student AA" would turn
    // the latter into "<name>A". Only reachable past 26 students, but the
    // ordering costs nothing and the bug would be baffling.
    const ordered = [...names.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [label, name] of ordered) {
      out = out.split(label).join(name);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => rehydrate(v, names));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, rehydrate(v, names)]),
    );
  }
  return value;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

function hashInput(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * Shared pipeline: look up, generate on a miss, persist, return.
 *
 * Model failures return `{ available: false }` rather than throwing — every
 * caller is decorating a screen that has to render without this.
 */
async function generateCached({ scope, subjectId, payload, schema, refresh }) {
  const model     = gemini.modelName();
  const inputHash = hashInput(payload);

  if (!refresh) {
    // Read failures are swallowed for the same reason write failures are, plus
    // one more: if the feature is switched on before the migration has run, an
    // unguarded read here would 500 the report screen — the one thing this
    // whole design promises cannot happen.
    try {
      const hit = await AiSummary.findOne({
        where: { scope, subject_id: subjectId, input_hash: inputHash },
      });
      if (hit && hit.model === model) {
        return {
          available: true,
          cached: true,
          generated_at: hit.generated_at,
          summary: hit.payload,
        };
      }
    } catch (err) {
      logger.error(`Failed to read ${scope} summary cache for subject ${subjectId}: ${err.message}`);
    }
  }

  const summary = await gemini.generate(SYSTEM_INSTRUCTION, payload, schema);
  if (!summary) return { available: false };

  const generatedAt = new Date();

  // Upsert by hand: the unique index is on three columns, and a concurrent
  // request for the same unchanged data would otherwise collide.
  try {
    const existing = await AiSummary.findOne({
      where: { scope, subject_id: subjectId, input_hash: inputHash },
    });
    if (existing) {
      await existing.update({ payload: summary, model, generated_at: generatedAt });
    } else {
      await AiSummary.create({
        scope,
        subject_id: subjectId,
        input_hash: inputHash,
        model,
        payload: summary,
        generated_at: generatedAt,
      });
    }
  } catch (err) {
    // A cache that fails to write is a cost problem, not a correctness one.
    logger.error(`Failed to cache ${scope} summary for subject ${subjectId}: ${err.message}`);
  }

  return { available: true, cached: false, generated_at: generatedAt, summary };
}

// ─── Public ───────────────────────────────────────────────────────────────────

/**
 * Narrative summary of one student's concept report.
 *
 * Ownership is enforced by getConceptReport itself — it delegates to
 * getConceptSummary, which calls assertOwnedStudent and 404s on another
 * teacher's student. There is deliberately no second gate here.
 */
async function getConceptNarrative(teacherId, studentId, { refresh = false } = {}) {
  if (!gemini.isEnabled()) return { available: false };

  const report = await conceptAnalyticsService.getConceptReport(teacherId, studentId);

  // Nothing logged yet means nothing to narrate. Asking the model to summarise an
  // empty report produces confident-sounding filler.
  if (!report.totals?.started) return { available: false, reason: 'no_data' };

  const payload = buildNarrativeInput(report);

  return generateCached({
    scope: 'concept_report',
    subjectId: Number(studentId),
    payload,
    schema: NARRATIVE_SCHEMA,
    refresh,
  });
}

/** Weekly digest across all of one teacher's students. */
async function getClassDigest(teacherId, { refresh = false } = {}) {
  if (!gemini.isEnabled()) return { available: false };

  const dashboard = await teacherService.getDashboardStats(teacherId);
  if (!dashboard.stats?.totalStudents) return { available: false, reason: 'no_data' };

  const weekStart = teacherService.startOfWeek().toISOString().slice(0, 10);
  const { payload, names } = buildDigestInput(dashboard, weekStart);

  const result = await generateCached({
    scope: 'class_digest',
    subjectId: Number(teacherId),
    payload,
    schema: DIGEST_SCHEMA,
    refresh,
  });

  if (!result.available) return result;
  return { ...result, summary: rehydrate(result.summary, names) };
}

module.exports = {
  getConceptNarrative,
  getClassDigest,
  // Exported for tests — the pseudonymisation guarantee is the thing most worth
  // asserting on, and it should be assertable without a network or a database.
  buildNarrativeInput,
  buildDigestInput,
  hashInput,
  rehydrate,
  SYSTEM_INSTRUCTION,
};
