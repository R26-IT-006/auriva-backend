const { computeTier1Trajectory, MAX_PROMPTS } = require('../tier1Scorer');

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
