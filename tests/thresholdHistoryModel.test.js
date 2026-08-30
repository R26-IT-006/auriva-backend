'use strict';

// Verifies the ThresholdHistory model's shape and field-level validation
// entirely offline — sequelize.define() and instance.validate() both run
// without a live DB connection (confirmed in Feature 1 Step 1), so none of
// these tests touch the real database. No row is ever created.
const { ThresholdHistory } = require('../src/models');

function validRecord(overrides = {}) {
  return {
    student_id:    13,
    scope_type:    'family',
    scope_key:     'curved',
    baseline_family: 'curved',
    old_threshold: 51,
    new_threshold: 56,
    source:        'automatic',
    reason:        '4_of_5_met_target',
    baseline_id:   1,
    baseline_version: 'baseline-v1',
    mapping_version:  'letter-baseline-family-v1',
    recent_window_snapshot: { scores: [58, 55, 57, 54, 59], metTarget: [true, true, true, false, true], windowSize: 5 },
    ...overrides,
  };
}

// ─── History Test 1 — model loads correctly ────────────────────────────────

describe('History Test 1 — model loads correctly', () => {
  it('is registered with the expected table name and fields', () => {
    expect(ThresholdHistory).toBeDefined();
    expect(ThresholdHistory.getTableName()).toBe('student_threshold_history');
    expect(Object.keys(ThresholdHistory.rawAttributes)).toEqual(expect.arrayContaining([
      'id', 'student_id', 'scope_type', 'scope_key', 'baseline_family',
      'old_threshold', 'new_threshold', 'source', 'reason',
      'baseline_id', 'baseline_version', 'mapping_version',
      'recent_window_snapshot', 'created_at',
    ]));
  });
});

// ─── History Test 2 — required fields enforced ─────────────────────────────

describe('History Test 2 — required fields enforced', () => {
  it.each(['student_id', 'scope_type', 'scope_key', 'new_threshold', 'source', 'reason'])(
    'rejects a record missing %s',
    async (field) => {
      const record = validRecord();
      delete record[field];
      const instance = ThresholdHistory.build(record);
      await expect(instance.validate()).rejects.toThrow();
    }
  );

  it('accepts a fully valid record', async () => {
    const instance = ThresholdHistory.build(validRecord());
    await expect(instance.validate()).resolves.toBeDefined();
  });
});

// ─── History Test 3 — source vocabulary ────────────────────────────────────

describe('History Test 3 — source accepts only allowed vocabulary', () => {
  it('rejects an unrecognized source value', async () => {
    const instance = ThresholdHistory.build(validRecord({ source: 'made_up_source' }));
    await expect(instance.validate()).rejects.toThrow();
  });

  it.each(['initial_from_baseline', 'automatic', 'teacher_override', 'legacy'])(
    'accepts %s',
    async (source) => {
      const instance = ThresholdHistory.build(validRecord({ source }));
      await expect(instance.validate()).resolves.toBeDefined();
    }
  );

  it('rejects an unrecognized baseline_family value when set', async () => {
    const instance = ThresholdHistory.build(validRecord({ baseline_family: 'mixed' }));
    await expect(instance.validate()).rejects.toThrow();
  });

  it('rejects an unrecognized scope_type value', async () => {
    const instance = ThresholdHistory.build(validRecord({ scope_type: 'bogus' }));
    await expect(instance.validate()).rejects.toThrow();
  });
});

// ─── History Test 4 — no updated_at ────────────────────────────────────────

describe('History Test 4 — no updated_at', () => {
  it('has timestamps disabled and no updated_at attribute', () => {
    expect(ThresholdHistory.options.timestamps).toBe(false);
    expect('updated_at' in ThresholdHistory.rawAttributes).toBe(false);
    expect('updatedAt' in ThresholdHistory.rawAttributes).toBe(false);
  });
});

// ─── History Test 5 — recent_window_snapshot accepts JSON ─────────────────

describe('History Test 5 — recent_window_snapshot accepts JSON', () => {
  it('accepts an arbitrary JSON-shaped object', async () => {
    const snapshot = { scores: [58, 55, 57, 54, 59], metTarget: [true, false, true, false, true], windowSize: 5 };
    const instance = ThresholdHistory.build(validRecord({ recent_window_snapshot: snapshot }));
    await expect(instance.validate()).resolves.toBeDefined();
    expect(instance.recent_window_snapshot).toEqual(snapshot);
  });

  it('is nullable', async () => {
    const instance = ThresholdHistory.build(validRecord({ recent_window_snapshot: null }));
    await expect(instance.validate()).resolves.toBeDefined();
  });
});

// ─── History Test 6 — initial event ────────────────────────────────────────

describe('History Test 6 — initial event (old_threshold null)', () => {
  it('accepts old_threshold=null with source=initial_from_baseline', async () => {
    const instance = ThresholdHistory.build(validRecord({
      old_threshold: null,
      new_threshold: 51,
      source: 'initial_from_baseline',
      reason: 'baseline_plus_margin',
    }));
    await expect(instance.validate()).resolves.toBeDefined();
    expect(instance.old_threshold).toBeNull();
  });
});

// ─── History Test 7 — automatic event ──────────────────────────────────────

describe('History Test 7 — automatic event', () => {
  it('accepts old_threshold=51, new_threshold=56, source=automatic', async () => {
    const instance = ThresholdHistory.build(validRecord({
      old_threshold: 51,
      new_threshold: 56,
      source: 'automatic',
      reason: '4_of_5_met_target',
    }));
    await expect(instance.validate()).resolves.toBeDefined();
    expect(instance.old_threshold).toBe(51);
    expect(instance.new_threshold).toBe(56);
  });
});

// ─── History Test 8 — mapping/baseline versions persist ───────────────────

describe('History Test 8 — mapping/baseline versions persist', () => {
  it('retains baseline_version and mapping_version as set attributes', async () => {
    const instance = ThresholdHistory.build(validRecord({
      baseline_version: 'baseline-v1',
      mapping_version:  'letter-baseline-family-v1',
    }));
    await instance.validate();
    expect(instance.get('baseline_version')).toBe('baseline-v1');
    expect(instance.get('mapping_version')).toBe('letter-baseline-family-v1');
  });

  it('both are nullable for events that are not baseline/mapping-derived (e.g. teacher_override)', async () => {
    const instance = ThresholdHistory.build(validRecord({
      source: 'teacher_override',
      reason: 'teacher_override',
      baseline_id: null,
      baseline_version: null,
      mapping_version: null,
    }));
    await expect(instance.validate()).resolves.toBeDefined();
  });
});

// ─── Section 31 (Step 6B) — evidence_fingerprint column ────────────────────
// See migrations/20260808000003-add-evidence-fingerprint-to-threshold-history.js
// for the live migration; this offline model-level coverage verifies the
// Sequelize model matches that migration exactly. Live DB verification
// (column exists/nullable, partial unique index definition, row count
// unaffected) was performed directly against the real Azure Postgres
// instance — see Step 6B report Section 9, not repeated here as an offline
// test since a real index/constraint cannot be proven without a live DB.

describe('History Test 9 — evidence_fingerprint is present and nullable', () => {
  it('is a declared model attribute', () => {
    expect('evidence_fingerprint' in ThresholdHistory.rawAttributes).toBe(true);
  });

  it('is nullable — every pre-Step-6B source (initial_from_baseline, teacher_override) omits it', async () => {
    const instance = ThresholdHistory.build(validRecord({ source: 'initial_from_baseline', evidence_fingerprint: null }));
    await expect(instance.validate()).resolves.toBeDefined();
    expect(instance.evidence_fingerprint).toBeNull();
  });

  it('accepts a 64-char sha256 hex digest for an automatic event', async () => {
    const fingerprint = 'a'.repeat(64);
    const instance = ThresholdHistory.build(validRecord({ source: 'automatic', reason: '4_or_5_met_target', evidence_fingerprint: fingerprint }));
    await expect(instance.validate()).resolves.toBeDefined();
    expect(instance.evidence_fingerprint).toBe(fingerprint);
  });

  it('existing pre-Step-6B fixture records (built without evidence_fingerprint at all) still validate — no backfill required', async () => {
    const instance = ThresholdHistory.build(validRecord()); // validRecord() never sets evidence_fingerprint
    await expect(instance.validate()).resolves.toBeDefined();
    expect(instance.evidence_fingerprint).toBeUndefined();
  });
});
