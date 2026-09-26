const {
  computeTier1Trajectory,
  explainTier1,
  MAX_PROMPTS,
  WEIGHTS,
  T_FAST,
  T_STRUGGLING,
} = require('../tier1Scorer');

test('1. clearly fast input returns fast', () => {
  const result = computeTier1Trajectory({
    speech_score: 3,
    phoneme_accuracy: 0.95,
    echolalia_flag: false,
    prompt_count: 1,
    response_latency_ms_phase2: 500,
  });

  expect(result).toBe('fast');
});

test('2. clearly struggling input returns struggling', () => {
  const result = computeTier1Trajectory({
    speech_score: 0,
    phoneme_accuracy: 0.05,
    echolalia_flag: true,
    prompt_count: MAX_PROMPTS,
    response_latency_ms_phase2: 8000,
  });

  expect(result).toBe('struggling');
});

test('3. missing phoneme_accuracy does not throw/NaN and exercises reweighting', () => {
  const withPhoneme = computeTier1Trajectory({
    speech_score: 3,
    phoneme_accuracy: 1,
    echolalia_flag: false,
    prompt_count: 1,
    response_latency_ms_phase2: 500,
  });

  const withoutPhoneme = computeTier1Trajectory({
    speech_score: 3,
    // phoneme_accuracy omitted — abilities-category / non-verbal-attempt case
    echolalia_flag: false,
    prompt_count: 1,
    response_latency_ms_phase2: 500,
  });

  expect(withoutPhoneme).not.toBeNaN();
  expect(['fast', 'typical', 'struggling']).toContain(withoutPhoneme);
  // Dropping a term and redistributing its weight changes the blend versus
  // the all-terms-present case — proves reweighting actually ran, not just
  // that the missing value was silently ignored/zeroed without effect.
  expect(withoutPhoneme).not.toBe(undefined);
  expect(withPhoneme).toBe('fast');

  // A mid-range case where excluding phoneme_accuracy (a low value) versus
  // including it changes the resulting classification demonstrates the
  // redistribution is real, not a no-op.
  const midWithLowPhoneme = computeTier1Trajectory({
    speech_score: 2.4,
    phoneme_accuracy: 0.1,
    echolalia_flag: false,
    prompt_count: 1,
    response_latency_ms_phase2: 500,
  });
  const midWithoutPhoneme = computeTier1Trajectory({
    speech_score: 2.4,
    echolalia_flag: false,
    prompt_count: 1,
    response_latency_ms_phase2: 500,
  });
  expect(midWithoutPhoneme).not.toBe(midWithLowPhoneme);
});

test('4. fully-degenerate input (all terms missing) returns typical, not an error', () => {
  expect(() => computeTier1Trajectory({})).not.toThrow();
  expect(computeTier1Trajectory({})).toBe('typical');
  expect(() => computeTier1Trajectory(undefined)).not.toThrow();
  expect(computeTier1Trajectory(undefined)).toBe('typical');
});

test('5. missing echolalia_flag (not just phoneme_accuracy) also reweights without error', () => {
  const result = computeTier1Trajectory({
    speech_score: 3,
    phoneme_accuracy: 0.9,
    prompt_count: 1,
    response_latency_ms_phase2: 500,
    // echolalia_flag omitted entirely
  });

  expect(result).not.toBeNaN();
  expect(['fast', 'typical', 'struggling']).toContain(result);
});

test('6. mid-range score classifies as typical', () => {
  const result = computeTier1Trajectory({
    speech_score: 1.5,
    phoneme_accuracy: 0.5,
    echolalia_flag: false,
    prompt_count: 2,
    response_latency_ms_phase2: 4000,
  });

  expect(result).toBe('typical');
});

test('7. non-verbal correct answer scores as full speech credit, not speech_score/3', () => {
  // Same term composition in both (phoneme_accuracy/response_latency_ms_phase2
  // absent for both) — a fully-correct non-verbal answer should classify
  // identically to a fully-correct verbal one, not as if speech_score were 1/3.
  const nonVerbalCorrect = computeTier1Trajectory({
    speech_score: 1,
    match_type: 'non_verbal',
    echolalia_flag: false,
    prompt_count: 1,
  });
  const verbalEquivalent = computeTier1Trajectory({
    speech_score: 3,
    echolalia_flag: false,
    prompt_count: 1,
  });

  expect(nonVerbalCorrect).toBe(verbalEquivalent);
  expect(nonVerbalCorrect).toBe('fast');
});

test('8. non-verbal incorrect answer does not throw and reweights around missing phoneme/latency', () => {
  const result = computeTier1Trajectory({
    speech_score: 0,
    match_type: 'non_verbal',
    echolalia_flag: false,
    prompt_count: 3,
  });

  expect(result).not.toBeNaN();
  expect(['fast', 'typical', 'struggling']).toContain(result);
});

// ---------------------------------------------------------------------------
// TASK-43 — explainTier1
// ---------------------------------------------------------------------------

// AC5 — a fixed feature-payload corpus with the labels computeTier1Trajectory
// produced BEFORE TASK-43's buildTerms/labelForScore extraction (captured by
// running git HEAD's copy of the module). Any drift in the scoring arithmetic,
// including a floating-point shift from reordering the terms, fails here.
const AC5_CORPUS = [
  [{ speech_score: 3, phoneme_accuracy: 1, echolalia_flag: false, prompt_count: 1, response_latency_ms_phase2: 0, match_type: 'exact' }, 'fast'],
  [{ speech_score: 3, phoneme_accuracy: 0.81, echolalia_flag: false, prompt_count: 1, response_latency_ms_phase2: 1200, match_type: 'exact' }, 'fast'],
  [{ speech_score: 2, phoneme_accuracy: 0.81, echolalia_flag: false, prompt_count: 1, response_latency_ms_phase2: 1200, match_type: 'exact' }, 'fast'],
  [{ speech_score: 2, phoneme_accuracy: 0.5, echolalia_flag: false, prompt_count: 2, response_latency_ms_phase2: 4000, match_type: 'exact' }, 'typical'],
  [{ speech_score: 1, phoneme_accuracy: 0.5, echolalia_flag: false, prompt_count: 2, response_latency_ms_phase2: 4000, match_type: 'exact' }, 'typical'],
  [{ speech_score: 1, phoneme_accuracy: 0.22, echolalia_flag: true, prompt_count: 3, response_latency_ms_phase2: 8000, match_type: 'exact' }, 'struggling'],
  [{ speech_score: 0, phoneme_accuracy: 0, echolalia_flag: true, prompt_count: 3, response_latency_ms_phase2: 12000, match_type: 'exact' }, 'struggling'],
  [{ speech_score: 0, phoneme_accuracy: 0.5, echolalia_flag: false, prompt_count: 1, response_latency_ms_phase2: 1200, match_type: 'exact' }, 'typical'],
  [{ speech_score: 3, phoneme_accuracy: 0, echolalia_flag: true, prompt_count: 1, response_latency_ms_phase2: 0, match_type: 'exact' }, 'typical'],
  [{ speech_score: 1, echolalia_flag: false, prompt_count: 1, match_type: 'non_verbal' }, 'fast'],
  [{ speech_score: 0, echolalia_flag: false, prompt_count: 3, match_type: 'non_verbal' }, 'struggling'],
  [{ speech_score: 1, echolalia_flag: true, prompt_count: 2, match_type: 'non_verbal' }, 'typical'],
  [{ speech_score: 2.4, echolalia_flag: false, prompt_count: 1, response_latency_ms_phase2: 500 }, 'fast'],
  [{ speech_score: 2.4, phoneme_accuracy: 0.1, echolalia_flag: false, prompt_count: 1, response_latency_ms_phase2: 500 }, 'typical'],
  [{ speech_score: 3, phoneme_accuracy: 0.81, prompt_count: 1, response_latency_ms_phase2: 1200 }, 'fast'],
  [{ phoneme_accuracy: 0.5, echolalia_flag: false, prompt_count: 2, response_latency_ms_phase2: 4000 }, 'typical'],
  [{ speech_score: 2, phoneme_accuracy: 0.81, echolalia_flag: false }, 'fast'],
  [{ prompt_count: 3 }, 'struggling'],
  [{ echolalia_flag: true }, 'struggling'],
  [{ speech_score: 3, phoneme_accuracy: 1, echolalia_flag: false, prompt_count: 1, response_latency_ms_phase2: 12000, match_type: 'exact' }, 'fast'],
  [{ speech_score: 0, phoneme_accuracy: 0, echolalia_flag: false, prompt_count: 1, response_latency_ms_phase2: 0, match_type: 'exact' }, 'struggling'],
];

test('AC5. computeTier1Trajectory labels the fixed corpus exactly as it did before TASK-43', () => {
  for (const [features, expected] of AC5_CORPUS) {
    expect([JSON.stringify(features), computeTier1Trajectory(features)])
      .toEqual([JSON.stringify(features), expected]);
  }
});

test('AC4. explainTier1 contributions sum to the score, within 1e-9', () => {
  for (const [features] of AC5_CORPUS) {
    const e = explainTier1(features);
    if (!e.scored) continue;
    const sum = e.terms.reduce((acc, t) => acc + t.contribution, 0);
    expect(Math.abs(sum - e.score)).toBeLessThan(1e-9);
  }
});

test('AC4. explainTier1 reproduces computeTier1Trajectory\'s own internal score and label', () => {
  for (const [features, expected] of AC5_CORPUS) {
    const e = explainTier1(features);
    // The label explainTier1 derives from its decomposition must be the very
    // label the scorer returns — an explanation of a different verdict would be
    // worse than no explanation at all.
    expect(e.label).toBe(computeTier1Trajectory(features));
    expect(e.label).toBe(expected);
    if (e.scored) {
      // Independently re-derived here, not copied from the implementation.
      const total = e.terms.reduce((acc, t) => acc + t.weight, 0);
      const manual = e.terms.reduce((acc, t) => acc + (t.weight / total) * t.normalizedValue, 0);
      expect(Math.abs(manual - e.score)).toBeLessThan(1e-9);
    }
  }
});

test('AC4. explainTier1 never mutates or influences what computeTier1Trajectory returns', () => {
  for (const [features, expected] of AC5_CORPUS) {
    const snapshot = JSON.stringify(features);
    explainTier1(features);
    expect(JSON.stringify(features)).toBe(snapshot);
    expect(computeTier1Trajectory(features)).toBe(expected);
  }
});

test('9. explainTier1 reports every term with its raw input, weight and renormalized weight', () => {
  const e = explainTier1({
    speech_score: 2,
    phoneme_accuracy: 0.8,
    echolalia_flag: false,
    prompt_count: 2,
    response_latency_ms_phase2: 2000,
  });

  expect(e.terms.map((t) => t.term)).toEqual(['speech', 'phoneme', 'echolalia', 'prompt', 'latency']);
  expect(e.absentTerms).toEqual([]);
  expect(e.thresholds).toEqual({ fast: T_FAST, struggling: T_STRUGGLING });
  expect(e.scored).toBe(true);

  const speech = e.terms.find((t) => t.term === 'speech');
  expect(speech.input).toBe('speech_score');
  expect(speech.rawValue).toBe(2);
  expect(speech.normalizedValue).toBeCloseTo(2 / 3, 12);
  expect(speech.weight).toBe(WEIGHTS.speech);
  // All five terms present → no redistribution, so the renormalized weight is
  // the declared weight (the weights already sum to 1).
  expect(speech.renormalizedWeight).toBeCloseTo(WEIGHTS.speech, 12);
  expect(speech.contribution).toBeCloseTo(speech.renormalizedWeight * speech.normalizedValue, 12);
});

test('10. explainTier1 names the absent terms and shows their weight redistributed', () => {
  const e = explainTier1({
    speech_score: 3,
    echolalia_flag: false,
    prompt_count: 1,
    match_type: 'non_verbal',
  });

  // A teacher must be able to see that phoneme/latency were missing and that
  // the remaining terms silently absorbed their weight.
  expect(e.absentTerms.sort()).toEqual(['latency', 'phoneme']);
  const speech = e.terms.find((t) => t.term === 'speech');
  expect(speech.renormalizedWeight).toBeGreaterThan(speech.weight);

  const renormalizedTotal = e.terms.reduce((acc, t) => acc + t.renormalizedWeight, 0);
  expect(Math.abs(renormalizedTotal - 1)).toBeLessThan(1e-9);
});

test('11. explainTier1 on a fully-degenerate payload reports no score rather than inventing one', () => {
  for (const features of [{}, undefined]) {
    const e = explainTier1(features);
    expect(e.scored).toBe(false);
    expect(e.score).toBeNull();
    expect(e.terms).toEqual([]);
    expect(e.absentTerms.sort()).toEqual(['echolalia', 'latency', 'phoneme', 'prompt', 'speech']);
    // Matches computeTier1Trajectory's own degenerate default.
    expect(e.label).toBe('typical');
    expect(e.label).toBe(computeTier1Trajectory(features));
  }
});
