'use strict';

// Feature 6 Step 5 — LetterAttempt.demo_speed_level model-level tests.
// Mirrors tests/letterAttemptSupportLevelModel.test.js's exact convention
// and rationale — sequelize.define()/instance.validate() both run without a
// live DB connection, so none of these tests touch the real database or
// create a row.
const { LetterAttempt } = require('../src/models');
const { VALID_DEMO_SPEED_LEVELS } = require('../src/config/demoSpeedPolicy');

function validRecord(overrides = {}) {
  return {
    student_id:     13,
    letter:         'c',
    case_type:      'lowercase',
    session_key:    'session-1',
    attempt_number: 1,
    passed:         true,
    ...overrides,
  };
}

// ─── Model Test 1 — column exists ──────────────────────────────────────────

describe('Model Test 1 — demo_speed_level column exists', () => {
  it('is registered as a rawAttribute on LetterAttempt', () => {
    expect(LetterAttempt.rawAttributes).toHaveProperty('demo_speed_level');
  });
});

// ─── Model Test 2 — nullable ────────────────────────────────────────────────

describe('Model Test 2 — demo_speed_level is nullable', () => {
  it('allows null explicitly', async () => {
    const instance = LetterAttempt.build(validRecord({ demo_speed_level: null }));
    await expect(instance.validate()).resolves.toBeDefined();
  });

  it('allows undefined (field omitted entirely)', async () => {
    const record = validRecord();
    delete record.demo_speed_level;
    const instance = LetterAttempt.build(record);
    await expect(instance.validate()).resolves.toBeDefined();
  });

  it('the column definition itself declares allowNull: true', () => {
    expect(LetterAttempt.rawAttributes.demo_speed_level.allowNull).toBe(true);
  });
});

// ─── Model Test 3/4 — each vocabulary value accepted ───────────────────────

describe.each(VALID_DEMO_SPEED_LEVELS)('Model Test — %s is accepted', (level) => {
  it(`accepts demo_speed_level = '${level}'`, async () => {
    const instance = LetterAttempt.build(validRecord({ demo_speed_level: level }));
    await expect(instance.validate()).resolves.toBeDefined();
  });
});

// ─── Model Test 5 — invalid string rejected ────────────────────────────────

describe('Model Test 5 — invalid string is rejected at model validation layer', () => {
  it.each(['fast', 'STANDARD', 'Slow', 'medium', 'none', ''])(
    'rejects demo_speed_level = %j',
    async (badValue) => {
      const instance = LetterAttempt.build(validRecord({ demo_speed_level: badValue }));
      await expect(instance.validate()).rejects.toThrow();
    }
  );
});

// ─── Model Test 6 — null explicitly accepted (distinct from Test 2's broader nullable check) ─

describe('Model Test 6 — null is explicitly a valid value, not merely tolerated', () => {
  it('validate() resolves and the built instance actually carries null (not coerced to a string)', async () => {
    const instance = LetterAttempt.build(validRecord({ demo_speed_level: null }));
    await instance.validate();
    expect(instance.demo_speed_level).toBeNull();
  });
});

// ─── Model Test 7 — no historical/backfill requirement enforced ───────────

describe('Model Test 7 — no historical backfill requirement', () => {
  it('a record with no demo_speed_level at all remains a fully valid LetterAttempt (mirrors an existing pre-Step-5 historical row)', async () => {
    const record = validRecord(); // no demo_speed_level key present at all
    const instance = LetterAttempt.build(record);
    await expect(instance.validate()).resolves.toBeDefined();
    expect(instance.demo_speed_level == null).toBe(true);
  });
});

// ─── Vocabulary shape ───────────────────────────────────────────────────────

describe('Model Test — VALID_DEMO_SPEED_LEVELS vocabulary shape', () => {
  it('is exactly the two lowercase values — no fast, no medium', () => {
    expect([...VALID_DEMO_SPEED_LEVELS].sort()).toEqual(['slow', 'standard']);
  });

  it('the model validator references the same shared constant (not a second hardcoded copy)', () => {
    expect(LetterAttempt.rawAttributes.demo_speed_level.validate.isIn[0]).toBe(VALID_DEMO_SPEED_LEVELS);
  });
});

// ─── Independence from support_level ────────────────────────────────────────

describe('demo_speed_level and support_level are fully independent columns', () => {
  it('a row can have support_level=medium and demo_speed_level=null simultaneously (the expected MEDIUM-support shape)', async () => {
    const instance = LetterAttempt.build(validRecord({ support_level: 'medium', demo_speed_level: null }));
    await expect(instance.validate()).resolves.toBeDefined();
  });

  it('a row can have support_level=high and demo_speed_level=slow simultaneously (the expected HIGH+slow-tracer shape)', async () => {
    const instance = LetterAttempt.build(validRecord({ support_level: 'high', demo_speed_level: 'slow' }));
    await expect(instance.validate()).resolves.toBeDefined();
  });
});
