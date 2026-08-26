'use strict';

const {
  Level2TopicProgress,
  Level2Session,
  Level2SentenceAttempt,
  Level2NonVerbalAttempt,
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

    topics.push({
      topic,
      status:                     progress ? progress.status : 'not_started',
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

module.exports = { getLevel2Report, TOPICS, PARAGRAPH_ELEMENTS };
