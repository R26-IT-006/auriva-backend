'use strict';

const { QueryTypes } = require('sequelize');
const sequelize = require('../config/database');

// TASK-47 — Level 1 practice-trend aggregation. Kept out of trajectoryService.js,
// which owns ML prediction/explanation; this file only groups and counts rows
// that already exist.
//
// SCOPE: these timelines are *session practice accuracy over time*. They are NOT
// a recomputation of mastery Rules 1-3 — that logic lives in dialogueService.js
// and is the single source of truth for mastered/struggling. Nothing here reads
// or derives current_phase, phase1_gate_passed, session_pass_count, or any other
// Rule 1/2/3 field.

// HARD RULE 4 — Days of the Week is permanently out of scope and must never
// reach a report.
const IN_SCOPE_CATEGORIES = ['greetings', 'magic_words', 'abilities'];

/** Round to 3dp so the payload doesn't carry float noise (matches conceptAnalyticsService). */
const r3 = (v) => (v === null ? null : Math.round(v * 1000) / 1000);

/** Keep an arbitrary `days` query param inside a sane window. */
function clampDays(days) {
  const n = Number(days);
  return Number.isFinite(n) ? Math.max(1, Math.min(365, n)) : 90;
}

/**
 * Phase 3 is the outcome-bearing table: it is the point in the flow where a
 * word's result for that attempt is actually decided, which is why
 * buildSession1Features already treats it that way.
 *
 * HARD RULE 3 — `scenario_label IS NOT NULL` excludes the session-summary rows
 * that share this table and would otherwise corrupt every per-attempt count.
 * HARD RULE 5 — dates come from attempted_at, never from session_id.
 */
const POINT_COLUMNS = `
  to_char(a.attempted_at::date, 'YYYY-MM-DD')                    AS date,
  COUNT(*)::int                                                  AS attempts,
  COUNT(*) FILTER (WHERE a.first_tap_correct IS TRUE)::int        AS correct
`;

/** Shapes raw rows into TrendSparkline's `points` prop. */
const toPoints = (rows) => ({
  points: rows.map((t) => ({
    date:     t.date,
    attempts: t.attempts,
    correct:  t.correct,
    accuracy: t.attempts > 0 ? r3(t.correct / t.attempts) : null,
  })),
});

/**
 * Module-level: every in-scope-category word, grouped by date, last N days.
 */
async function getModuleTimeline(studentId, days = 90) {
  const rows = await sequelize.query(
    `SELECT ${POINT_COLUMNS}
       FROM dialogue_phase3_attempts a
       JOIN dialogue_words w ON w.id = a.word_id
      WHERE a.student_id = :sid
        AND a.scenario_label IS NOT NULL
        AND w.category IN (:categories)
        AND a.attempted_at >= NOW() - (:days * INTERVAL '1 day')
      GROUP BY 1
      ORDER BY 1 ASC`,
    {
      replacements: {
        sid: Number(studentId),
        categories: IN_SCOPE_CATEGORIES,
        days: clampDays(days),
      },
      type: QueryTypes.SELECT,
    },
  );
  return toPoints(rows);
}

/**
 * One word, every recorded date, no window truncation — a single word's lifetime
 * attempt volume is small, and truncating it would hide exactly the
 * "attempted on the 24th, again on the 26th" comparison this exists to show.
 *
 * The category join is kept here too: it is the only thing stopping a
 * Days-of-the-Week word_id passed straight to the endpoint from returning data.
 */
async function getWordTimeline(studentId, wordId) {
  const rows = await sequelize.query(
    `SELECT ${POINT_COLUMNS}
       FROM dialogue_phase3_attempts a
       JOIN dialogue_words w ON w.id = a.word_id
      WHERE a.student_id = :sid
        AND a.word_id = :wid
        AND a.scenario_label IS NOT NULL
        AND w.category IN (:categories)
      GROUP BY 1
      ORDER BY 1 ASC`,
    {
      replacements: {
        sid: Number(studentId),
        wid: Number(wordId),
        categories: IN_SCOPE_CATEGORIES,
      },
      type: QueryTypes.SELECT,
    },
  );
  return toPoints(rows);
}

module.exports = { getModuleTimeline, getWordTimeline, IN_SCOPE_CATEGORIES };
