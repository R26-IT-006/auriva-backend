'use strict';

// Feature 6 Step 2 — demoSpeedPolicy.js tests (pure config, no I/O).
// No recommendation logic exists yet — these tests only prove the
// vocabulary/trust-model contract itself.

const {
  DEMO_SPEED_LEVELS, VALID_DEMO_SPEED_LEVELS, DEFAULT_DEMO_SPEED_LEVEL, isValidDemoSpeedLevel,
  DEMO_SPEED_REASONS, APPROVED_MVP_TRIGGER_SIGNALS, COLLECTION_DEMO_SPEED_LEVEL,
  MVP_TIMING_SIGNALS_ENABLED, TIMING_SIGNAL_TRUST,
} = require('../src/config/demoSpeedPolicy');

// ─── Test 1/2 — vocabulary is exactly {standard, slow}, no fast ───────────

describe('Test 1 — vocabulary contains exactly standard and slow', () => {
  it('DEMO_SPEED_LEVELS has exactly two values', () => {
    expect(Object.values(DEMO_SPEED_LEVELS).sort()).toEqual(['slow', 'standard']);
  });

  it('VALID_DEMO_SPEED_LEVELS mirrors DEMO_SPEED_LEVELS exactly', () => {
    expect([...VALID_DEMO_SPEED_LEVELS].sort()).toEqual(['slow', 'standard']);
  });
});

describe('Test 2 — no fast (or any third level) exists anywhere in the vocabulary', () => {
  it.each(['fast', 'very_slow', 'medium', 'FAST', 'Fast'])('%p is not a value in DEMO_SPEED_LEVELS', (candidate) => {
    expect(Object.values(DEMO_SPEED_LEVELS)).not.toContain(candidate);
  });
});

// ─── Test 3/4/5 — isValidDemoSpeedLevel ─────────────────────────────────────

describe('Test 3 — valid standard', () => {
  it('isValidDemoSpeedLevel("standard") is true', () => {
    expect(isValidDemoSpeedLevel('standard')).toBe(true);
  });
});

describe('Test 4 — valid slow', () => {
  it('isValidDemoSpeedLevel("slow") is true', () => {
    expect(isValidDemoSpeedLevel('slow')).toBe(true);
  });
});

describe('Test 5 — invalid strings/values rejected', () => {
  it.each(['fast', 'very_slow', 'medium', '0.5', '0.21', '', 'STANDARD', 'Slow', null, undefined, 0.75, true, {}])(
    '%p is never a valid demo speed level',
    (candidate) => {
      expect(() => isValidDemoSpeedLevel(candidate)).not.toThrow();
      expect(isValidDemoSpeedLevel(candidate)).toBe(false);
    }
  );
});

// ─── Test 6 — immutability ──────────────────────────────────────────────────

describe('Test 6 — policy objects are immutable', () => {
  it('DEMO_SPEED_LEVELS, VALID_DEMO_SPEED_LEVELS, DEMO_SPEED_REASONS, APPROVED_MVP_TRIGGER_SIGNALS, TIMING_SIGNAL_TRUST are all frozen', () => {
    expect(Object.isFrozen(DEMO_SPEED_LEVELS)).toBe(true);
    expect(Object.isFrozen(VALID_DEMO_SPEED_LEVELS)).toBe(true);
    expect(Object.isFrozen(DEMO_SPEED_REASONS)).toBe(true);
    expect(Object.isFrozen(APPROVED_MVP_TRIGGER_SIGNALS)).toBe(true);
    expect(Object.isFrozen(TIMING_SIGNAL_TRUST)).toBe(true);
    expect(Object.isFrozen(TIMING_SIGNAL_TRUST.attempt_duration_ms)).toBe(true);
  });

  it('attempting to mutate DEMO_SPEED_LEVELS never changes its value (throws in this file\'s own strict-mode scope; a frozen object always ignores the write regardless)', () => {
    try { DEMO_SPEED_LEVELS.STANDARD = 'mutated'; } catch { /* expected under 'use strict' */ }
    expect(DEMO_SPEED_LEVELS.STANDARD).toBe('standard');
  });
});

// ─── Test 7 — default level ─────────────────────────────────────────────────

describe('Test 7 — default level is standard', () => {
  it('DEFAULT_DEMO_SPEED_LEVEL === DEMO_SPEED_LEVELS.STANDARD', () => {
    expect(DEFAULT_DEMO_SPEED_LEVEL).toBe(DEMO_SPEED_LEVELS.STANDARD);
  });
});

// ─── Test 8 — Feature 2/3 signal constants explicit ────────────────────────

describe('Test 8 — Feature 2/3 signal reason constants are explicit', () => {
  it('DEMO_SPEED_REASONS names both feature2_support_review and feature3_support_review exactly', () => {
    expect(DEMO_SPEED_REASONS.FEATURE2_SUPPORT_REVIEW).toBe('feature2_support_review');
    expect(DEMO_SPEED_REASONS.FEATURE3_SUPPORT_REVIEW).toBe('feature3_support_review');
  });

  it('APPROVED_MVP_TRIGGER_SIGNALS contains exactly these two reasons, Feature 3 listed with priority (first)', () => {
    expect(APPROVED_MVP_TRIGGER_SIGNALS).toEqual([
      'feature3_support_review', 'feature2_support_review',
    ]);
  });

  it('every other reason value is a real, non-empty string', () => {
    for (const value of Object.values(DEMO_SPEED_REASONS)) {
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(0);
    }
  });
});

// ─── Test 9 — no timing metric is an approved MVP trigger ─────────────────

describe('Test 9 — no timing metric appears as an approved MVP trigger', () => {
  it('MVP_TIMING_SIGNALS_ENABLED is false', () => {
    expect(MVP_TIMING_SIGNALS_ENABLED).toBe(false);
  });

  it('every entry in TIMING_SIGNAL_TRUST has approvedMvpTrigger: false', () => {
    for (const [name, entry] of Object.entries(TIMING_SIGNAL_TRUST)) {
      expect(entry.approvedMvpTrigger).toBe(false);
    }
  });

  it('TIMING_SIGNAL_TRUST covers every timing feature the Step 1 audit inventoried', () => {
    expect(Object.keys(TIMING_SIGNAL_TRUST).sort()).toEqual([
      'attempt_avg_speed', 'attempt_duration_ms', 'attempt_pause_duration_ratio',
      'attempt_pause_frequency', 'features.duration_ms',
    ].sort());
  });

  it('APPROVED_MVP_TRIGGER_SIGNALS contains none of the timing signal names — only Feature 2/3 reasons', () => {
    const timingNames = Object.keys(TIMING_SIGNAL_TRUST);
    for (const trigger of APPROVED_MVP_TRIGGER_SIGNALS) {
      expect(timingNames).not.toContain(trigger);
    }
  });

  it('the legacy features.duration_ms entry is explicitly NOT_APPROVED (stronger than merely unapproved-for-MVP)', () => {
    expect(TIMING_SIGNAL_TRUST['features.duration_ms'].trust).toBe('NOT_APPROVED');
  });

  it('attempt_duration_ms/attempt_avg_speed/pause metrics are MEASUREMENT_TRUSTED (reliable to measure) yet still not approved triggers', () => {
    expect(TIMING_SIGNAL_TRUST.attempt_duration_ms.trust).toBe('MEASUREMENT_TRUSTED');
    expect(TIMING_SIGNAL_TRUST.attempt_avg_speed.trust).toBe('MEASUREMENT_TRUSTED');
    expect(TIMING_SIGNAL_TRUST.attempt_pause_frequency.trust).toBe('MEASUREMENT_TRUSTED');
    expect(TIMING_SIGNAL_TRUST.attempt_pause_duration_ratio.trust).toBe('MEASUREMENT_TRUSTED');
  });
});

// ─── Test 10 — collection policy ────────────────────────────────────────────

describe('Test 10 — collection policy is standard/non-adaptive', () => {
  it('COLLECTION_DEMO_SPEED_LEVEL === DEMO_SPEED_LEVELS.STANDARD, always, no adaptive override possible', () => {
    expect(COLLECTION_DEMO_SPEED_LEVEL).toBe(DEMO_SPEED_LEVELS.STANDARD);
  });
});

// ─── Read-only / no-side-effect sanity (this is a pure config module) ─────

describe('Module purity', () => {
  it('requiring this module performs no I/O — no fs/net/db references in the source', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/config/demoSpeedPolicy.js'), 'utf8');
    const importLines = source.split('\n').filter(line => /require\(/.test(line));
    expect(importLines).toHaveLength(0); // zero requires at all — pure constants only
  });
});
