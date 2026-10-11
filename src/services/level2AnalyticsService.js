'use strict';

const { QueryTypes } = require('sequelize');
const sequelize = require('../config/database');
const { Op } = require('sequelize');
const {
  Level2TopicProgress,
  Level2Session,
  Level2SentenceAttempt,
  Level2NonVerbalAttempt,
  Level2ProductionAttempt,
  Level2GenderSelectionLog,
  Level2ActivitySelectionLog,
  SentenceQuestionnaire,
} = require('../models');

// TASK-46 — report aggregation for Level 2, kept out of level2Service.js the
// same way conceptAnalyticsService.js is kept out of conceptService.js:
// level2Service.js owns session/attempt *recording* and is already large, and
// nothing in here writes. This module is read-only by design.

const TOPICS = ['self_introduction', 'describe_friend', 'describe_pet'];

// The five paragraph elements level2Service.js's detectParagraphElements
// reports on, in the order a child says them. Order matters here: it is the
// order the teacher reads them back in.
const PARAGRAPH_ELEMENTS = ['name', 'age', 'hometown', 'gender', 'activity'];

/**
 * One report per student covering all three Level 2 topics.
 *
 * Current-snapshot only: each topic is summarised from its MOST RECENT session,
 * plus the running counters Level2TopicProgress maintains across sessions.
 * Multi-session history is deliberately not built here.
 *
 * Every field is always present. A topic that was never started returns
 * 'not_started' with zeroes and empty arrays — never undefined — so the client
 * never has to tell "no data" apart from "zero".
 */
async function getLevel2Report(studentId) {
  const topics = [];

  for (const topic of TOPICS) {
    const progress = await Level2TopicProgress.findOne({
      where: { student_id: studentId, topic },
      attributes: [
        'status',
        'session_pass_count',
        'last_pass_date',
        'consecutive_fail_count',
        'total_sessions',
      ],
    });

    const session = await Level2Session.findOne({
      where: { student_id: studentId, topic },
      attributes: [
        'id',
        'pathway',
        'full_paragraph_elements_detected',
        'full_paragraph_total_score',
        'sxs_element_score',
        'started_at',
        'ended_at',
        'silence_timeout_triggered',
      ],
      order: [['started_at', 'DESC']],
    });

    // Both counts are scoped to THIS session's id, never all-time — a teacher
    // reading "needed a hint on 2 of 5" must be reading about the session the
    // rest of the row describes.
    let sentencesTotal = 0;
    let sentencesNeedingHints = 0;
    let usedPictureFallback = false;

    if (session) {
      const sentenceRows = await Level2SentenceAttempt.findAll({
        where: { level2_session_id: session.id },
        attributes: ['sentence_index', 'step3_result'],
        order: [['sentence_index', 'ASC']],
      });
      sentencesTotal = sentenceRows.length;
      sentencesNeedingHints = sentenceRows
        .filter((r) => r.get({ plain: true }).step3_result === 'required_hint')
        .length;

      usedPictureFallback = (await Level2NonVerbalAttempt.count({
        where: { level2_session_id: session.id },
      })) > 0;
    }

    // Split the detected-elements object into two ordered lists. An element is
    // "included" only on an explicit true; false, absent, and a null object all
    // mean it did not appear. When no paragraph was attempted at all,
    // paragraph_score stays null and the client is expected to say so rather
    // than reporting all five as missing.
    const detected = session ? session.full_paragraph_elements_detected : null;
    const elementsIncluded = [];
    const elementsMissing = [];
    if (session) {
      for (const key of PARAGRAPH_ELEMENTS) {
        if (detected && detected[key] === true) elementsIncluded.push(key);
        else elementsMissing.push(key);
      }
    }

    // started_at is the fallback so a session that was begun but never
    // completed still reports when it happened, rather than reading as
    // "not attempted yet".
    const lastSessionDate = session
      ? (session.ended_at ?? session.started_at ?? null)
      : null;

    // Display status. Level2TopicProgress.status is only written when a session
    // is COMPLETED, so a child partway through their first session still reads
    // 'not_started' there — while this row shows their recorded activity. Any
    // session row means the topic has been started: report it as in_progress.
    // Mastered / struggling still come only from the stored status.
    const storedStatus = progress ? progress.status : 'not_started';
    const status = storedStatus === 'not_started' && session ? 'in_progress' : storedStatus;

    topics.push({
      topic,
      status,
      sessions_attempted:         progress ? progress.total_sessions : 0,
      last_session_date:          lastSessionDate,
      last_pathway:               session ? (session.pathway ?? null) : null,
      elements_included:          elementsIncluded,
      elements_missing:           elementsMissing,
      paragraph_score:            session ? (session.full_paragraph_total_score ?? null) : null,
      sentence_by_sentence_score: session ? (session.sxs_element_score ?? null) : null,
      sentences_needing_hints:    sentencesNeedingHints,
      sentences_total:            sentencesTotal,
      used_picture_fallback:      usedPictureFallback,
      silence_timeout:            session ? !!session.silence_timeout_triggered : false,
    });
  }

  const countBy = (status) => topics.filter((t) => t.status === status).length;

  return {
    totals: {
      topics_total:   TOPICS.length,
      topics_started: topics.filter((t) => t.status !== 'not_started').length,
      mastered:       countBy('mastered'),
      in_progress:    countBy('in_progress'),
      struggling:     countBy('struggling'),
      not_started:    countBy('not_started'),
    },
    topics,
  };
}

// ---------------------------------------------------------------------------
// TASK-47 — practice-trend timelines
//
// SCOPE: these are *session practice accuracy over time*, NOT a recomputation of
// Level2TopicProgress.status. That status is written solely by
// level2Service.js's completeSession and remains the single source of truth for
// mastered/struggling; nothing below reads or re-derives it.
// ---------------------------------------------------------------------------

/** Both Level 2 scores are counts out of five. */
const LEVEL2_MAX_SCORE = 5;

/** A session counts as "correct" at 3 of 5 or better. */
const LEVEL2_CORRECT_AT = 3;

const r3 = (v) => (v === null ? null : Math.round(v * 1000) / 1000);

function clampDays(days) {
  const n = Number(days);
  return Number.isFinite(n) ? Math.max(1, Math.min(365, n)) : 90;
}

/**
 * Which score represents a session's real production attempt — grounded in
 * level2Service.js rather than assumed:
 *
 * - `completeSession` (level2Service.js:959-982) computes `sxs_element_score`
 *   from the session's sentence_by_sentence production attempts and writes it on
 *   EVERY completed session, for every topic. The mastery algorithm directly
 *   below it uses that value and nothing else (`isPass = sxsScore >= 4`).
 * - `full_paragraph_total_score` is written only by `assessParagraph`, which
 *   throws 409 for any topic other than self_introduction
 *   (level2Service.js:825-827) — describe_friend/describe_pet sessions
 *   structurally cannot have one.
 *
 * So sxs_element_score takes precedence, with the paragraph score as a fallback
 * for a self_introduction session that recorded one but no sentence attempts.
 */
const SESSION_SCORE = 'COALESCE(s.sxs_element_score, s.full_paragraph_total_score)';

/**
 * One point per calendar date, not per session: two sessions on the same day
 * must collapse into one point, both because TrendSparkline keys its dots by
 * date and because a date axis with two dots on one date is meaningless.
 * `accuracy` is that date's mean score over five.
 */
const LEVEL2_POINT_COLUMNS = `
  to_char(COALESCE(s.ended_at, s.started_at)::date, 'YYYY-MM-DD')        AS date,
  COUNT(*)::int                                                          AS attempts,
  COUNT(*) FILTER (WHERE ${SESSION_SCORE} >= ${LEVEL2_CORRECT_AT})::int  AS correct,
  AVG(${SESSION_SCORE})::float                                           AS avg_score
`;

const toLevel2Points = (rows) => ({
  points: rows.map((t) => ({
    date:     t.date,
    attempts: t.attempts,
    correct:  t.correct,
    accuracy: t.avg_score === null ? null : r3(Number(t.avg_score) / LEVEL2_MAX_SCORE),
  })),
});

/** Module-level: all three topics, grouped by date, last N days. */
async function getModuleTimeline(studentId, days = 90) {
  const rows = await sequelize.query(
    `SELECT ${LEVEL2_POINT_COLUMNS}
       FROM level2_sessions s
      WHERE s.student_id = :sid
        AND s.is_complete = TRUE
        AND ${SESSION_SCORE} IS NOT NULL
        AND COALESCE(s.ended_at, s.started_at) >= NOW() - (:days * INTERVAL '1 day')
      GROUP BY 1
      ORDER BY 1 ASC`,
    {
      replacements: { sid: Number(studentId), days: clampDays(days) },
      type: QueryTypes.SELECT,
    },
  );
  return toLevel2Points(rows);
}

/** One topic, every recorded session date, no window truncation. */
async function getTopicTimeline(studentId, topic) {
  const rows = await sequelize.query(
    `SELECT ${LEVEL2_POINT_COLUMNS}
       FROM level2_sessions s
      WHERE s.student_id = :sid
        AND s.topic = :topic
        AND s.is_complete = TRUE
        AND ${SESSION_SCORE} IS NOT NULL
      GROUP BY 1
      ORDER BY 1 ASC`,
    {
      replacements: { sid: Number(studentId), topic },
      type: QueryTypes.SELECT,
    },
  );
  return toLevel2Points(rows);
}

// ---------------------------------------------------------------------------
// Session activity — every recorded interaction for one topic, per session.
//
// Read-only, like the rest of this module. Lists every session (finished or
// not), newest first, each with its interactions in the order they happened,
// so the teacher can see exactly what the child did — including what the app
// heard them say (transcripts). Raw audio is never selected.
// ---------------------------------------------------------------------------

/** How many sessions one topic's activity view returns. */
const ACTIVITY_SESSION_LIMIT = 20;

/**
 * The topic's sentences as currently set up, by index — rebuilt from the
 * questionnaire with level2Service's own builders (never re-authored here).
 * Text is deterministic from the questionnaire; only the drag distractors are
 * random. Returns {} when the questionnaire or a topic's details are missing.
 */
function sentenceTextsFor(topic, questionnaire) {
  if (!questionnaire) return {};
  // Required lazily: level2Service pulls in the speech/TTS clients, which this
  // read-only module (and its tests) should not load just to be imported.
  // eslint-disable-next-line global-require
  const { buildSentences, buildFriendSentences, buildPetSentences } = require('./level2Service');
  try {
    if (topic === 'self_introduction') {
      return Object.fromEntries(buildSentences(questionnaire).map((text, i) => [i + 1, text]));
    }
    const defs = topic === 'describe_friend'
      ? buildFriendSentences(questionnaire)
      : buildPetSentences(questionnaire);
    return Object.fromEntries(defs.map((d) => [d.index, d.text]));
  } catch {
    return {};
  }
}

/** Groups plain rows by level2_session_id, keeping their query order. */
function bySession(rows) {
  const map = new Map();
  for (const r of rows) {
    const plain = typeof r.get === 'function' ? r.get({ plain: true }) : r;
    if (!map.has(plain.level2_session_id)) map.set(plain.level2_session_id, []);
    map.get(plain.level2_session_id).push(plain);
  }
  return map;
}

/**
 * @returns {{ topic, limited: boolean, sessions: Array }}
 */
async function getTopicActivity(studentId, topic) {
  const sessions = await Level2Session.findAll({
    where: { student_id: studentId, topic },
    attributes: [
      'id', 'started_at', 'ended_at', 'is_complete', 'pathway',
      'sxs_element_score', 'full_paragraph_total_score', 'full_paragraph_transcript',
      'full_paragraph_elements_detected', 'silence_timeout_triggered',
    ],
    order: [['started_at', 'DESC']],
    limit: ACTIVITY_SESSION_LIMIT,
  });

  if (sessions.length === 0) return { topic, limited: false, sessions: [] };

  const ids = sessions.map((s) => s.id);
  const inSessions = { level2_session_id: { [Op.in]: ids } };
  const inOrder = [['created_at', 'ASC'], ['id', 'ASC']];

  // One query per table for all listed sessions — never one per session.
  const [sentenceRows, productionRows, nonVerbalRows, genderRows, activityRows, questionnaire] =
    await Promise.all([
      Level2SentenceAttempt.findAll({
        where: inSessions,
        attributes: ['level2_session_id', 'sentence_index', 'step3_result', 'step4_score',
          'step4_transcript', 'step4_match_type', 'non_verbal_triggered', 'transcription_error', 'created_at'],
        order: inOrder,
      }),
      Level2ProductionAttempt.findAll({
        where: inSessions,
        attributes: ['level2_session_id', 'phase', 'sentence_index', 'score', 'match_type',
          'transcript', 'elements_detected', 'silence_timeout_triggered', 'transcription_error', 'created_at'],
        order: inOrder,
      }),
      Level2NonVerbalAttempt.findAll({
        where: inSessions,
        attributes: ['level2_session_id', 'sentence_index', 'context', 'correct_on_first_attempt',
          'required_second_attempt', 'auto_shown', 'created_at'],
        order: inOrder,
      }),
      Level2GenderSelectionLog.findAll({
        where: inSessions,
        attributes: ['level2_session_id', 'first_tap', 'correct_on_first_tap', 'required_prompt',
          'auto_advanced', 'created_at'],
        order: inOrder,
      }),
      Level2ActivitySelectionLog.findAll({
        where: inSessions,
        attributes: ['level2_session_id', 'expected_activity', 'child_selected_activity',
          'matched_expected', 'created_at'],
        order: inOrder,
      }),
      SentenceQuestionnaire.findOne({ where: { student_id: studentId } }),
    ]);

  const texts      = sentenceTextsFor(topic, questionnaire ? questionnaire.get({ plain: true }) : null);
  const sentencesBy  = bySession(sentenceRows);
  const productionBy = bySession(productionRows);
  const nonVerbalBy  = bySession(nonVerbalRows);
  const genderBy     = bySession(genderRows);
  const activityBy   = bySession(activityRows);

  const strip = ({ level2_session_id, ...rest }) => rest; // eslint-disable-line no-unused-vars

  return {
    topic,
    limited: sessions.length === ACTIVITY_SESSION_LIMIT,
    sessions: sessions.map((s) => {
      const plain       = typeof s.get === 'function' ? s.get({ plain: true }) : s;
      const nonVerbal   = (nonVerbalBy.get(plain.id) ?? []).map(strip);
      const production  = (productionBy.get(plain.id) ?? []).map(strip);
      return {
        id:                    plain.id,
        started_at:            plain.started_at ?? null,
        ended_at:              plain.ended_at ?? null,
        is_complete:           !!plain.is_complete,
        pathway:               plain.pathway ?? null,
        sxs_score:             plain.sxs_element_score ?? null,
        paragraph_score:       plain.full_paragraph_total_score ?? null,
        paragraph_transcript:  plain.full_paragraph_transcript ?? null,
        paragraph_elements:    plain.full_paragraph_elements_detected ?? null,
        silence_timeout:       !!plain.silence_timeout_triggered,
        // Teaching stage, one entry per sentence attempted, in order.
        sentences: (sentencesBy.get(plain.id) ?? []).map((a) => ({
          index:               a.sentence_index,
          text:                texts[a.sentence_index] ?? null,
          step3_result:        a.step3_result ?? null,
          step4_score:         a.step4_score ?? null,
          step4_transcript:    a.step4_transcript ?? null,
          step4_match_type:    a.step4_match_type ?? null,
          transcription_error: !!a.transcription_error,
          picture_choice:      nonVerbal.filter((n) => n.context === 'teaching_fallback'
            && n.sentence_index === a.sentence_index),
        })),
        gender:   (genderBy.get(plain.id) ?? []).map(strip)[0] ?? null,
        activity: (activityBy.get(plain.id) ?? []).map(strip)[0] ?? null,
        paragraph_attempts: production.filter((p) => p.phase === 'full_paragraph'),
        // Speaking each sentence on its own — the stage mastery is judged on.
        sxs_attempts: production
          .filter((p) => p.phase === 'sentence_by_sentence')
          .map((p) => ({ ...p, text: texts[p.sentence_index] ?? null })),
        sxs_picture_choice: nonVerbal.filter((n) => n.context === 'production_fallback'),
      };
    }),
  };
}

module.exports = {
  getLevel2Report,
  getModuleTimeline,
  getTopicTimeline,
  getTopicActivity,
  TOPICS,
  PARAGRAPH_ELEMENTS,
  ACTIVITY_SESSION_LIMIT,
};
