'use strict';

// Feature 7 Step 2 — persistentDifficultyPolicy.js tests (pure config, no I/O).
const {
  PERSISTENT_DIFFICULTY_STATUSES, isValidPersistentDifficultyStatus,
  PERSISTENT_DIFFICULTY_REASONS, isValidPersistentDifficultyReason,
  WINDOW_SIZE, REQUIRED_WINDOW_COUNT, MIN_USABLE_CYCLES,
  DIFFICULTY_MAX_SUCCESSFUL_CYCLES, MIN_WINDOW_SEPARATION_MS,
} = require('../src/config/persistentDifficultyPolicy');

// ─── Test 1 — exactly three statuses ────────────────────────────────────────

describe('Test 1 — exactly three statuses', () => {
  it('PERSISTENT_DIFFICULTY_STATUSES contains exactly insufficient_data/not_persistent/persistent', () => {
    expect(Object.values(PERSISTENT_DIFFICULTY_STATUSES).sort()).toEqual(
      ['insufficient_data', 'not_persistent', 'persistent'].sort()
    );
  });

  it('no severity or emerging tiers exist', () => {
    const values = Object.values(PERSISTENT_DIFFICULTY_STATUSES);
    for (const forbidden of ['mild', 'moderate', 'severe', 'emerging_difficulty', 'emerging', 'high_risk', 'resolved']) {
      expect(values).not.toContain(forbidden);
    }
  });

  it('isValidPersistentDifficultyStatus accepts exactly the three values', () => {
    expect(isValidPersistentDifficultyStatus('insufficient_data')).toBe(true);
    expect(isValidPersistentDifficultyStatus('not_persistent')).toBe(true);
    expect(isValidPersistentDifficultyStatus('persistent')).toBe(true);
  });

  it.each(['emerging', 'severe', 'PERSISTENT', '', null, undefined, 42])(
    'isValidPersistentDifficultyStatus(%p) is false', (bad) => {
      expect(() => isValidPersistentDifficultyStatus(bad)).not.toThrow();
      expect(isValidPersistentDifficultyStatus(bad)).toBe(false);
    }
  );
});

// ─── Test 2 — exactly configured reasons ───────────────────────────────────

describe('Test 2 — exactly configured reasons', () => {
  it('PERSISTENT_DIFFICULTY_REASONS contains exactly the six documented values', () => {
    expect(Object.values(PERSISTENT_DIFFICULTY_REASONS).sort()).toEqual([
      'insufficient_cycles', 'insufficient_temporal_dispersion',
      'repeated_difficulty_across_windows',
      'recent_difficulty_not_yet_persistent', 'recent_improvement', 'no_persistent_difficulty',
    ].sort());
  });

  it('no demo_speed_reason-style provenance field is introduced (reason stays separate from status)', () => {
    expect(PERSISTENT_DIFFICULTY_REASONS).not.toHaveProperty('demo_speed_reason');
    expect(Object.keys(PERSISTENT_DIFFICULTY_STATUSES)).not.toEqual(
      expect.arrayContaining(Object.keys(PERSISTENT_DIFFICULTY_REASONS))
    );
  });

  it('isValidPersistentDifficultyReason accepts every documented reason', () => {
    for (const reason of Object.values(PERSISTENT_DIFFICULTY_REASONS)) {
      expect(isValidPersistentDifficultyReason(reason)).toBe(true);
    }
  });

  it('isValidPersistentDifficultyReason rejects garbage', () => {
    expect(isValidPersistentDifficultyReason('made_up_reason')).toBe(false);
  });
});

// ─── Test 3 — window size = 5 ───────────────────────────────────────────────

describe('Test 3 — window size = 5', () => {
  it('WINDOW_SIZE === 5, reusing Feature 2/3\'s own precedent', () => {
    expect(WINDOW_SIZE).toBe(5);
  });
});

// ─── Test 4 — two windows required ──────────────────────────────────────────

describe('Test 4 — two windows required', () => {
  it('REQUIRED_WINDOW_COUNT === 2', () => {
    expect(REQUIRED_WINDOW_COUNT).toBe(2);
  });
});

// ─── Test 5 — minimum usable cycles = 10 ───────────────────────────────────

describe('Test 5 — minimum usable cycles = 10', () => {
  it('MIN_USABLE_CYCLES === WINDOW_SIZE * REQUIRED_WINDOW_COUNT === 10, never a second hardcoded literal', () => {
    expect(MIN_USABLE_CYCLES).toBe(10);
    expect(MIN_USABLE_CYCLES).toBe(WINDOW_SIZE * REQUIRED_WINDOW_COUNT);
  });
});

// ─── Test 6 — temporal separation configured centrally ─────────────────────

describe('Test 6 — temporal separation configured centrally', () => {
  it('MIN_WINDOW_SEPARATION_MS === exactly 24 hours in milliseconds', () => {
    expect(MIN_WINDOW_SEPARATION_MS).toBe(24 * 60 * 60 * 1000);
    expect(MIN_WINDOW_SEPARATION_MS).toBe(86400000);
  });
});

// ─── Test 7 — no severity vocabulary anywhere in the file ──────────────────

describe('Test 7 — no severity vocabulary anywhere in the policy file', () => {
  it('the source (comment-stripped) never references clinical severity language as a value', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/config/persistentDifficultyPolicy.js'), 'utf8');
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/['"](mild|moderate|severe|high_risk|motor_disorder)['"]/);
  });
});

// ─── Test 8 — no timing triggers ───────────────────────────────────────────

describe('Test 8 — no timing triggers referenced in policy', () => {
  it('the policy file never references raw timing metrics', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/config/persistentDifficultyPolicy.js'), 'utf8');
    expect(source).not.toMatch(/attempt_duration_ms|attempt_avg_speed|pause_frequency|pause_duration_ratio/);
  });
});

// ─── Test 9 — no blocked_attempts referenced ───────────────────────────────

describe('Test 9 — no blocked_attempts referenced in policy', () => {
  it('the policy file never references blocked_attempts', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/config/persistentDifficultyPolicy.js'), 'utf8');
    expect(source).not.toMatch(/blocked_attempts/);
  });
});

// ─── Test 10 — collection excluded (documented, enforced in the evidence file) ─

describe('Test 10 — collection-exclusion policy is documented', () => {
  it('the policy header documents collection-mode exclusion (enforcement itself lives in persistentDifficultyEvidence.js, tested separately)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/config/persistentDifficultyPolicy.js'), 'utf8');
    // The policy file itself carries no query logic — this just confirms it
    // doesn't accidentally define a competing/contradictory collection rule.
    expect(source).not.toMatch(/collection_mode:\s*true/);
  });
});

// ─── DIFFICULTY_MAX_SUCCESSFUL_CYCLES — used by evaluateDifficultyWindow ──

describe('DIFFICULTY_MAX_SUCCESSFUL_CYCLES', () => {
  it('is exactly 1, mirroring Feature 2\'s own "0 or 1 of 5" support_review bar', () => {
    expect(DIFFICULTY_MAX_SUCCESSFUL_CYCLES).toBe(1);
  });
});

// ─── Endpoint wiring (Feature 7 Step 3 UPDATE) ─────────────────────────────
//
// This Step 2 file originally asserted "no controller/route references
// persistentDifficulty" — that guarantee was intentionally retired in
// Step 3, which adds the actual read-only GET /handwriting/persistent-
// difficulty/:studentId endpoint per its own explicit scope. See
// tests/getPersistentDifficultyEndpoint.test.js for the full endpoint test
// suite. No frontend file references it yet — that remains out of scope
// until a future step explicitly adds a teacher-facing surface.

describe('Wired into the read-only endpoint as of Step 3; still no frontend', () => {
  it('the controller and route now reference the persistent-difficulty endpoint', () => {
    const fs = require('fs');
    const path = require('path');
    for (const file of ['../src/controllers/handwritingController.js', '../src/routes/handwriting.js']) {
      const source = fs.readFileSync(path.resolve(__dirname, file), 'utf8');
      expect(source).toMatch(/persistentDifficulty/i);
    }
  });
});
