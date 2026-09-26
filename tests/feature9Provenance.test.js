'use strict';

// Feature 9 Step 2 — provenance fingerprint + policy-version tests.
// Mirrors every prior feature's own Step 2 policy-test discipline
// (persistentDifficultyPolicy.test.js, worksheetRecommendationPolicy.test.js):
// pure constants + pure helpers only, no mocks needed anywhere in this file.

const fs = require('fs');
const path = require('path');

const {
  PERSISTENT_DIFFICULTY_POLICY_VERSION,
  WORKSHEET_RECOMMENDATION_POLICY_VERSION,
  computePersistentEvidenceFingerprint,
  computeWorksheetRecommendationFingerprint,
} = require('../src/config/feature9Provenance');

const SHA256_HEX = /^[0-9a-f]{64}$/;

function validEvidenceInput() {
  return {
    studentId: 13,
    caseType: 'lowercase',
    family: 'curved',
    earlierWindow: {
      successfulCycles: 1,
      failedCycles: 4,
      evidenceStart: '2026-08-01T10:00:00.000Z',
      evidenceEnd: '2026-08-01T12:00:00.000Z',
    },
    recentWindow: {
      successfulCycles: 0,
      failedCycles: 5,
      evidenceStart: '2026-08-03T10:00:00.000Z',
      evidenceEnd: '2026-08-03T12:00:00.000Z',
    },
    affectedLetters: [
      { letter: 'c', totalCycles: 6, failedCycles: 6 },
      { letter: 'o', totalCycles: 4, failedCycles: 3 },
    ],
    persistentPolicyVersion: PERSISTENT_DIFFICULTY_POLICY_VERSION,
    mappingVersion: 'letter-baseline-family-v1',
  };
}

function validRecommendationInput(evidenceFingerprint) {
  return {
    studentId: 13,
    caseType: 'lowercase',
    family: 'curved',
    recommendationType: 'motor_family_practice',
    focusLetters: ['c', 'o'],
    evidenceFingerprint: evidenceFingerprint ?? computePersistentEvidenceFingerprint(validEvidenceInput()),
    recommendationPolicyVersion: WORKSHEET_RECOMMENDATION_POLICY_VERSION,
  };
}

// ─── 1-5: constants ─────────────────────────────────────────────────────────

describe('policy-version constants', () => {
  it('1. persistent policy version is exactly persistent_difficulty_v1', () => {
    expect(PERSISTENT_DIFFICULTY_POLICY_VERSION).toBe('persistent_difficulty_v1');
  });

  it('2. recommendation policy version is exactly worksheet_recommendation_v1', () => {
    expect(WORKSHEET_RECOMMENDATION_POLICY_VERSION).toBe('worksheet_recommendation_v1');
  });

  it('3. both versions are non-empty strings', () => {
    expect(typeof PERSISTENT_DIFFICULTY_POLICY_VERSION).toBe('string');
    expect(PERSISTENT_DIFFICULTY_POLICY_VERSION.length).toBeGreaterThan(0);
    expect(typeof WORKSHEET_RECOMMENDATION_POLICY_VERSION).toBe('string');
    expect(WORKSHEET_RECOMMENDATION_POLICY_VERSION.length).toBeGreaterThan(0);
  });

  it('4. the two policy versions are distinct', () => {
    expect(PERSISTENT_DIFFICULTY_POLICY_VERSION).not.toBe(WORKSHEET_RECOMMENDATION_POLICY_VERSION);
  });

  it('5. mapping version is reused from letterBaselineFamilies.js, never reinvented here', () => {
    // eslint-disable-next-line global-require
    const { MAPPING_VERSION } = require('../src/config/letterBaselineFamilies');
    const fp = computePersistentEvidenceFingerprint({ ...validEvidenceInput(), mappingVersion: MAPPING_VERSION });
    expect(fp).toMatch(SHA256_HEX);
    // This module itself must export no mapping-version constant of its own.
    const provenance = require('../src/config/feature9Provenance');
    expect(provenance.MAPPING_VERSION).toBeUndefined();
    expect(provenance.FEATURE9_MAPPING_VERSION).toBeUndefined();
  });
});

// ─── 6-25: evidence fingerprint ─────────────────────────────────────────────

describe('computePersistentEvidenceFingerprint', () => {
  it('6. valid input returns a 64-char lowercase hex SHA-256 digest', () => {
    const fp = computePersistentEvidenceFingerprint(validEvidenceInput());
    expect(fp).toMatch(SHA256_HEX);
  });

  it('7. same input is deterministic', () => {
    const a = computePersistentEvidenceFingerprint(validEvidenceInput());
    const b = computePersistentEvidenceFingerprint(validEvidenceInput());
    expect(a).toBe(b);
  });

  it('8. caseType change changes the fingerprint', () => {
    const base = computePersistentEvidenceFingerprint(validEvidenceInput());
    const changed = computePersistentEvidenceFingerprint({ ...validEvidenceInput(), caseType: 'uppercase' });
    expect(changed).not.toBe(base);
  });

  it('9. family change changes the fingerprint', () => {
    const base = computePersistentEvidenceFingerprint(validEvidenceInput());
    const changed = computePersistentEvidenceFingerprint({ ...validEvidenceInput(), family: 'straight' });
    expect(changed).not.toBe(base);
  });

  it('10. studentId change changes the fingerprint', () => {
    const base = computePersistentEvidenceFingerprint(validEvidenceInput());
    const changed = computePersistentEvidenceFingerprint({ ...validEvidenceInput(), studentId: 10 });
    expect(changed).not.toBe(base);
  });

  it('11. earlierWindow timestamp change changes the fingerprint', () => {
    const base = computePersistentEvidenceFingerprint(validEvidenceInput());
    const input = validEvidenceInput();
    input.earlierWindow.evidenceEnd = '2026-08-01T13:00:00.000Z';
    expect(computePersistentEvidenceFingerprint(input)).not.toBe(base);
  });

  it('12. recentWindow timestamp change changes the fingerprint', () => {
    const base = computePersistentEvidenceFingerprint(validEvidenceInput());
    const input = validEvidenceInput();
    input.recentWindow.evidenceEnd = '2026-08-03T13:00:00.000Z';
    expect(computePersistentEvidenceFingerprint(input)).not.toBe(base);
  });

  it('13. successfulCycles change changes the fingerprint', () => {
    const base = computePersistentEvidenceFingerprint(validEvidenceInput());
    const input = validEvidenceInput();
    input.earlierWindow.successfulCycles = 2;
    expect(computePersistentEvidenceFingerprint(input)).not.toBe(base);
  });

  it('14. failedCycles change changes the fingerprint', () => {
    const base = computePersistentEvidenceFingerprint(validEvidenceInput());
    const input = validEvidenceInput();
    input.recentWindow.failedCycles = 4;
    expect(computePersistentEvidenceFingerprint(input)).not.toBe(base);
  });

  it('15. an affected letter change changes the fingerprint', () => {
    const base = computePersistentEvidenceFingerprint(validEvidenceInput());
    const input = validEvidenceInput();
    input.affectedLetters[0].failedCycles = 5;
    expect(computePersistentEvidenceFingerprint(input)).not.toBe(base);
  });

  it('16. affected-letter order change changes the fingerprint (never re-sorted)', () => {
    const base = computePersistentEvidenceFingerprint(validEvidenceInput());
    const input = validEvidenceInput();
    input.affectedLetters = [input.affectedLetters[1], input.affectedLetters[0]];
    expect(computePersistentEvidenceFingerprint(input)).not.toBe(base);
  });

  it('17. affected-letter count change changes the fingerprint', () => {
    const base = computePersistentEvidenceFingerprint(validEvidenceInput());
    const input = validEvidenceInput();
    input.affectedLetters.push({ letter: 'l', totalCycles: 2, failedCycles: 1 });
    expect(computePersistentEvidenceFingerprint(input)).not.toBe(base);
  });

  it('18. persistentPolicyVersion change changes the fingerprint', () => {
    const base = computePersistentEvidenceFingerprint(validEvidenceInput());
    const changed = computePersistentEvidenceFingerprint({
      ...validEvidenceInput(), persistentPolicyVersion: 'persistent_difficulty_v2',
    });
    expect(changed).not.toBe(base);
  });

  it('19. mappingVersion change changes the fingerprint', () => {
    const base = computePersistentEvidenceFingerprint(validEvidenceInput());
    const changed = computePersistentEvidenceFingerprint({
      ...validEvidenceInput(), mappingVersion: 'letter-baseline-family-v2',
    });
    expect(changed).not.toBe(base);
  });

  it('20. a Date instance and its equivalent ISO string yield the same fingerprint', () => {
    const isoInput = validEvidenceInput();
    const dateInput = validEvidenceInput();
    dateInput.earlierWindow.evidenceStart = new Date(isoInput.earlierWindow.evidenceStart);
    dateInput.earlierWindow.evidenceEnd = new Date(isoInput.earlierWindow.evidenceEnd);
    dateInput.recentWindow.evidenceStart = new Date(isoInput.recentWindow.evidenceStart);
    dateInput.recentWindow.evidenceEnd = new Date(isoInput.recentWindow.evidenceEnd);

    expect(computePersistentEvidenceFingerprint(dateInput)).toBe(computePersistentEvidenceFingerprint(isoInput));
  });

  it('21. a malformed timestamp returns null, never a hash of "Invalid Date"', () => {
    const input = validEvidenceInput();
    input.earlierWindow.evidenceStart = 'not-a-real-date';
    expect(computePersistentEvidenceFingerprint(input)).toBeNull();
  });

  it('22. NaN/Infinity cycle counts return null', () => {
    const nanInput = validEvidenceInput();
    nanInput.earlierWindow.successfulCycles = NaN;
    expect(computePersistentEvidenceFingerprint(nanInput)).toBeNull();

    const infInput = validEvidenceInput();
    infInput.recentWindow.failedCycles = Infinity;
    expect(computePersistentEvidenceFingerprint(infInput)).toBeNull();

    const stringInput = validEvidenceInput();
    stringInput.earlierWindow.failedCycles = '4';
    expect(computePersistentEvidenceFingerprint(stringInput)).toBeNull();
  });

  it('23. missing required fields return null', () => {
    expect(computePersistentEvidenceFingerprint({})).toBeNull();
    const missingLetters = validEvidenceInput();
    delete missingLetters.affectedLetters;
    expect(computePersistentEvidenceFingerprint(missingLetters)).toBeNull();
    const missingVersion = validEvidenceInput();
    delete missingVersion.persistentPolicyVersion;
    expect(computePersistentEvidenceFingerprint(missingVersion)).toBeNull();
  });

  it('24. an unknown/invalid family returns null', () => {
    const input = validEvidenceInput();
    input.family = 'diagonal'; // motor-primitive taxonomy value, not a baseline family
    expect(computePersistentEvidenceFingerprint(input)).toBeNull();
  });

  it('25. an invalid caseType returns null', () => {
    const input = validEvidenceInput();
    input.caseType = 'mixedcase';
    expect(computePersistentEvidenceFingerprint(input)).toBeNull();
  });
});

// ─── 26-38: recommendation fingerprint ──────────────────────────────────────

describe('computeWorksheetRecommendationFingerprint', () => {
  it('26. valid input returns a 64-char lowercase hex digest', () => {
    const fp = computeWorksheetRecommendationFingerprint(validRecommendationInput());
    expect(fp).toMatch(SHA256_HEX);
  });

  it('27. deterministic for the same input', () => {
    const a = computeWorksheetRecommendationFingerprint(validRecommendationInput());
    const b = computeWorksheetRecommendationFingerprint(validRecommendationInput());
    expect(a).toBe(b);
  });

  it('28. an evidence-fingerprint change changes the result', () => {
    const base = computeWorksheetRecommendationFingerprint(validRecommendationInput());
    const otherEvidenceFp = computePersistentEvidenceFingerprint({ ...validEvidenceInput(), studentId: 10 });
    const changed = computeWorksheetRecommendationFingerprint(validRecommendationInput(otherEvidenceFp));
    expect(changed).not.toBe(base);
  });

  it('29. a recommendationPolicyVersion change changes the result', () => {
    const base = computeWorksheetRecommendationFingerprint(validRecommendationInput());
    const changed = computeWorksheetRecommendationFingerprint({
      ...validRecommendationInput(), recommendationPolicyVersion: 'worksheet_recommendation_v2',
    });
    expect(changed).not.toBe(base);
  });

  it('30. a recommendationType change changes the result', () => {
    const base = computeWorksheetRecommendationFingerprint(validRecommendationInput());
    const changed = computeWorksheetRecommendationFingerprint({
      ...validRecommendationInput(), recommendationType: 'some_other_type',
    });
    expect(changed).not.toBe(base);
  });

  it('31. a focus-letter change changes the result', () => {
    const base = computeWorksheetRecommendationFingerprint(validRecommendationInput());
    const changed = computeWorksheetRecommendationFingerprint({
      ...validRecommendationInput(), focusLetters: ['c', 'v'],
    });
    expect(changed).not.toBe(base);
  });

  it('32. a focus-letter order change changes the result (never re-sorted)', () => {
    const base = computeWorksheetRecommendationFingerprint(validRecommendationInput());
    const changed = computeWorksheetRecommendationFingerprint({
      ...validRecommendationInput(), focusLetters: ['o', 'c'],
    });
    expect(changed).not.toBe(base);
  });

  it('33. a case change changes the result', () => {
    const evidenceFp = computePersistentEvidenceFingerprint(validEvidenceInput());
    const base = computeWorksheetRecommendationFingerprint({ ...validRecommendationInput(evidenceFp), caseType: 'lowercase' });
    const changed = computeWorksheetRecommendationFingerprint({ ...validRecommendationInput(evidenceFp), caseType: 'uppercase' });
    expect(changed).not.toBe(base);
  });

  it('34. a family change changes the result', () => {
    const evidenceFp = computePersistentEvidenceFingerprint(validEvidenceInput());
    const base = computeWorksheetRecommendationFingerprint({ ...validRecommendationInput(evidenceFp), family: 'curved' });
    const changed = computeWorksheetRecommendationFingerprint({ ...validRecommendationInput(evidenceFp), family: 'straight' });
    expect(changed).not.toBe(base);
  });

  it('35. a studentId change changes the result', () => {
    const evidenceFp = computePersistentEvidenceFingerprint(validEvidenceInput());
    const base = computeWorksheetRecommendationFingerprint({ ...validRecommendationInput(evidenceFp), studentId: 13 });
    const changed = computeWorksheetRecommendationFingerprint({ ...validRecommendationInput(evidenceFp), studentId: 10 });
    expect(changed).not.toBe(base);
  });

  it('36. a malformed evidence fingerprint returns null', () => {
    const input = validRecommendationInput('not-a-real-sha256');
    expect(computeWorksheetRecommendationFingerprint(input)).toBeNull();
  });

  it('37. invalid focusLetters returns null', () => {
    expect(computeWorksheetRecommendationFingerprint({ ...validRecommendationInput(), focusLetters: [] })).toBeNull();
    expect(computeWorksheetRecommendationFingerprint({ ...validRecommendationInput(), focusLetters: ['c', ''] })).toBeNull();
    expect(computeWorksheetRecommendationFingerprint({ ...validRecommendationInput(), focusLetters: 'c' })).toBeNull();
  });

  it('38. a missing recommendationType returns null', () => {
    const input = validRecommendationInput();
    delete input.recommendationType;
    expect(computeWorksheetRecommendationFingerprint(input)).toBeNull();
  });
});

// ─── 39-42: recommendation identity excludes human-action fields ───────────

describe('recommendation identity is independent of teacher action (spec §57)', () => {
  const base = computeWorksheetRecommendationFingerprint(validRecommendationInput());

  it('39. a teacherId field on the input does not affect the fingerprint (not a recognized input)', () => {
    const withExtra = computeWorksheetRecommendationFingerprint({ ...validRecommendationInput(), teacherId: 999 });
    expect(withExtra).toBe(base);
  });

  it('40. a validation status field on the input does not affect the fingerprint', () => {
    const withExtra = computeWorksheetRecommendationFingerprint({ ...validRecommendationInput(), validation: 'confirmed' });
    expect(withExtra).toBe(base);
  });

  it('41. a teacherNote field on the input does not affect the fingerprint', () => {
    const withExtra = computeWorksheetRecommendationFingerprint({ ...validRecommendationInput(), teacherNote: 'Tired today' });
    expect(withExtra).toBe(base);
  });

  it('42. a createdAt field on the input does not affect the fingerprint', () => {
    const withExtra = computeWorksheetRecommendationFingerprint({ ...validRecommendationInput(), createdAt: '2026-08-14T00:00:00.000Z' });
    expect(withExtra).toBe(base);
  });
});

// ─── 43-46: canonicalization ────────────────────────────────────────────────

describe('canonical serialization (spec §58)', () => {
  it('43. object property insertion order differences produce the same fingerprint', () => {
    const inOrder = validEvidenceInput();
    const reordered = {
      mappingVersion: inOrder.mappingVersion,
      persistentPolicyVersion: inOrder.persistentPolicyVersion,
      affectedLetters: inOrder.affectedLetters,
      recentWindow: inOrder.recentWindow,
      earlierWindow: inOrder.earlierWindow,
      family: inOrder.family,
      caseType: inOrder.caseType,
      studentId: inOrder.studentId,
    };
    expect(computePersistentEvidenceFingerprint(reordered)).toBe(computePersistentEvidenceFingerprint(inOrder));
  });

  it('44. a Date and its equivalent ISO string produce the same fingerprint (re-confirmation of item 20)', () => {
    const iso = validEvidenceInput();
    const dated = validEvidenceInput();
    dated.recentWindow.evidenceStart = new Date(iso.recentWindow.evidenceStart);
    expect(computePersistentEvidenceFingerprint(dated)).toBe(computePersistentEvidenceFingerprint(iso));
  });

  it('45. unrelated extra object properties are ignored', () => {
    const input = validEvidenceInput();
    input.somethingUnrelated = 'ignore me';
    input.earlierWindow.somethingElseUnrelated = 12345;
    const base = computePersistentEvidenceFingerprint(validEvidenceInput());
    expect(computePersistentEvidenceFingerprint(input)).toBe(base);
  });

  it('46. arrays remain order-sensitive (re-confirmation of items 16/32)', () => {
    const a = computePersistentEvidenceFingerprint(validEvidenceInput());
    const reorderedInput = validEvidenceInput();
    reorderedInput.affectedLetters.reverse();
    expect(computePersistentEvidenceFingerprint(reorderedInput)).not.toBe(a);
  });
});

// ─── 47-52: source-scan purity ──────────────────────────────────────────────

function readProvenanceSource() {
  return fs.readFileSync(path.resolve(__dirname, '../src/config/feature9Provenance.js'), 'utf8');
}

// Scoped to require(...) lines only — the module's own header comment
// legitimately discusses persistentDifficultyService.js/worksheetRecommendationService.js
// by name to document why they are NOT imported (the same false-positive
// pitfall hit repeatedly in Features 6-8's own source-scan tests).
function requireLines(source) {
  return source.split('\n').filter((line) => /require\(/.test(line)).join('\n');
}

describe('source-scan purity (spec §59)', () => {
  it('47. never imports ../models', () => {
    expect(requireLines(readProvenanceSource())).not.toMatch(/require\(['"]\.\.\/models['"]\)/);
  });

  it('48. never imports a Feature 7 service or evidence module', () => {
    const lines = requireLines(readProvenanceSource());
    expect(lines).not.toMatch(/persistentDifficultyService/);
    expect(lines).not.toMatch(/persistentDifficultyEvidence/);
  });

  it('49. never imports the Feature 8 service', () => {
    expect(requireLines(readProvenanceSource())).not.toMatch(/worksheetRecommendationService/);
  });

  it('50. contains no database write method calls', () => {
    // Excludes lines using Node crypto's own legitimate `.update(...)` chain
    // (Hash#update(), part of hashCanonicalPayload()) — a false positive of
    // the same shape as the comment-text false positives hit repeatedly in
    // Features 6-8's own source-scan tests, just on code rather than prose.
    const nonCryptoLines = readProvenanceSource()
      .split('\n')
      .filter((line) => !/createHash|\.digest\(/.test(line))
      .join('\n');
    expect(nonCryptoLines).not.toMatch(/\.(create|update|destroy|bulkCreate|increment|save|findOrCreate)\(/);
  });

  it('51. never imports the filesystem module', () => {
    expect(requireLines(readProvenanceSource())).not.toMatch(/require\(['"]fs['"]\)/);
  });

  it('52. never imports a network/HTTP client', () => {
    const lines = requireLines(readProvenanceSource());
    expect(lines).not.toMatch(/require\(['"](axios|http|https|node-fetch)['"]\)/);
    expect(readProvenanceSource()).not.toMatch(/\bfetch\(/);
  });

  it('the module imports only Node\'s built-in crypto', () => {
    const lines = requireLines(readProvenanceSource())
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/require\(['"]crypto['"]\)/);
  });
});

// ─── design-doc tripwire (spec §60) ─────────────────────────────────────────

describe('feature9-validation-history-design.md doc tripwire (spec §60)', () => {
  const docSource = fs.readFileSync(
    path.resolve(__dirname, '../docs/feature9-validation-history-design.md'),
    'utf8'
  );

  it('documents the append-only rule', () => {
    expect(docSource).toMatch(/append-only/i);
    expect(docSource).toMatch(/no update/i);
    expect(docSource).toMatch(/no delete/i);
  });

  it('documents both validation values', () => {
    expect(docSource).toMatch(/confirmed/);
    expect(docSource).toMatch(/dismissed/);
  });

  it('documents both fingerprint field names', () => {
    expect(docSource).toMatch(/recommendation_fingerprint/);
    expect(docSource).toMatch(/evidence_fingerprint/);
  });

  it('documents the race-handling contract', () => {
    expect(docSource).toMatch(/409/);
    expect(docSource).toMatch(/recommendation_changed/);
  });
});
