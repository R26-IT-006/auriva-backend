'use strict';

// Feature 8 Step 2 — worksheetRecommendationPolicy.js tests (pure config +
// pure helpers, no I/O). Covers spec items 1-40 (policy vocabulary, template
// lookup, focus-letter extraction, rationale, recommendation builder,
// source scans).

const {
  WORKSHEET_RECOMMENDATION_TYPES,
  VALID_FAMILIES,
  isValidFamily,
  WORKSHEET_RECOMMENDATION_POLICY,
  getWorksheetRecommendationTemplate,
  extractFocusLetters,
  buildWorksheetRationale,
  buildWorksheetRecommendation,
  summarizeWorksheetRecommendations,
} = require('../src/config/worksheetRecommendationPolicy');

// ─── §42 Tests 1-8 — policy vocabulary ─────────────────────────────────────

describe('Test 1 — policy supports exactly straight|curved|complex', () => {
  it('VALID_FAMILIES contains exactly the three Feature 7 families', () => {
    expect([...VALID_FAMILIES].sort()).toEqual(['complex', 'curved', 'straight']);
  });

  it('WORKSHEET_RECOMMENDATION_POLICY has exactly those three keys', () => {
    expect(Object.keys(WORKSHEET_RECOMMENDATION_POLICY).sort()).toEqual(['complex', 'curved', 'straight']);
  });
});

describe('Test 2 — no fourth family', () => {
  it.each(['vertical_horizontal', 'diagonal', 'mixed', 'zigzag', 'weak_curve_control'])(
    '%p is not a valid family', (bad) => {
      expect(isValidFamily(bad)).toBe(false);
      expect(getWorksheetRecommendationTemplate(bad)).toBeNull();
    }
  );
});

describe('Test 3 — one recommendation type only', () => {
  it('WORKSHEET_RECOMMENDATION_TYPES has exactly one value: motor_family_practice', () => {
    expect(Object.values(WORKSHEET_RECOMMENDATION_TYPES)).toEqual(['motor_family_practice']);
  });

  it('no foundation/guided/independent/advanced type values exist', () => {
    const values = Object.values(WORKSHEET_RECOMMENDATION_TYPES);
    for (const forbidden of ['foundation', 'guided', 'independent', 'advanced']) {
      expect(values).not.toContain(forbidden);
    }
  });
});

describe('Test 4 — no severity vocabulary', () => {
  it('the policy file source (comment-stripped) never references severity/priority/confidence scoring', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/config/worksheetRecommendationPolicy.js'), 'utf8');
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/high_severity|medium_severity|low_severity|priorityScore|confidenceScore|severity:/i);
  });
});

describe('Test 5 — no diagnosis wording', () => {
  it('no template title/activity/rationale (actual data content, not documentation) contains clinical diagnosis language', () => {
    // Scoped to the DATA content only, not the whole file — this module's
    // own header comment legitimately DISCUSSES "diagnosis"/"clinical
    // intervention"/"motor-impairment treatment" by name (documenting what
    // a worksheet recommendation explicitly is NOT), which would otherwise
    // be a false positive on a bare substring match, the same pitfall
    // caught repeatedly throughout this project.
    const blob = JSON.stringify({
      types: WORKSHEET_RECOMMENDATION_TYPES,
      policy: WORKSHEET_RECOMMENDATION_POLICY,
      rationales: VALID_FAMILIES.map((family) => buildWorksheetRationale({ family, earlierWindow: SAMPLE_WINDOW, recentWindow: SAMPLE_WINDOW })),
    });
    expect(blob).not.toMatch(/diagnos|impairment|therapy|clinical treatment|motor deficit/i);
  });
});

describe('Test 6 — no PDF/download wording', () => {
  it('no template content references PDF, download, or print', () => {
    for (const family of VALID_FAMILIES) {
      const template = getWorksheetRecommendationTemplate(family);
      const blob = JSON.stringify(template);
      expect(blob).not.toMatch(/pdf|download|print/i);
    }
  });
});

describe('Test 7 — no teacher-action states', () => {
  it('no template or builder output contains accepted/dismissed/assigned/completed fields', () => {
    const rec = buildWorksheetRecommendation({ caseType: 'lowercase', family: 'curved', affectedLetters: [{ letter: 'c' }] });
    expect(rec).not.toHaveProperty('accepted');
    expect(rec).not.toHaveProperty('dismissed');
    expect(rec).not.toHaveProperty('assigned');
    expect(rec).not.toHaveProperty('completed');
  });

  it('no recommendation_id/created_at/teacher_id/status persistence-shaped fields exist', () => {
    const rec = buildWorksheetRecommendation({ caseType: 'lowercase', family: 'curved', affectedLetters: [{ letter: 'c' }] });
    expect(rec).not.toHaveProperty('recommendation_id');
    expect(rec).not.toHaveProperty('created_at');
    expect(rec).not.toHaveProperty('teacher_id');
    expect(rec).not.toHaveProperty('status');
  });
});

describe('Test 8 — no static letterFocus arrays', () => {
  it('no template contains a hardcoded per-family letter list', () => {
    for (const family of VALID_FAMILIES) {
      const template = getWorksheetRecommendationTemplate(family);
      expect(template).not.toHaveProperty('letterFocus');
      expect(template).not.toHaveProperty('focusLetters');
      const blob = JSON.stringify(template).toLowerCase();
      // No individual bare letter tokens embedded as data (activity text may
      // mention "focus letters" generically, but never e.g. "c, o" or a
      // specific letter list).
      expect(blob).not.toMatch(/"c",\s*"o"|"v",\s*"w",\s*"x"/);
    }
  });

  it('the policy file never imports difficultyRules.js (content was hand-adapted, not reused programmatically)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/config/worksheetRecommendationPolicy.js'), 'utf8');
    const requireLines = source.split('\n').filter((l) => /require\(/.test(l)).join('\n');
    expect(requireLines).not.toMatch(/difficultyRules/);
  });
});

// ─── §43 Tests 9-15 — template lookup ──────────────────────────────────────

describe('Test 9 — straight returns correct title', () => {
  it('title is exactly "Straight Movement Practice"', () => {
    expect(getWorksheetRecommendationTemplate('straight').title).toBe('Straight Movement Practice');
  });
});

describe('Test 10 — curved returns correct title', () => {
  it('title is exactly "Curved Movement Practice"', () => {
    expect(getWorksheetRecommendationTemplate('curved').title).toBe('Curved Movement Practice');
  });
});

describe('Test 11 — complex returns correct title', () => {
  it('title is exactly "Complex Movement Practice"', () => {
    expect(getWorksheetRecommendationTemplate('complex').title).toBe('Complex Movement Practice');
  });
});

describe('Test 12 — unknown family returns null', () => {
  it.each([null, undefined, '', 'STRAIGHT', 'unknown', 42, {}])('getWorksheetRecommendationTemplate(%p) is null', (bad) => {
    expect(() => getWorksheetRecommendationTemplate(bad)).not.toThrow();
    expect(getWorksheetRecommendationTemplate(bad)).toBeNull();
  });
});

describe('Test 13 — same lookup deterministic', () => {
  it('repeated calls for the same family return deep-equal templates', () => {
    const a = getWorksheetRecommendationTemplate('curved');
    const b = getWorksheetRecommendationTemplate('curved');
    expect(a).toEqual(b);
  });
});

describe('Test 14 — activity arrays non-empty', () => {
  it.each(VALID_FAMILIES)('%s has a non-empty suggestedActivities array', (family) => {
    const template = getWorksheetRecommendationTemplate(family);
    expect(Array.isArray(template.suggestedActivities)).toBe(true);
    expect(template.suggestedActivities.length).toBeGreaterThan(0);
  });
});

describe('Test 15 — each family has similar bounded activity count', () => {
  it('every family has between 4 and 5 activities, and all three have the SAME count (content parity)', () => {
    const counts = VALID_FAMILIES.map((f) => getWorksheetRecommendationTemplate(f).suggestedActivities.length);
    for (const count of counts) {
      expect(count).toBeGreaterThanOrEqual(4);
      expect(count).toBeLessThanOrEqual(5);
    }
    expect(new Set(counts).size).toBe(1); // exact parity across families
  });
});

// ─── §44 Tests 16-23 — focus letters ───────────────────────────────────────

describe('Test 16 — extracts letters in original order', () => {
  it('preserves Feature 7\'s own affectedLetters order exactly, never re-sorted', () => {
    const affectedLetters = [
      { letter: 'c', totalCycles: 6, failedCycles: 6 },
      { letter: 'o', totalCycles: 4, failedCycles: 3 },
    ];
    expect(extractFocusLetters(affectedLetters)).toEqual(['c', 'o']);
  });

  it('a differently-ordered input (e.g. lower failedCycles first) is preserved as given — extraction never re-sorts', () => {
    const affectedLetters = [
      { letter: 's', totalCycles: 2, failedCycles: 1 },
      { letter: 'v', totalCycles: 5, failedCycles: 5 },
    ];
    expect(extractFocusLetters(affectedLetters)).toEqual(['s', 'v']);
  });
});

describe('Test 17 — uppercase preserved', () => {
  it('["C", "O"] stays exactly ["C", "O"], never lowercased', () => {
    const affectedLetters = [{ letter: 'C', totalCycles: 3, failedCycles: 3 }, { letter: 'O', totalCycles: 2, failedCycles: 1 }];
    expect(extractFocusLetters(affectedLetters)).toEqual(['C', 'O']);
  });
});

describe('Test 18 — lowercase preserved', () => {
  it('["c", "o"] stays exactly ["c", "o"], never uppercased', () => {
    const affectedLetters = [{ letter: 'c', totalCycles: 3, failedCycles: 3 }, { letter: 'o', totalCycles: 2, failedCycles: 1 }];
    expect(extractFocusLetters(affectedLetters)).toEqual(['c', 'o']);
  });
});

describe('Test 19 — malformed input -> []', () => {
  it.each([{}, 'string', 42, true, () => {}])('non-array input %p resolves to []', (bad) => {
    expect(() => extractFocusLetters(bad)).not.toThrow();
    expect(extractFocusLetters(bad)).toEqual([]);
  });
});

describe('Test 20 — empty -> []', () => {
  it.each([null, undefined, []])('%p resolves to []', (empty) => {
    expect(extractFocusLetters(empty)).toEqual([]);
  });
});

describe('Test 21 — invalid entries safely ignored', () => {
  it('entries with a missing/non-string/empty letter are dropped, valid entries kept', () => {
    const affectedLetters = [
      { letter: 'c', totalCycles: 1, failedCycles: 1 },
      { letter: null, totalCycles: 1, failedCycles: 1 },
      { totalCycles: 1, failedCycles: 1 }, // no letter key
      { letter: '', totalCycles: 1, failedCycles: 1 }, // empty string
      { letter: 42, totalCycles: 1, failedCycles: 1 }, // non-string
      null,
      undefined,
      { letter: 'o', totalCycles: 1, failedCycles: 1 },
    ];
    expect(extractFocusLetters(affectedLetters)).toEqual(['c', 'o']);
  });
});

describe('Test 22 — failedCycles does not alter order', () => {
  it('reversing failedCycles values on the same input order does not change extraction order', () => {
    const affectedLetters = [
      { letter: 'c', totalCycles: 1, failedCycles: 0 }, // low failedCycles, first position
      { letter: 'o', totalCycles: 1, failedCycles: 99 }, // high failedCycles, second position
    ];
    expect(extractFocusLetters(affectedLetters)).toEqual(['c', 'o']); // order = input order, not failedCycles-sorted
  });
});

describe('Test 23 — totalCycles does not alter order', () => {
  it('reversing totalCycles values on the same input order does not change extraction order', () => {
    const affectedLetters = [
      { letter: 'c', totalCycles: 1, failedCycles: 1 },
      { letter: 'o', totalCycles: 99, failedCycles: 1 },
    ];
    expect(extractFocusLetters(affectedLetters)).toEqual(['c', 'o']);
  });
});

// ─── §45 Tests 24-31 — rationale ────────────────────────────────────────────

const SAMPLE_WINDOW = { successfulCycles: 1, failedCycles: 4 };

describe('Test 24 — straight rationale teacher-friendly', () => {
  it('mentions "Straight movement practice"', () => {
    const rationale = buildWorksheetRationale({ family: 'straight', earlierWindow: SAMPLE_WINDOW, recentWindow: SAMPLE_WINDOW });
    expect(rationale).toMatch(/Straight movement practice/);
  });
});

describe('Test 25 — curved rationale teacher-friendly', () => {
  it('mentions "Curved movement practice"', () => {
    const rationale = buildWorksheetRationale({ family: 'curved', earlierWindow: SAMPLE_WINDOW, recentWindow: SAMPLE_WINDOW });
    expect(rationale).toMatch(/Curved movement practice/);
  });
});

describe('Test 26 — complex rationale teacher-friendly', () => {
  it('mentions "Complex movement practice"', () => {
    const rationale = buildWorksheetRationale({ family: 'complex', earlierWindow: SAMPLE_WINDOW, recentWindow: SAMPLE_WINDOW });
    expect(rationale).toMatch(/Complex movement practice/);
  });
});

describe('Test 27 — contains "separate practice periods" concept', () => {
  it.each(VALID_FAMILIES)('%s rationale mentions separate practice periods', (family) => {
    const rationale = buildWorksheetRationale({ family, earlierWindow: SAMPLE_WINDOW, recentWindow: SAMPLE_WINDOW });
    expect(rationale).toMatch(/separate practice periods/);
  });
});

describe('Test 28 — contains no raw separationMs', () => {
  it('no rationale ever contains a raw millisecond figure or the word "separationMs"', () => {
    for (const family of VALID_FAMILIES) {
      const rationale = buildWorksheetRationale({ family, earlierWindow: SAMPLE_WINDOW, recentWindow: SAMPLE_WINDOW });
      expect(rationale).not.toMatch(/separationMs|\d{4,}ms/i);
    }
  });
});

describe('Test 29 — contains no raw thresholds', () => {
  it('no rationale mentions "24 hour", "window", or a raw success-rate percentage', () => {
    for (const family of VALID_FAMILIES) {
      const rationale = buildWorksheetRationale({ family, earlierWindow: SAMPLE_WINDOW, recentWindow: SAMPLE_WINDOW });
      expect(rationale).not.toMatch(/24.hour|window|%|threshold/i);
    }
  });
});

describe('Test 30 — contains no diagnosis/severity language', () => {
  it('no rationale mentions diagnosis, impairment, or severity', () => {
    for (const family of VALID_FAMILIES) {
      const rationale = buildWorksheetRationale({ family, earlierWindow: SAMPLE_WINDOW, recentWindow: SAMPLE_WINDOW });
      expect(rationale).not.toMatch(/diagnos|impairment|severe|severity/i);
    }
  });
});

describe('Test 31 — deterministic', () => {
  it('the same inputs always produce the exact same rationale string', () => {
    const a = buildWorksheetRationale({ family: 'curved', earlierWindow: SAMPLE_WINDOW, recentWindow: SAMPLE_WINDOW });
    const b = buildWorksheetRationale({ family: 'curved', earlierWindow: { ...SAMPLE_WINDOW }, recentWindow: { ...SAMPLE_WINDOW } });
    expect(a).toBe(b);
  });

  it('an invalid family returns null, never a guessed sentence', () => {
    expect(buildWorksheetRationale({ family: 'diagonal' })).toBeNull();
    expect(buildWorksheetRationale({})).toBeNull();
    expect(buildWorksheetRationale()).toBeNull();
  });

  it('missing windows still produce the intro sentence alone, without throwing', () => {
    const rationale = buildWorksheetRationale({ family: 'curved' });
    expect(rationale).toBe('Curved movement practice is recommended because difficulty remained across two separate practice periods.');
  });
});

// ─── §46 Tests 32-40 — recommendation builder ──────────────────────────────

describe('Test 32 — curved + c/o -> expected hybrid object', () => {
  it('produces the exact documented shape', () => {
    const rec = buildWorksheetRecommendation({
      caseType: 'lowercase', family: 'curved',
      affectedLetters: [{ letter: 'c', totalCycles: 6, failedCycles: 6 }, { letter: 'o', totalCycles: 4, failedCycles: 3 }],
      earlierWindow: { successfulCycles: 1, failedCycles: 4 },
      recentWindow: { successfulCycles: 0, failedCycles: 5 },
    });
    expect(rec).toEqual({
      recommendationType: 'motor_family_practice',
      caseType: 'lowercase',
      family: 'curved',
      title: 'Curved Movement Practice',
      focusLetters: ['c', 'o'],
      rationale: 'Curved movement practice is recommended because difficulty remained across two separate practice periods. The pattern was observed in both the earlier and recent practice periods.',
      suggestedActivities: [
        'Circle tracing exercises',
        'Half-circle tracing with visual guides',
        'Slow curved-stroke repetition',
        'Guided tracing of focus letters',
        'Independent writing of focus letters',
      ],
    });
  });
});

describe('Test 33 — straight + uppercase letters preserved', () => {
  it('caseType=uppercase and affectedLetters=[I,L,T] pass through with case intact', () => {
    const rec = buildWorksheetRecommendation({
      caseType: 'uppercase', family: 'straight',
      affectedLetters: [{ letter: 'I', totalCycles: 5, failedCycles: 5 }, { letter: 'L', totalCycles: 3, failedCycles: 2 }, { letter: 'T', totalCycles: 2, failedCycles: 1 }],
    });
    expect(rec.caseType).toBe('uppercase');
    expect(rec.focusLetters).toEqual(['I', 'L', 'T']);
  });
});

describe('Test 34 — complex + s/x preserves live letters only', () => {
  it('focusLetters is exactly ["s", "x"], not expanded with the family template\'s implicit letters', () => {
    const rec = buildWorksheetRecommendation({
      caseType: 'lowercase', family: 'complex',
      affectedLetters: [{ letter: 's', totalCycles: 4, failedCycles: 4 }, { letter: 'x', totalCycles: 1, failedCycles: 1 }],
    });
    expect(rec.focusLetters).toEqual(['s', 'x']);
  });
});

describe('Test 35 — no static letters added', () => {
  it('a single-letter affectedLetters (["s"]) never expands to a full family letter set', () => {
    const rec = buildWorksheetRecommendation({
      caseType: 'lowercase', family: 'complex',
      affectedLetters: [{ letter: 's', totalCycles: 3, failedCycles: 3 }],
    });
    expect(rec.focusLetters).toEqual(['s']);
    expect(rec.focusLetters).not.toContain('v');
    expect(rec.focusLetters).not.toContain('w');
    expect(rec.focusLetters).not.toContain('x');
    expect(rec.focusLetters).not.toContain('y');
  });
});

describe('Test 36 — invalid family -> null', () => {
  it.each(['vertical_horizontal', 'diagonal', 'mixed', '', null, undefined, 'STRAIGHT'])('family=%p -> null', (bad) => {
    expect(buildWorksheetRecommendation({ caseType: 'lowercase', family: bad, affectedLetters: [] })).toBeNull();
  });
});

describe('Test 37 — invalid affectedLetters still recommendation with empty focusLetters if family valid', () => {
  it.each([null, undefined, [], 'not-an-array', 42])('affectedLetters=%p still returns a recommendation with focusLetters=[]', (bad) => {
    const rec = buildWorksheetRecommendation({ caseType: 'lowercase', family: 'curved', affectedLetters: bad });
    expect(rec).not.toBeNull();
    expect(rec.focusLetters).toEqual([]);
    expect(rec.title).toBe('Curved Movement Practice');
  });
});

describe('Test 38 — same input deep-equal', () => {
  it('two calls with structurally-identical (distinct-reference) input produce deep-equal output', () => {
    const input = {
      caseType: 'lowercase', family: 'curved',
      affectedLetters: [{ letter: 'c', totalCycles: 6, failedCycles: 6 }],
      earlierWindow: { successfulCycles: 1 }, recentWindow: { successfulCycles: 0 },
    };
    const a = buildWorksheetRecommendation({ ...input, affectedLetters: [...input.affectedLetters] });
    const b = buildWorksheetRecommendation({ ...input, affectedLetters: [...input.affectedLetters] });
    expect(a).toEqual(b);
  });
});

describe('Test 39 — no DB access', () => {
  it('the policy file never imports ../models', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/config/worksheetRecommendationPolicy.js'), 'utf8');
    const requireLines = source.split('\n').filter((l) => /require\(/.test(l)).join('\n');
    expect(requireLines).not.toMatch(/\.\.\/models/);
  });

  it('the file has zero require() statements at all — fully self-contained pure config', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/config/worksheetRecommendationPolicy.js'), 'utf8');
    expect(source).not.toMatch(/require\(/);
  });
});

describe('Test 40 — no imports from Features 1-7 services', () => {
  it('the policy file never imports any Feature 1-7 service/model', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/config/worksheetRecommendationPolicy.js'), 'utf8');
    const requireLines = source.split('\n').filter((l) => /require\(/.test(l)).join('\n');
    expect(requireLines).not.toMatch(/StudentMotorBaseline|dynamicThresholdService|adaptiveSupportService|adaptivePreWritingService|repetitionRecommendationService|demoSpeedRecommendationService|persistentDifficultyService|persistentDifficultyEvidence/);
  });
});

// ─── §30 — summary helper ───────────────────────────────────────────────────

describe('summarizeWorksheetRecommendations', () => {
  it('counts a real array correctly', () => {
    const recs = [
      buildWorksheetRecommendation({ caseType: 'lowercase', family: 'curved', affectedLetters: [{ letter: 'c' }] }),
      buildWorksheetRecommendation({ caseType: 'uppercase', family: 'straight', affectedLetters: [{ letter: 'I' }] }),
    ];
    expect(summarizeWorksheetRecommendations(recs)).toEqual({ recommendationCount: 2 });
  });

  it('an empty array -> recommendationCount: 0', () => {
    expect(summarizeWorksheetRecommendations([])).toEqual({ recommendationCount: 0 });
  });

  it('non-array input safely resolves to recommendationCount: 0, never throws', () => {
    expect(() => summarizeWorksheetRecommendations(null)).not.toThrow();
    expect(summarizeWorksheetRecommendations(null)).toEqual({ recommendationCount: 0 });
    expect(summarizeWorksheetRecommendations(undefined)).toEqual({ recommendationCount: 0 });
  });
});
