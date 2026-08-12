'use strict';

// Feature 3 Step 4 — resolveAttemptSupportLevel() pure-function tests.
// No mocking needed — this function touches no model/DB/service.
const { resolveAttemptSupportLevel, SUPPORT_SOURCE } = require('../src/utils/attemptSupportResolution');

function row(overrides = {}) {
  return {
    support_level: null,
    attempt_number: 1,
    collection_mode: false,
    ...overrides,
  };
}

// ─── Resolver Test 1/2/3 — explicit support resolves as-is ────────────────

describe('Resolver Test 1 — explicit high resolves high', () => {
  it('resolves support_level=high with source=explicit_support_level', () => {
    const result = resolveAttemptSupportLevel(row({ support_level: 'high', attempt_number: 1 }));
    expect(result).toEqual({ status: 'resolved', supportLevel: 'high', source: SUPPORT_SOURCE.EXPLICIT });
  });
});

describe('Resolver Test 2 — explicit medium resolves medium', () => {
  it('resolves support_level=medium with source=explicit_support_level', () => {
    const result = resolveAttemptSupportLevel(row({ support_level: 'medium', attempt_number: 2 }));
    expect(result).toEqual({ status: 'resolved', supportLevel: 'medium', source: SUPPORT_SOURCE.EXPLICIT });
  });
});

describe('Resolver Test 3 — explicit low resolves low', () => {
  it('resolves support_level=low with source=explicit_support_level', () => {
    const result = resolveAttemptSupportLevel(row({ support_level: 'low', attempt_number: 3 }));
    expect(result).toEqual({ status: 'resolved', supportLevel: 'low', source: SUPPORT_SOURCE.EXPLICIT });
  });
});

// ─── Resolver Test 4 — explicit overrides attempt-number proxy ────────────

describe('Resolver Test 4 — explicit support overrides attempt-number proxy', () => {
  it('attempt_number=1 with support_level=medium resolves medium, NOT high (future-proofing for adaptive support)', () => {
    const result = resolveAttemptSupportLevel(row({ support_level: 'medium', attempt_number: 1 }));
    expect(result.supportLevel).toBe('medium');
    expect(result.supportLevel).not.toBe('high');
    expect(result.source).toBe(SUPPORT_SOURCE.EXPLICIT);
  });

  it('attempt_number=3 with support_level=high resolves high, NOT low', () => {
    const result = resolveAttemptSupportLevel(row({ support_level: 'high', attempt_number: 3 }));
    expect(result.supportLevel).toBe('high');
    expect(result.source).toBe(SUPPORT_SOURCE.EXPLICIT);
  });
});

// ─── Resolver Test 5/6/7 — missing support falls back to attempt proxy ────

describe('Resolver Test 5 — missing support + normal attempt 1 → high proxy', () => {
  it('resolves high with source=historical_attempt_proxy', () => {
    const result = resolveAttemptSupportLevel(row({ support_level: null, attempt_number: 1, collection_mode: false }));
    expect(result).toEqual({ status: 'resolved', supportLevel: 'high', source: SUPPORT_SOURCE.HISTORICAL_PROXY });
  });
});

describe('Resolver Test 6 — missing support + normal attempt 2 → medium proxy', () => {
  it('resolves medium with source=historical_attempt_proxy', () => {
    const result = resolveAttemptSupportLevel(row({ support_level: null, attempt_number: 2, collection_mode: false }));
    expect(result).toEqual({ status: 'resolved', supportLevel: 'medium', source: SUPPORT_SOURCE.HISTORICAL_PROXY });
  });
});

describe('Resolver Test 7 — missing support + normal attempt 3 → low proxy', () => {
  it('resolves low with source=historical_attempt_proxy', () => {
    const result = resolveAttemptSupportLevel(row({ support_level: null, attempt_number: 3, collection_mode: false }));
    expect(result).toEqual({ status: 'resolved', supportLevel: 'low', source: SUPPORT_SOURCE.HISTORICAL_PROXY });
  });
});

describe('Resolver Test — undefined support_level (field absent entirely) behaves identically to null', () => {
  it('falls back to the attempt proxy', () => {
    const result = resolveAttemptSupportLevel({ attempt_number: 2, collection_mode: false });
    expect(result).toEqual({ status: 'resolved', supportLevel: 'medium', source: SUPPORT_SOURCE.HISTORICAL_PROXY });
  });
});

// ─── Resolver Test 8 — invalid explicit value is unresolvable ─────────────

describe('Resolver Test 8 — invalid explicit value → invalid/unresolvable', () => {
  it.each(['extreme', 'HIGH', 'Medium', '', 1, true])(
    'never falls back to the attempt proxy for an invalid explicit value %j — even when attempt_number would otherwise resolve cleanly',
    (badValue) => {
      const result = resolveAttemptSupportLevel(row({ support_level: badValue, attempt_number: 1 }));
      expect(result.status).toBe('invalid');
      expect(result.supportLevel).toBeNull();
      expect(result.reason).toBe('unresolvable_support');
    }
  );
});

// ─── Resolver Test 9 — invalid attempt number fallback → invalid ──────────

describe('Resolver Test 9 — invalid attempt number fallback → invalid', () => {
  it.each([0, 4, -1, null, undefined, '1', 1.5, NaN])(
    'no explicit support + attempt_number=%j resolves to invalid, never a guessed value',
    (badAttempt) => {
      const result = resolveAttemptSupportLevel(row({ support_level: null, attempt_number: badAttempt, collection_mode: false }));
      expect(result).toEqual({ status: 'invalid', supportLevel: null, reason: 'unresolvable_support' });
    }
  );
});

// ─── Resolver Test 10 — collection row never proxy-resolved ───────────────

describe('Resolver Test 10 — collection row never resolved through the historical proxy', () => {
  it('a collection-mode row with no explicit support_level is unresolvable, even with a clean attempt_number=1/2/3', () => {
    for (const attemptNumber of [1, 2, 3]) {
      const result = resolveAttemptSupportLevel(row({ support_level: null, attempt_number: attemptNumber, collection_mode: true }));
      expect(result).toEqual({ status: 'invalid', supportLevel: null, reason: 'unresolvable_support' });
    }
  });

  it('a collection-mode row WITH a valid explicit support_level still resolves normally — only the fallback proxy is collection-restricted', () => {
    const result = resolveAttemptSupportLevel(row({ support_level: 'low', attempt_number: 3, collection_mode: true }));
    expect(result).toEqual({ status: 'resolved', supportLevel: 'low', source: SUPPORT_SOURCE.EXPLICIT });
  });
});
