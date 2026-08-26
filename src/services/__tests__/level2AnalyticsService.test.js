'use strict';

// TASK-46 — fixtures for getLevel2Report. Mocks the models the same way
// trajectoryService.test.js does, so no database is touched.
jest.mock('../../models', () => ({
  Level2TopicProgress:   { findOne: jest.fn() },
  Level2Session:         { findOne: jest.fn() },
  Level2SentenceAttempt: { findAll: jest.fn() },
  Level2NonVerbalAttempt:{ count:   jest.fn() },
}));

const {
  Level2TopicProgress,
  Level2Session,
  Level2SentenceAttempt,
  Level2NonVerbalAttempt,
} = require('../../models');

const { getLevel2Report, TOPICS } = require('../level2AnalyticsService');

/** A Sequelize-ish row: real attributes plus .get({ plain: true }). */
function row(data) {
  return { ...data, get: () => data };
}

/** Every topic un-started: no progress row, no session. */
function primeEmpty() {
  Level2TopicProgress.findOne.mockResolvedValue(null);
  Level2Session.findOne.mockResolvedValue(null);
  Level2SentenceAttempt.findAll.mockResolvedValue([]);
  Level2NonVerbalAttempt.count.mockResolvedValue(0);
}

beforeEach(() => {
  jest.clearAllMocks();
  primeEmpty();
});

describe('module export', () => {
  it('exports getLevel2Report as a function covering exactly the three topics', () => {
    expect(typeof getLevel2Report).toBe('function');
    expect(TOPICS).toEqual(['self_introduction', 'describe_friend', 'describe_pet']);
  });
});

// ---------------------------------------------------------------------------
// AC1 — a student with zero Level 2 sessions
// ---------------------------------------------------------------------------

describe('AC1 — student with no Level 2 sessions at all', () => {
  it('returns all three topics as not_started, with no error', async () => {
    const report = await getLevel2Report(1);
    expect(report.topics).toHaveLength(3);
    expect(report.topics.map((t) => t.topic)).toEqual(TOPICS);
    expect(report.topics.every((t) => t.status === 'not_started')).toBe(true);
  });

  it('reports zeroed totals', async () => {
    const { totals } = await getLevel2Report(1);
    expect(totals).toEqual({
      topics_total:   3,
      topics_started: 0,
      mastered:       0,
      in_progress:    0,
      struggling:     0,
      not_started:    3,
    });
  });

  it('never returns an undefined field — "no data" is always an explicit value', async () => {
    const report = await getLevel2Report(1);
    for (const t of report.topics) {
      for (const [key, value] of Object.entries(t)) {
        expect([key, value === undefined]).toEqual([key, false]);
      }
      // Empty arrays and zeroes, not nulls, for the countable fields.
      expect(t.elements_included).toEqual([]);
      expect(t.elements_missing).toEqual([]);
      expect(t.sentences_total).toBe(0);
      expect(t.sentences_needing_hints).toBe(0);
      expect(t.used_picture_fallback).toBe(false);
      expect(t.silence_timeout).toBe(false);
      expect(t.sessions_attempted).toBe(0);
      // Genuinely-absent values are null, not 0 — a teacher must not read a
      // missing score as a score of zero.
      expect(t.last_session_date).toBeNull();
      expect(t.last_pathway).toBeNull();
      expect(t.paragraph_score).toBeNull();
      expect(t.sentence_by_sentence_score).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// AC2 — elements_included / elements_missing
// ---------------------------------------------------------------------------

describe('AC2 — paragraph elements split into included and missing', () => {
  it('puts explicit-true keys in included and everything else in missing', async () => {
    // name/age true, hometown false, gender/activity absent from the object —
    // all three "not detected" shapes in one fixture.
    Level2TopicProgress.findOne.mockResolvedValue(
      row({ status: 'in_progress', total_sessions: 2 })
    );
    Level2Session.findOne.mockResolvedValue(
      row({
        id: 11,
        pathway: 'verbal',
        full_paragraph_elements_detected: { name: true, age: true, hometown: false },
        full_paragraph_total_score: 2,
        sxs_element_score: 3,
        started_at: '2026-08-18T09:00:00.000Z',
        ended_at: '2026-08-18T09:12:00.000Z',
        silence_timeout_triggered: false,
      })
    );
    Level2SentenceAttempt.findAll.mockResolvedValue([]);

    const { topics } = await getLevel2Report(1);
    expect(topics[0].elements_included).toEqual(['name', 'age']);
    expect(topics[0].elements_missing).toEqual(['hometown', 'gender', 'activity']);
    // Together they always account for all five, in reading order.
    expect([...topics[0].elements_included, ...topics[0].elements_missing].sort())
      .toEqual(['activity', 'age', 'gender', 'hometown', 'name']);
  });

  it('treats a null elements object as nothing detected, not as an error', async () => {
    Level2TopicProgress.findOne.mockResolvedValue(row({ status: 'in_progress', total_sessions: 1 }));
    Level2Session.findOne.mockResolvedValue(
      row({
        id: 12,
        pathway: null,
        full_paragraph_elements_detected: null,
        full_paragraph_total_score: null,
        sxs_element_score: null,
        started_at: '2026-08-18T09:00:00.000Z',
        ended_at: null,
        silence_timeout_triggered: false,
      })
    );

    const { topics } = await getLevel2Report(1);
    expect(topics[0].elements_included).toEqual([]);
    expect(topics[0].elements_missing).toHaveLength(5);
    // paragraph_score stays null, which is how the screen tells "paragraph not
    // attempted" apart from "attempted and scored 0".
    expect(topics[0].paragraph_score).toBeNull();
  });

  it('falls back to started_at when a session was begun but never ended', async () => {
    Level2TopicProgress.findOne.mockResolvedValue(row({ status: 'in_progress', total_sessions: 1 }));
    Level2Session.findOne.mockResolvedValue(
      row({
        id: 13,
        pathway: 'non_verbal',
        full_paragraph_elements_detected: { name: true },
        full_paragraph_total_score: 1,
        sxs_element_score: 1,
        started_at: '2026-08-19T10:00:00.000Z',
        ended_at: null,
        silence_timeout_triggered: true,
      })
    );

    const { topics } = await getLevel2Report(1);
    expect(topics[0].last_session_date).toBe('2026-08-19T10:00:00.000Z');
    expect(topics[0].last_pathway).toBe('non_verbal');
    expect(topics[0].silence_timeout).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC3 — hint counts are per-session, never all-time
// ---------------------------------------------------------------------------

describe('AC3 — sentences_needing_hints is scoped to the reported session', () => {
  // Two sessions with different hint counts. Only session 22 is the most
  // recent, so only its three rows may be counted — session 21's single hint
  // must not leak in.
  const SESSION_21_ROWS = [
    row({ sentence_index: 1, step3_result: 'required_hint' }),
    row({ sentence_index: 2, step3_result: 'first_attempt' }),
  ];
  const SESSION_22_ROWS = [
    row({ sentence_index: 1, step3_result: 'required_hint' }),
    row({ sentence_index: 2, step3_result: 'required_hint' }),
    row({ sentence_index: 3, step3_result: 'first_attempt' }),
    row({ sentence_index: 4, step3_result: 'auto_advanced' }),
    row({ sentence_index: 5, step3_result: null }),
  ];

  beforeEach(() => {
    Level2TopicProgress.findOne.mockResolvedValue(row({ status: 'in_progress', total_sessions: 2 }));
    Level2Session.findOne.mockResolvedValue(
      row({
        id: 22,
        pathway: 'verbal',
        full_paragraph_elements_detected: { name: true, age: true, hometown: true, gender: true, activity: true },
        full_paragraph_total_score: 5,
        sxs_element_score: 4,
        started_at: '2026-08-19T09:00:00.000Z',
        ended_at: '2026-08-19T09:20:00.000Z',
        silence_timeout_triggered: false,
      })
    );
    // The query is filtered by level2_session_id, so only session 22's rows
    // ever come back — assert that filter is actually applied, below.
    Level2SentenceAttempt.findAll.mockImplementation(async ({ where }) =>
      (where.level2_session_id === 22 ? SESSION_22_ROWS : SESSION_21_ROWS)
    );
  });

  it('counts only required_hint rows belonging to the most recent session', async () => {
    const { topics } = await getLevel2Report(1);
    expect(topics[0].sentences_needing_hints).toBe(2); // not 3, which all-time would give
    expect(topics[0].sentences_total).toBe(5);
  });

  it('queries sentence attempts by the reported session id', async () => {
    await getLevel2Report(1);
    for (const call of Level2SentenceAttempt.findAll.mock.calls) {
      expect(call[0].where.level2_session_id).toBe(22);
    }
  });

  it('counts the picture fallback for that same session only', async () => {
    Level2NonVerbalAttempt.count.mockResolvedValue(2);
    const { topics } = await getLevel2Report(1);
    expect(topics[0].used_picture_fallback).toBe(true);
    for (const call of Level2NonVerbalAttempt.count.mock.calls) {
      expect(call[0].where.level2_session_id).toBe(22);
    }
  });

  it('reports used_picture_fallback false when that session has none', async () => {
    Level2NonVerbalAttempt.count.mockResolvedValue(0);
    const { topics } = await getLevel2Report(1);
    expect(topics[0].used_picture_fallback).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Totals across a mixed set of topics
// ---------------------------------------------------------------------------

describe('totals reflect each topic\'s own status', () => {
  it('counts mastered / in_progress / struggling / not_started separately', async () => {
    const byTopic = {
      self_introduction: row({ status: 'mastered',   total_sessions: 4 }),
      describe_friend:   row({ status: 'struggling', total_sessions: 3 }),
      describe_pet:      null, // never started
    };
    Level2TopicProgress.findOne.mockImplementation(async ({ where }) => byTopic[where.topic]);

    const { totals, topics } = await getLevel2Report(1);
    expect(topics.map((t) => t.status)).toEqual(['mastered', 'struggling', 'not_started']);
    expect(totals).toEqual({
      topics_total:   3,
      topics_started: 2,
      mastered:       1,
      in_progress:    0,
      struggling:     1,
      not_started:    1,
    });
    expect(topics[0].sessions_attempted).toBe(4);
    expect(topics[2].sessions_attempted).toBe(0);
  });

  it('scopes every query to the requested student', async () => {
    await getLevel2Report(77);
    for (const call of Level2TopicProgress.findOne.mock.calls) {
      expect(call[0].where.student_id).toBe(77);
    }
    for (const call of Level2Session.findOne.mock.calls) {
      expect(call[0].where.student_id).toBe(77);
    }
  });

  it('reads the most recent session, ordered by started_at descending', async () => {
    await getLevel2Report(1);
    for (const call of Level2Session.findOne.mock.calls) {
      expect(call[0].order).toEqual([['started_at', 'DESC']]);
    }
  });
});
