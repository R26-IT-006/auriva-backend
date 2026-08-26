'use strict';

// Node's built-in runner — `node --test`. The backend has no test dependencies
// and this keeps it that way.
//
// These cover the pure functions only: pseudonymisation, hashing, rehydration.
// That is deliberate. The pseudonymisation guarantee is the one property here
// that must never regress silently, and it is exactly the property that can be
// asserted with no network and no database.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildNarrativeInput,
  buildDigestInput,
  hashInput,
  rehydrate,
} = require('../src/services/aiSummaryService');

const FORBIDDEN_KEYS = ['student_name', 'full_name', 'fullName', 'student_id', 'studentId', 'studentName'];

/** Every key and every string value anywhere in the structure. */
function walk(node, keys = [], strings = []) {
  if (typeof node === 'string') strings.push(node);
  else if (Array.isArray(node)) node.forEach((v) => walk(v, keys, strings));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      keys.push(k);
      walk(v, keys, strings);
    }
  }
  return { keys, strings };
}

// Shaped after the real getConceptReport payload, names included.
function reportFixture() {
  return {
    generated_at: '2026-08-26T10:00:00.000Z',
    student_id: 42,
    student_name: 'Nimal Perera',
    window_days: 90,
    totals: {
      catalogue_concepts: 93, started: 6, tier1_passed: 4,
      tier2_passed: 3, tier3_passed: 1, mastered: 3,
      mastery_pct: 0.032, orphaned: 0,
    },
    categories: [
      { category_key: 'fruits', label: 'Fruits', total: 12, started: 6, tier1_passed: 4,
        tier2_passed: 3, tier3_passed: 1, mastered: 3, mastery_pct: 0.25,
        avg_tier1_score: 0.78, needs_attention: ['mango'] },
      { category_key: 'shapes', label: 'Shapes', total: 8, started: 0, tier1_passed: 0,
        tier2_passed: 0, tier3_passed: 0, mastered: 0, mastery_pct: 0,
        avg_tier1_score: null, needs_attention: [] },
    ],
    concepts: [
      { concept_key: 'mango', category_key: 'fruits', tier1_status: 'failed', tier1_score: 0.33,
        tier1_passed_at: null, tier2_status: 'locked', tier3_status: 'locked',
        tier1_retry_count: 2, tier2_retry_count: 0, mastered: false,
        real_attempts: 9, correct_attempts: 3, avg_response_ms: 4200, in_catalogue: true },
      { concept_key: 'apple', category_key: 'fruits', tier1_status: 'passed', tier1_score: 1,
        tier1_passed_at: '2026-08-20T09:00:00.000Z', tier2_status: 'passed', tier3_status: 'passed',
        tier1_retry_count: 0, tier2_retry_count: 0, mastered: true,
        real_attempts: 3, correct_attempts: 3, avg_response_ms: 2100, in_catalogue: true },
    ],
    confusions: [{ correct_key: 'mango', selected_key: 'banana', tier: 1, count: 4 }],
    response_times: { overall_avg_ms: 3300, correct_avg_ms: 2400, incorrect_avg_ms: 5100,
      by_tier: { 1: 3300, 2: null }, sample_size: 12 },
    engagement: { total_taps: 88, exposure_ms: 412000, video_ms: 60000,
      coloring_sessions: 2, relearn_count: 1 },
    activities: [{ activity_number: 1, category_key: 'fruits', difficulty_level: 2, score: 0.6,
      correct_count: 3, total_rounds: 5, status: 'passed', concept_keys: ['apple'],
      completed_at: '2026-08-21T09:00:00.000Z' }],
    timeline: [{ date: '2026-08-20', attempts: 6, correct: 4, accuracy: 0.667 }],
    last_activity_at: '2026-08-21T09:00:00.000Z',
  };
}

function dashboardFixture() {
  return {
    profile: { tid: 7, full_name: 'Anoma Silva' },
    stats: { totalStudents: 2, conceptsMastered: 5, avgEngagement: 0.71 },
    weekStats: { activitiesAssigned: 6, activitiesCompleted: 4, avgProgress: 0.72, milestones: 2 },
    sessionDates: ['2026-08-25T09:00:00.000Z', '2026-07-01T09:00:00.000Z'],
    proficiency: [
      { studentId: 42, fullName: 'Nimal Perera', profilePhotoUrl: null, dateOfBirth: '2018-04-02',
        conceptsAssigned: 6, conceptsMastered: 3, avgScore: 0.78, lastSessionAt: '2026-08-25T09:00:00.000Z' },
      { studentId: 43, fullName: 'Kavya Fernando', profilePhotoUrl: null, dateOfBirth: '2017-11-19',
        conceptsAssigned: 4, conceptsMastered: 2, avgScore: 0.55, lastSessionAt: '2026-08-24T09:00:00.000Z' },
    ],
    sessions: [{ studentName: 'Nimal Perera', startedAt: '2026-08-25T09:00:00.000Z', endedAt: null, isActive: false }],
    recentAchievements: [{ studentName: 'Kavya Fernando', conceptKey: 'apple', categoryKey: 'fruits',
      passedAt: '2026-08-24T09:30:00.000Z' }],
  };
}

test('buildNarrativeInput carries no identifying key', () => {
  const { keys } = walk(buildNarrativeInput(reportFixture()));
  for (const forbidden of FORBIDDEN_KEYS) {
    assert.ok(!keys.includes(forbidden), `payload leaked key "${forbidden}"`);
  }
});

test('buildNarrativeInput carries no identifying value', () => {
  const { strings } = walk(buildNarrativeInput(reportFixture()));
  const joined = strings.join(' ');
  assert.ok(!joined.includes('Nimal'), 'payload leaked the student name');
  assert.ok(!joined.includes('Perera'), 'payload leaked the student surname');
});

test('buildNarrativeInput keeps the analytics the summary needs', () => {
  const input = buildNarrativeInput(reportFixture());
  assert.equal(input.totals.mastered, 3);
  assert.equal(input.confusions[0].shown, 'mango');
  assert.equal(input.confusions[0].chosen, 'banana');
  assert.equal(input.confusions[0].times, 4);
  // Untouched categories are dropped so the model doesn't read absence as a finding.
  assert.equal(input.categories.length, 1);
  assert.equal(input.categories[0].label, 'Fruits');
  // needs_attention is flattened onto the concept it refers to.
  assert.equal(input.concepts.find((c) => c.concept_key === 'mango').needs_attention, true);
  assert.equal(input.concepts.find((c) => c.concept_key === 'apple').needs_attention, false);
});

test('buildDigestInput replaces every name with a label', () => {
  const { payload, names } = buildDigestInput(dashboardFixture(), '2026-08-23');
  const { keys, strings } = walk(payload);

  for (const forbidden of FORBIDDEN_KEYS) {
    assert.ok(!keys.includes(forbidden), `digest leaked key "${forbidden}"`);
  }
  const joined = strings.join(' ');
  for (const name of ['Nimal', 'Perera', 'Kavya', 'Fernando', 'Anoma', 'Silva']) {
    assert.ok(!joined.includes(name), `digest leaked "${name}"`);
  }

  assert.deepEqual(payload.students.map((s) => s.label), ['Student A', 'Student B']);
  // The achievement belongs to the second student and must carry her label.
  assert.equal(payload.recent_achievements[0].student, 'Student B');
  assert.equal(names.get('Student A'), 'Nimal Perera');
  assert.equal(names.get('Student B'), 'Kavya Fernando');
});

test('buildDigestInput drops dates of birth and counts only this week\'s sessions', () => {
  const { payload } = buildDigestInput(dashboardFixture(), '2026-08-23');
  assert.ok(!walk(payload).keys.includes('dateOfBirth'));
  assert.ok(!walk(payload).keys.includes('date_of_birth'));
  // One session falls inside the week, one in July.
  assert.equal(payload.this_week.sessions, 1);
  assert.equal(payload.week_starting, '2026-08-23');
});

test('rehydrate restores names in the model output', () => {
  const { names } = buildDigestInput(dashboardFixture(), '2026-08-23');
  const output = {
    headline: 'Student A completed 6 activities this week.',
    watch_areas: ['Student B averaged 55% across 4 concepts.'],
  };
  const restored = rehydrate(output, names);
  assert.equal(restored.headline, 'Nimal Perera completed 6 activities this week.');
  assert.equal(restored.watch_areas[0], 'Kavya Fernando averaged 55% across 4 concepts.');
});

test('hashInput is stable for identical input and moves when data changes', () => {
  const a = hashInput(buildNarrativeInput(reportFixture()));
  const b = hashInput(buildNarrativeInput(reportFixture()));
  assert.equal(a, b, 'identical reports must produce identical hashes');

  const changed = reportFixture();
  changed.concepts[0].tier1_score = 0.9;
  assert.notEqual(a, hashInput(buildNarrativeInput(changed)));
});

test('a new week produces a new digest hash', () => {
  const week1 = hashInput(buildDigestInput(dashboardFixture(), '2026-08-23').payload);
  const week2 = hashInput(buildDigestInput(dashboardFixture(), '2026-08-30').payload);
  assert.notEqual(week1, week2, 'the cache must rotate weekly on its own');
});
