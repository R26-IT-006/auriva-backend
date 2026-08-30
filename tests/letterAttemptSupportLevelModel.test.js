'use strict';

// Feature 3 Step 3 — LetterAttempt.support_level model-level tests.
// Follows the same offline pattern as tests/thresholdHistoryModel.test.js:
// sequelize.define()/instance.validate() both run without a live DB
// connection, so none of these tests touch the real database or create a
// row. Empirically confirmed (no explicit `isUUID` validator on
// session_key) that a plain non-UUID string is accepted by .validate() —
// same convention this test file uses for session_key as
// tests/dynamicThresholdService.test.js's own fixtures.
const { LetterAttempt } = require('../src/models');
const { LETTER_SUPPORT_LEVELS } = require('../src/config/letterSupportLevels');

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

describe('Model Test 1 — support_level column exists', () => {
  it('is registered as a rawAttribute on LetterAttempt', () => {
    expect(LetterAttempt.rawAttributes).toHaveProperty('support_level');
  });
});

// ─── Model Test 2 — nullable ────────────────────────────────────────────────

describe('Model Test 2 — support_level is nullable', () => {
  it('allows null explicitly', async () => {
    const instance = LetterAttempt.build(validRecord({ support_level: null }));
    await expect(instance.validate()).resolves.toBeDefined();
  });

  it('allows undefined (field omitted entirely)', async () => {
    const record = validRecord();
    delete record.support_level;
    const instance = LetterAttempt.build(record);
    await expect(instance.validate()).resolves.toBeDefined();
  });

  it('the column definition itself declares allowNull: true', () => {
    expect(LetterAttempt.rawAttributes.support_level.allowNull).toBe(true);
  });
});

// ─── Model Test 3/4/5 — each vocabulary value accepted ─────────────────────

describe.each(LETTER_SUPPORT_LEVELS)('Model Test — %s is accepted', (level) => {
  it(`accepts support_level = '${level}'`, async () => {
    const instance = LetterAttempt.build(validRecord({ support_level: level }));
    await expect(instance.validate()).resolves.toBeDefined();
  });
});

// ─── Model Test 6 — invalid string rejected ────────────────────────────────

describe('Model Test 6 — invalid string is rejected at model validation layer', () => {
  it.each(['extreme', 'HIGH', 'Medium', 'LOW', 'none', ''])(
    'rejects support_level = %j',
    async (badValue) => {
      const instance = LetterAttempt.build(validRecord({ support_level: badValue }));
      await expect(instance.validate()).rejects.toThrow();
    }
  );
});

// ─── Model Test 7 — null explicitly accepted (distinct from Test 2's broader nullable check) ─

describe('Model Test 7 — null is explicitly a valid value, not merely tolerated', () => {
  it('validate() resolves and the built instance actually carries null (not coerced to a string)', async () => {
    const instance = LetterAttempt.build(validRecord({ support_level: null }));
    await instance.validate();
    expect(instance.support_level).toBeNull();
  });
});

// ─── Model Test 8 — no historical/backfill requirement enforced ───────────

describe('Model Test 8 — no historical backfill requirement', () => {
  it('a record with no support_level at all remains a fully valid LetterAttempt (mirrors an existing pre-Step-3 historical row)', async () => {
    const record = validRecord(); // no support_level key present at all
    const instance = LetterAttempt.build(record);
    await expect(instance.validate()).resolves.toBeDefined();
    expect(instance.support_level == null).toBe(true);
  });
});

// ─── Vocabulary shape ───────────────────────────────────────────────────────

describe('Model Test — LETTER_SUPPORT_LEVELS vocabulary shape', () => {
  it('is exactly the three lowercase, descriptive values', () => {
    expect([...LETTER_SUPPORT_LEVELS].sort()).toEqual(['high', 'low', 'medium']);
  });

  it('the model validator references the same shared constant (not a second hardcoded copy)', () => {
    expect(LetterAttempt.rawAttributes.support_level.validate.isIn[0]).toBe(LETTER_SUPPORT_LEVELS);
  });
});
