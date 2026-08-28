'use strict';

const { QueryTypes } = require('sequelize');
const sequelize = require('../config/database');
const { Student, StudentConceptProgress } = require('../models');
const { CATEGORY_SEQUENCES, PASS_SCORE, isMastered } = require('./conceptService');
const ApiError = require('../utils/ApiError');
const logger   = require('../utils/logger');

// Same precomputed artifact getDistractors serves from. Read here so a mix-up can
// be reported with the reason it is plausible — "these two look very alike" is a
// measured fact about the artwork (dog/sparrow = 0.99), not a guess about the child.
//
// Required directly rather than imported from conceptService because that module
// keeps it private, and a second require of the same JSON is free — node caches it.
let SIMILARITY = { concepts: {} };
try {
  SIMILARITY = require('../data/concept_similarity.json');
} catch {
  logger.warn('concept_similarity.json not found; mix-up explanations will omit similarity');
}

function similarityFor(categoryKey, a, b) {
  const entry = SIMILARITY.concepts?.[`${categoryKey}/${a}`];
  const pick  = (kind) => entry?.[kind]?.find((x) => x.key === b)?.score ?? null;
  return { visual: pick('visual'), phonetic: pick('phonetic') };
}

// Human labels for the category keys. The backend only stores sequences, and the
// labels live in the frontend catalogue, so they are mirrored here rather than
// having the client re-derive them from keys.
const CATEGORY_LABELS = {
  fruits:        'Fruits',
  professionals: 'Professionals',
  animals:       'Animals',
  house:         'House Parts',
  numbers:       'Numbers',
  shapes:        'Shapes',
  colors:        'Colours',
  classroom:     'Classroom Objects',
  household:     'Household Items',
};

const CATEGORY_KEYS = Object.keys(CATEGORY_SEQUENCES);

/** Mean of the numeric values, or null when there is nothing to average. */
function avg(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/** Round to 3dp so the payload doesn't carry float noise. */
const r3 = (v) => (v === null ? null : Math.round(v * 1000) / 1000);

/**
 * Ownership gate. Mirrors teacherService.getOwnStudentById — 404 rather than 403
 * for another teacher's student, so the endpoint can't be used to enumerate ids.
 */
async function assertOwnedStudent(teacherId, studentId) {
  const student = await Student.findOne({
    where: { sid: studentId, teacher_id: teacherId },
    attributes: ['sid', 'full_name'],
  });
  if (!student) throw new ApiError(404, 'Student not found or not assigned to you');
  return student;
}

/**
 * Cheap summary — reads only student_concept_progress (64 rows today, bounded by
 * 93 concepts). Powers the Concept Learning section on the student profile, so it
 * must not touch the per-tap log table.
 */
async function getConceptSummary(teacherId, studentId) {
  const student = await assertOwnedStudent(teacherId, studentId);

  const rows = await StudentConceptProgress.findAll({
    where: { student_id: studentId },
    raw: true,
  });

  const byCategory = new Map(CATEGORY_KEYS.map((k) => [k, []]));
  // Progress rows for categories no longer in the catalogue are still counted in
  // `started`, but never inflate a category denominator.
  let orphanedRows = 0;
  for (const row of rows) {
    if (byCategory.has(row.category_key)) byCategory.get(row.category_key).push(row);
    else orphanedRows += 1;
  }

  const categories = CATEGORY_KEYS.map((key) => {
    const total    = CATEGORY_SEQUENCES[key].length;
    const catRows  = byCategory.get(key);
    const inCat    = new Set(CATEGORY_SEQUENCES[key]);
    const mastered = catRows.filter(isMastered).length;

    // Backstop only. completeAdaptive now raises tier1_score to PASS_SCORE when it
    // promotes a concept, so passed-with-a-failing-score rows are no longer created.
    // This still guards rows written before that fix which the backfill missed —
    // including them would drag the average below what the child demonstrated.
    const scoreRows = catRows.filter(
      (r) => typeof r.tier1_score === 'number'
        && !(r.tier1_status === 'passed' && r.tier1_score < PASS_SCORE),
    );

    const needsAttention = catRows
      .filter((r) => r.tier1_status === 'failed'
        || r.tier2_status === 'failed'
        || (typeof r.tier1_score === 'number' && r.tier1_score < PASS_SCORE && r.tier1_status !== 'passed'))
      .map((r) => r.concept_key)
      .filter((k) => inCat.has(k));

    return {
      category_key:    key,
      label:           CATEGORY_LABELS[key] || key,
      total,
      started:         catRows.length,
      tier1_passed:    catRows.filter((r) => r.tier1_status === 'passed').length,
      tier2_passed:    catRows.filter((r) => r.tier2_status === 'passed').length,
      tier3_passed:    catRows.filter((r) => r.tier3_status === 'passed').length,
      mastered,
      mastery_pct:     total > 0 ? r3(mastered / total) : null,
      avg_tier1_score: r3(avg(scoreRows.map((r) => r.tier1_score))),
      needs_attention: needsAttention,
    };
  });

  const catalogueConcepts = CATEGORY_KEYS.reduce((n, k) => n + CATEGORY_SEQUENCES[k].length, 0);
  const mastered = rows.filter(isMastered).length;

  const passedAt = rows
    .map((r) => r.tier1_passed_at)
    .filter(Boolean)
    .sort((a, b) => new Date(b) - new Date(a));

  return {
    generated_at: new Date().toISOString(),
    student_id:   Number(studentId),
    student_name: student.full_name,
    totals: {
      catalogue_concepts: catalogueConcepts,
      started:            rows.length,
      tier1_passed:       rows.filter((r) => r.tier1_status === 'passed').length,
      tier2_passed:       rows.filter((r) => r.tier2_status === 'passed').length,
      tier3_passed:       rows.filter((r) => r.tier3_status === 'passed').length,
      mastered,
      mastery_pct:        catalogueConcepts > 0 ? r3(mastered / catalogueConcepts) : null,
      orphaned:           orphanedRows,
    },
    categories,
    last_activity_at: passedAt[0] ? new Date(passedAt[0]).toISOString() : null,
  };
}

// ─── Report (expensive) ───────────────────────────────────────────────────────

// Every event type that carries event_data.time_taken_ms. Tier 2's attempts go
// through the generic interaction endpoint rather than the typed attempt table,
// so T1 and T2 are not symmetric and both must be listed explicitly.
const ATTEMPT_EVENTS = ['match_attempt', 'name_match_attempt', 'drag_drop_attempt', 'adaptive_attempt'];

/**
 * Rich report — aggregates concept_interaction_logs and student_activities.
 * Lazy-loaded by the drill-down screen, never by the profile.
 *
 * `days` bounds the log scan; confusion pairs deliberately ignore it because they
 * are rare, cumulative, and the most useful signal a teacher gets.
 */
async function getConceptReport(teacherId, studentId, days = 90) {
  const summary = await getConceptSummary(teacherId, studentId);
  const sid = Number(studentId);
  const windowDays = Number.isFinite(Number(days)) ? Math.max(1, Math.min(365, Number(days))) : 90;

  const [progressRows, confusions, responseTimes, perConcept, engagement, activities, timeline,
         dailyConcepts, dailyArtwork, dailyTime] =
    await Promise.all([
      StudentConceptProgress.findAll({ where: { student_id: sid }, raw: true }),

      // confused_with is a JSONB array on the *_fail events. jsonb_typeof guards
      // it because event_type has no server-side whitelist — a malformed payload
      // would otherwise error the whole query.
      sequelize.query(
        `SELECT elem->>'correct_key'  AS correct_key,
                elem->>'selected_key' AS selected_key,
                tier,
                COUNT(*)::int         AS count
           FROM concept_interaction_logs,
                LATERAL jsonb_array_elements(event_data->'confused_with') AS elem
          WHERE student_id = :sid
            AND event_type IN ('tier1_fail','tier2_fail')
            AND jsonb_typeof(event_data->'confused_with') = 'array'
            AND elem->>'selected_key' IS NOT NULL
          GROUP BY 1,2,3
          ORDER BY count DESC, correct_key ASC
          LIMIT 10`,
        { replacements: { sid }, type: QueryTypes.SELECT },
      ),

      sequelize.query(
        `SELECT AVG((event_data->>'time_taken_ms')::numeric)                                    AS overall_ms,
                AVG((event_data->>'time_taken_ms')::numeric)
                  FILTER (WHERE (event_data->>'was_correct')::boolean IS TRUE)                  AS correct_ms,
                AVG((event_data->>'time_taken_ms')::numeric)
                  FILTER (WHERE (event_data->>'was_correct')::boolean IS FALSE)                 AS incorrect_ms,
                AVG((event_data->>'time_taken_ms')::numeric) FILTER (WHERE tier = 1)            AS tier1_ms,
                AVG((event_data->>'time_taken_ms')::numeric) FILTER (WHERE tier = 2)            AS tier2_ms,
                COUNT(*)::int                                                                    AS sample
           FROM concept_interaction_logs
          WHERE student_id = :sid
            AND event_type IN (:events)
            AND created_at >= NOW() - (:windowDays * INTERVAL '1 day')
            AND event_data ? 'time_taken_ms'
            AND jsonb_typeof(event_data->'time_taken_ms') = 'number'`,
        { replacements: { sid, events: ATTEMPT_EVENTS, windowDays }, type: QueryTypes.SELECT },
      ),

      // Real attempt counts. tier1_attempts on the progress table is hard-coded
      // to literal 3 by every client submit, so it is meaningless — count rows.
      sequelize.query(
        `SELECT category_key,
                concept_key,
                COUNT(*)::int                                     AS attempts,
                AVG((event_data->>'time_taken_ms')::numeric)      AS avg_ms,
                COUNT(*) FILTER (WHERE (event_data->>'was_correct')::boolean IS TRUE)::int AS correct
           FROM concept_interaction_logs
          WHERE student_id = :sid
            AND event_type IN (:events)
            AND created_at >= NOW() - (:windowDays * INTERVAL '1 day')
          GROUP BY 1,2`,
        { replacements: { sid, events: ATTEMPT_EVENTS, windowDays }, type: QueryTypes.SELECT },
      ),

      // Filtered by event_type, never by tier: coloring_complete is logged with
      // tier 4, colliding with the cross-concept activity events.
      sequelize.query(
        `SELECT
            COUNT(*) FILTER (WHERE event_type = 'image_tap')::int          AS total_taps,
            COALESCE(SUM((event_data->>'total_time_ms')::numeric)
              FILTER (WHERE event_type = 'screen_exit'), 0)                AS exposure_ms,
            COALESCE(SUM((event_data->>'time_spent_ms')::numeric)
              FILTER (WHERE event_type = 'tier3_complete'), 0)             AS video_ms,
            COUNT(*) FILTER (WHERE event_type = 'coloring_complete')::int  AS coloring_sessions,
            COUNT(*) FILTER (WHERE event_type = 'relearn_start')::int      AS relearn_count
           FROM concept_interaction_logs
          WHERE student_id = :sid
            AND created_at >= NOW() - (:windowDays * INTERVAL '1 day')`,
        { replacements: { sid, windowDays }, type: QueryTypes.SELECT },
      ),

      sequelize.query(
        `SELECT activity_number, difficulty_level, score, correct_count,
                total_rounds, status, concept_keys, category_key, completed_at
           FROM student_activities
          WHERE student_id = :sid
          ORDER BY COALESCE(completed_at, created_at) DESC
          LIMIT 20`,
        { replacements: { sid }, type: QueryTypes.SELECT },
      ),

      sequelize.query(
        `SELECT to_char(created_at::date, 'YYYY-MM-DD')                                    AS date,
                COUNT(*)::int                                                              AS attempts,
                COUNT(*) FILTER (WHERE (event_data->>'was_correct')::boolean IS TRUE)::int AS correct
           FROM concept_interaction_logs
          WHERE student_id = :sid
            AND event_type IN (:events)
            AND created_at >= NOW() - INTERVAL '30 days'
          GROUP BY 1
          ORDER BY 1 ASC`,
        { replacements: { sid, events: ATTEMPT_EVENTS }, type: QueryTypes.SELECT },
      ),

      // ── Day by day ─────────────────────────────────────────────────────────
      // A child works on fruits AND animals in one sitting, and nothing in this
      // report could express that: `timeline` above collapses a whole day to two
      // numbers. This keeps the day but splits it by category and concept, which
      // is what a teacher preparing tomorrow's session actually reads.
      //
      // Attempts and outcomes come from one pass rather than two queries: the
      // FILTERs separate them, and the row count here is bounded by
      // (days x concepts touched), which is small.
      sequelize.query(
        `SELECT to_char(created_at::date, 'YYYY-MM-DD') AS date,
                category_key,
                concept_key,
                COUNT(*) FILTER (WHERE event_type IN (:events))::int AS attempts,
                COUNT(*) FILTER (WHERE event_type IN (:events)
                  AND (event_data->>'was_correct')::boolean IS TRUE)::int AS correct,
                COUNT(*) FILTER (WHERE event_type IN ('tier1_pass','tier2_pass'))::int AS passes,
                COUNT(*) FILTER (WHERE event_type IN ('tier1_fail','tier2_fail'))::int AS fails
           FROM concept_interaction_logs
          WHERE student_id = :sid
            AND created_at >= NOW() - (:windowDays * INTERVAL '1 day')
            AND event_type IN (:dayEvents)
          GROUP BY 1,2,3
         HAVING COUNT(*) > 0
          ORDER BY 1 DESC, 2 ASC, 3 ASC`,
        {
          replacements: {
            sid, windowDays,
            events: ATTEMPT_EVENTS,
            dayEvents: [...ATTEMPT_EVENTS, 'tier1_pass', 'tier2_pass', 'tier1_fail', 'tier2_fail'],
          },
          type: QueryTypes.SELECT,
        },
      ),

      // Drawings, keyed by the day they were made so they can sit inside that
      // day's card rather than in a detached strip with no context.
      sequelize.query(
        `SELECT to_char(created_at::date, 'YYYY-MM-DD') AS date,
                id, category_key, concept_key, image_url, created_at
           FROM coloring_artworks
          WHERE student_id = :sid
            AND created_at >= NOW() - (:windowDays * INTERVAL '1 day')
          ORDER BY created_at DESC`,
        { replacements: { sid, windowDays }, type: QueryTypes.SELECT },
      ),

      // Roughly how long the child was on task that day. screen_exit carries the
      // dwell time the concept screens already record; it is the only per-day time
      // signal that is not an inference from timestamps.
      sequelize.query(
        `SELECT to_char(created_at::date, 'YYYY-MM-DD') AS date,
                COALESCE(SUM((event_data->>'total_time_ms')::numeric), 0) AS ms
           FROM concept_interaction_logs
          WHERE student_id = :sid
            AND event_type = 'screen_exit'
            AND created_at >= NOW() - (:windowDays * INTERVAL '1 day')
            AND jsonb_typeof(event_data->'total_time_ms') = 'number'
          GROUP BY 1`,
        { replacements: { sid, windowDays }, type: QueryTypes.SELECT },
      ),
    ]);

  const statsFor = new Map(perConcept.map((p) => [`${p.category_key}/${p.concept_key}`, p]));
  const num = (v) => (v === null || v === undefined ? null : Math.round(Number(v)));

  const concepts = progressRows.map((row) => {
    const seq   = CATEGORY_SEQUENCES[row.category_key];
    const stats = statsFor.get(`${row.category_key}/${row.concept_key}`);
    return {
      concept_key:       row.concept_key,
      category_key:      row.category_key,
      tier1_status:      row.tier1_status,
      tier1_score:       row.tier1_score,
      tier1_passed_at:   row.tier1_passed_at,
      tier2_status:      row.tier2_status,
      tier3_status:      row.tier3_status,
      tier1_retry_count: row.tier1_retry_count,
      tier2_retry_count: row.tier2_retry_count,
      mastered:          isMastered(row),
      real_attempts:     stats ? stats.attempts : 0,
      correct_attempts:  stats ? stats.correct : 0,
      avg_response_ms:   stats ? num(stats.avg_ms) : null,
      in_catalogue:      Boolean(seq && seq.includes(row.concept_key)),
    };
  });

  const rt = responseTimes[0] || {};
  const eng = engagement[0] || {};

  // ── Day cards ────────────────────────────────────────────────────────────────
  // Assembled here rather than in SQL because a day is a nested shape (day →
  // categories → concepts, plus that day's drawings) and three flat result sets
  // stitch into it more legibly than one query with two lateral joins would.
  const timeByDate = new Map(dailyTime.map((r) => [r.date, Math.round(Number(r.ms) || 0)]));
  const artByDate  = new Map();
  for (const a of dailyArtwork) {
    if (!artByDate.has(a.date)) artByDate.set(a.date, []);
    artByDate.get(a.date).push({
      id:           a.id,
      category_key: a.category_key,
      concept_key:  a.concept_key,
      image_url:    a.image_url,
      created_at:   a.created_at,
    });
  }

  const dayMap = new Map();
  for (const row of dailyConcepts) {
    if (!dayMap.has(row.date)) dayMap.set(row.date, new Map());
    const cats = dayMap.get(row.date);
    if (!cats.has(row.category_key)) cats.set(row.category_key, []);
    cats.get(row.category_key).push({
      concept_key: row.concept_key,
      attempts:    row.attempts,
      correct:     row.correct,
      // `passed` means the child cleared a round that day, not that they are
      // finished with the concept — tier 2 may still be ahead of them.
      passed:      row.passes > 0,
      struggled:   row.fails > 0,
    });
  }

  // Every date that saw anything at all, including a day whose only event was a
  // drawing. Dropping those would tell a teacher the child did nothing on a day
  // they actually sat and coloured.
  const allDates = [...new Set([...dayMap.keys(), ...artByDate.keys()])]
    .sort((a, b) => (a < b ? 1 : -1));

  // `dayCards`, not `days` — that name is taken by this function's window parameter.
  const dayCards = allDates.map((date) => ({
    date,
    time_spent_ms: timeByDate.get(date) || 0,
    categories: [...(dayMap.get(date) || new Map()).entries()].map(([key, conceptRows]) => ({
      category_key: key,
      label:        CATEGORY_LABELS[key] || key,
      concepts:     conceptRows,
    })),
    artworks: artByDate.get(date) || [],
  }));

  // ── Mix-ups, one entry per pair ──────────────────────────────────────────────
  // The raw rows are directional and per-round, so the same two concepts can appear
  // as up to four rows. A teacher reads "dog and sparrow get muddled" as one fact,
  // so they are merged on the unordered pair, and the rounds it happened in are
  // kept as a list — that list is the whole diagnostic:
  //   [1]    told apart by name, not by sight
  //   [2]    pictures are fine, the word has not stuck
  //   [1,2]  muddled whichever way it is asked
  const pairMap = new Map();
  for (const c of confusions) {
    if (!c.correct_key || !c.selected_key) continue;
    const cat = concepts.find((x) => x.concept_key === c.correct_key)?.category_key
      || Object.keys(CATEGORY_SEQUENCES).find((k) => CATEGORY_SEQUENCES[k].includes(c.correct_key));
    const [a, b] = [c.correct_key, c.selected_key].sort();
    const id = `${cat || '?'}/${a}|${b}`;
    if (!pairMap.has(id)) {
      const sim = cat ? similarityFor(cat, a, b) : { visual: null, phonetic: null };
      pairMap.set(id, {
        category_key: cat || null,
        concept_a: a,
        concept_b: b,
        count: 0,
        tiers: new Set(),
        // Rounded: the exact figure is a cosine we have no business showing, but
        // "very alike" versus "not especially" is the part that carries meaning.
        visual_similarity:   sim.visual   == null ? null : Math.round(sim.visual * 100) / 100,
        phonetic_similarity: sim.phonetic == null ? null : Math.round(sim.phonetic * 100) / 100,
      });
    }
    const entry = pairMap.get(id);
    entry.count += c.count;
    if (c.tier) entry.tiers.add(Number(c.tier));
  }

  const mixUps = [...pairMap.values()]
    .map((p) => ({ ...p, tiers: [...p.tiers].sort() }))
    .sort((a, b) => b.count - a.count);

  return {
    ...summary,
    window_days: windowDays,
    concepts,
    // Kept as-is for anything still reading the flat directional list.
    confusions: confusions.map((c) => ({
      correct_key:  c.correct_key,
      selected_key: c.selected_key,
      tier:         c.tier,
      count:        c.count,
    })),
    // One entry per pair, with the rounds it happened in and how alike the two
    // concepts look and sound. This is what the report screen renders and what
    // the model is given to explain.
    mix_ups: mixUps,
    days: dayCards,
    response_times: {
      overall_avg_ms:   num(rt.overall_ms),
      correct_avg_ms:   num(rt.correct_ms),
      incorrect_avg_ms: num(rt.incorrect_ms),
      by_tier:          { 1: num(rt.tier1_ms), 2: num(rt.tier2_ms) },
      sample_size:      rt.sample || 0,
    },
    engagement: {
      total_taps:        eng.total_taps || 0,
      exposure_ms:       num(eng.exposure_ms) || 0,
      video_ms:          num(eng.video_ms) || 0,
      coloring_sessions: eng.coloring_sessions || 0,
      relearn_count:     eng.relearn_count || 0,
    },
    activities: activities.map((a) => ({
      activity_number:  a.activity_number,
      category_key:     a.category_key,
      difficulty_level: a.difficulty_level,
      score:            a.score === null ? null : r3(Number(a.score)),
      correct_count:    a.correct_count,
      total_rounds:     a.total_rounds,
      status:           a.status,
      concept_keys:     a.concept_keys || [],
      completed_at:     a.completed_at,
    })),
    timeline: timeline.map((t) => ({
      date:     t.date,
      attempts: t.attempts,
      correct:  t.correct,
      accuracy: t.attempts > 0 ? r3(t.correct / t.attempts) : null,
    })),
  };
}

module.exports = {
  getConceptSummary,
  getConceptReport,
  isMastered,
  PASS_SCORE,
  CATEGORY_LABELS,
};
