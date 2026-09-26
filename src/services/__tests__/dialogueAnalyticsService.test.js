'use strict';

// TASK-47 — the timelines are raw date-grouped SQL, so the assertions here are
// about the query that gets built (which filters are present) and the shaping of
// the rows that come back. No database is touched.
jest.mock('../../config/database', () => ({ query: jest.fn() }));

const sequelize = require('../../config/database');
const {
  getModuleTimeline,
  getWordTimeline,
  IN_SCOPE_CATEGORIES,
} = require('../dialogueAnalyticsService');

/** Last query text + replacements, normalised to single-spaced SQL. */
function lastQuery() {
  const [sql, options] = sequelize.query.mock.calls[sequelize.query.mock.calls.length - 1];
  return { sql: sql.replace(/\s+/g, ' '), ...options };
}

beforeEach(() => {
  jest.clearAllMocks();
  sequelize.query.mockResolvedValue([]);
});

describe('module export', () => {
  it('exports both timeline functions and the in-scope category list', () => {
    expect(typeof getModuleTimeline).toBe('function');
    expect(typeof getWordTimeline).toBe('function');
    expect(IN_SCOPE_CATEGORIES).toEqual(['greetings', 'magic_words', 'abilities']);
  });
});

// ---------------------------------------------------------------------------
// AC1 — points arrive in exactly the shape TrendSparkline consumes
// ---------------------------------------------------------------------------

describe('AC1 — TrendSparkline point shape', () => {
  it('returns { points: [{ date, attempts, correct, accuracy }] }', async () => {
    sequelize.query.mockResolvedValue([
      { date: '2026-08-24', attempts: 3, correct: 2 },
    ]);
    const result = await getModuleTimeline(1);
    expect(Object.keys(result)).toEqual(['points']);
    expect(result.points[0]).toEqual({
      date: '2026-08-24', attempts: 3, correct: 2, accuracy: 0.667,
    });
  });

  it('rounds accuracy to 3dp so the payload carries no float noise', async () => {
    sequelize.query.mockResolvedValue([{ date: '2026-08-24', attempts: 3, correct: 1 }]);
    const { points } = await getModuleTimeline(1);
    expect(points[0].accuracy).toBe(0.333);
  });

  it('reports accuracy as null, never 0, when a date somehow has no attempts', async () => {
    // 0 attempts must not render as "0% accuracy" — TrendSparkline drops null
    // points rather than plotting them as a failure.
    sequelize.query.mockResolvedValue([{ date: '2026-08-24', attempts: 0, correct: 0 }]);
    const { points } = await getModuleTimeline(1);
    expect(points[0].accuracy).toBeNull();
  });

  it('returns an empty points array when there is no activity', async () => {
    expect(await getModuleTimeline(1)).toEqual({ points: [] });
    expect(await getWordTimeline(1, 10)).toEqual({ points: [] });
  });
});

// ---------------------------------------------------------------------------
// AC2 — Days of the Week can never appear
// ---------------------------------------------------------------------------

describe('AC2 — Days of the Week is excluded under all conditions', () => {
  it('restricts the module query to the three in-scope categories', async () => {
    await getModuleTimeline(1);
    const q = lastQuery();
    expect(q.sql).toContain('w.category IN (:categories)');
    expect(q.replacements.categories).toEqual(['greetings', 'magic_words', 'abilities']);
    expect(q.replacements.categories).not.toContain('days_of_week');
  });

  it('applies the same category filter to the per-word query', async () => {
    // Defense in depth: without this join a days_of_week word_id passed straight
    // to the endpoint would return data.
    await getWordTimeline(1, 99);
    const q = lastQuery();
    expect(q.sql).toContain('JOIN dialogue_words w ON w.id = a.word_id');
    expect(q.sql).toContain('w.category IN (:categories)');
    expect(q.replacements.categories).toEqual(IN_SCOPE_CATEGORIES);
  });

  it('a Days-of-Week row filtered out by SQL never reaches the output', async () => {
    // The driver returns only in-scope rows because of the WHERE clause above;
    // this asserts the shaping layer adds nothing back.
    sequelize.query.mockResolvedValue([{ date: '2026-08-24', attempts: 2, correct: 2 }]);
    const { points } = await getModuleTimeline(1);
    expect(points).toHaveLength(1);
    expect(points.every((p) => p.date === '2026-08-24')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC3 — the "24th vs 26th" case
// ---------------------------------------------------------------------------

describe('AC3 — two dates produce two independently-correct points', () => {
  it('keeps each date\'s own numbers rather than repeating the latest', async () => {
    sequelize.query.mockResolvedValue([
      { date: '2026-08-24', attempts: 4, correct: 1 },
      { date: '2026-08-26', attempts: 3, correct: 3 },
    ]);
    const { points } = await getWordTimeline(1, 10);

    expect(points).toHaveLength(2);
    expect(points[0]).toEqual({ date: '2026-08-24', attempts: 4, correct: 1, accuracy: 0.25 });
    expect(points[1]).toEqual({ date: '2026-08-26', attempts: 3, correct: 3, accuracy: 1 });
    // Two distinct dates, and the improvement between them is visible.
    expect(points[0].date).not.toBe(points[1].date);
    expect(points[1].accuracy).toBeGreaterThan(points[0].accuracy);
  });

  it('does not truncate a single word\'s history to a window', async () => {
    await getWordTimeline(1, 10);
    const q = lastQuery();
    expect(q.sql).not.toContain('INTERVAL');
    expect(q.replacements).not.toHaveProperty('days');
  });
});

// ---------------------------------------------------------------------------
// HARD RULES 3 and 5
// ---------------------------------------------------------------------------

describe('hard rules', () => {
  it('HARD RULE 3 — every phase-3 query excludes session-summary rows', async () => {
    await getModuleTimeline(1);
    expect(lastQuery().sql).toContain('a.scenario_label IS NOT NULL');
    await getWordTimeline(1, 10);
    expect(lastQuery().sql).toContain('a.scenario_label IS NOT NULL');
  });

  it('HARD RULE 5 — dates come from attempted_at, never session_id', async () => {
    await getModuleTimeline(1);
    const { sql } = lastQuery();
    expect(sql).toContain("to_char(a.attempted_at::date, 'YYYY-MM-DD')");
    expect(sql).not.toContain('session_id');
  });

  it('AC7 — reads no Rule 1/2/3 field', async () => {
    await getModuleTimeline(1);
    await getWordTimeline(1, 10);
    for (const call of sequelize.query.mock.calls) {
      for (const field of [
        'current_phase', 'phase1_gate_passed', 'session_pass_count',
        'consecutive_fail_count', 'dialogue_word_progress',
      ]) {
        expect([field, call[0].includes(field)]).toEqual([field, false]);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// days window
// ---------------------------------------------------------------------------

describe('days window', () => {
  it('defaults to 90 days', async () => {
    await getModuleTimeline(1);
    expect(lastQuery().replacements.days).toBe(90);
  });

  it('accepts an explicit window and clamps absurd values', async () => {
    await getModuleTimeline(1, 30);
    expect(lastQuery().replacements.days).toBe(30);

    await getModuleTimeline(1, 5000);
    expect(lastQuery().replacements.days).toBe(365);

    await getModuleTimeline(1, -4);
    expect(lastQuery().replacements.days).toBe(1);

    await getModuleTimeline(1, 'not-a-number');
    expect(lastQuery().replacements.days).toBe(90);
  });

  it('scopes every query to the requested student, as a number', async () => {
    await getModuleTimeline('77');
    expect(lastQuery().replacements.sid).toBe(77);
    await getWordTimeline('77', '10');
    expect(lastQuery().replacements).toMatchObject({ sid: 77, wid: 10 });
  });
});
