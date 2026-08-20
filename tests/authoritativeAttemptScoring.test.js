'use strict';

// Motor Score Unification, Phase 1 — proves computeAuthoritativeBestScore()
// is genuinely backend-computed (not a pass-through of any client value)
// and preserves the pre-existing coverage-eligibility rule exactly.
const { computeAuthoritativeBestScore } = require('../src/utils/authoritativeAttemptScoring');

const CANVAS_W = 300;
const CANVAS_H = 300;

// A stroke path with plenty of length/spread to pass the coverage check
// (length >= canvasHeight*0.25=75, and width|height >= 10%|15% of canvas).
// Real stroke_points shape: [{stroke_id, points:[{x,y,t,tAbs}, ...]}] — see
// attemptCoverageValidity.js's/motorScore.js's own flattenStrokePoints().
function goodCoverageStroke() {
  const pts = [];
  for (let i = 0; i <= 40; i++) pts.push({ x: 20 + i * 5, y: 20 + i * 4, t: i * 20, tAbs: 1700000000000 + i * 20 });
  return [{ stroke_id: 0, points: pts }];
}

// A tiny, localized scribble — fails the coverage/geometry check.
function tinyStroke() {
  return [{ stroke_id: 0, points: [
    { x: 10, y: 10, t: 0, tAbs: 1700000000000 },
    { x: 11, y: 10, t: 20, tAbs: 1700000000020 },
    { x: 11, y: 11, t: 40, tAbs: 1700000000040 },
  ] }];
}

function makeAttempt({ strokes, smoothness = 0.05, dtw_distance = 5, pause_count = 0, direction_score = 90, avg_speed = 0.2 } = {}) {
  return {
    strokes: strokes ?? goodCoverageStroke(),
    features: { smoothness, dtw_distance, pause_count, direction_score, avg_speed },
  };
}

describe('computeAuthoritativeBestScore — backend-computed, never client-supplied', () => {
  it('computes a real motor score purely from features/strokes, independent of any client score field', () => {
    const result = computeAuthoritativeBestScore({
      attempts: [makeAttempt()],
      canvasWidth: CANVAS_W, canvasHeight: CANVAS_H,
    });
    expect(result.bestScore).toEqual(expect.any(Number));
    expect(result.bestScore).toBeGreaterThan(0);
    expect(result.attemptScores).toHaveLength(1);
  });

  it('takes the MAX across multiple eligible attempts, matching the pre-existing bestScore semantics', () => {
    const result = computeAuthoritativeBestScore({
      attempts: [
        makeAttempt({ smoothness: 0.5, dtw_distance: 30 }),   // worse
        makeAttempt({ smoothness: 0.02, dtw_distance: 3 }),   // better
        makeAttempt({ smoothness: 0.3, dtw_distance: 15 }),   // middle
      ],
      canvasWidth: CANVAS_W, canvasHeight: CANVAS_H,
    });
    expect(result.bestScore).toBe(Math.max(...result.attemptScores.filter((s) => s != null)));
    expect(result.attemptScores[1]).toBeGreaterThan(result.attemptScores[0]);
  });

  it('excludes an attempt that fails the coverage/geometry check — same rule as before unification', () => {
    const result = computeAuthoritativeBestScore({
      attempts: [
        makeAttempt({ strokes: tinyStroke() }),   // fails coverage
        makeAttempt(),                             // passes coverage
      ],
      canvasWidth: CANVAS_W, canvasHeight: CANVAS_H,
    });
    expect(result.attemptScores[0]).toBeNull();
    expect(result.attemptScores[1]).not.toBeNull();
    expect(result.eligibleCount).toBe(1);
  });

  it('fails OPEN (never excludes) when canvas dimensions are missing — same fail-open rule as before', () => {
    const result = computeAuthoritativeBestScore({
      attempts: [makeAttempt({ strokes: tinyStroke() })],
      canvasWidth: null, canvasHeight: null,
    });
    expect(result.attemptScores[0]).not.toBeNull(); // coverage undeterminable -> not excluded
  });

  it('an empty attempts array yields bestScore: null, never a fabricated value', () => {
    const result = computeAuthoritativeBestScore({ attempts: [], canvasWidth: CANVAS_W, canvasHeight: CANVAS_H });
    expect(result.bestScore).toBeNull();
    expect(result.eligibleCount).toBe(0);
  });

  it('an attempt with no strokes and no features at all yields a null per-attempt score, excluded from bestScore', () => {
    const result = computeAuthoritativeBestScore({
      attempts: [{ strokes: [], features: {} }],
      canvasWidth: CANVAS_W, canvasHeight: CANVAS_H,
    });
    expect(result.attemptScores[0]).toBeNull();
    expect(result.bestScore).toBeNull();
  });

  it('geometry alone (empty declared features, real strokes) can still yield a derivable score — direction/speed/pause are computed from stroke geometry, not solely from the features object', () => {
    const result = computeAuthoritativeBestScore({
      attempts: [{ strokes: goodCoverageStroke(), features: {} }],
      canvasWidth: CANVAS_W, canvasHeight: CANVAS_H,
    });
    expect(result.attemptScores[0]).not.toBeNull();
  });

  it('SECURITY: the result depends only on features/strokes — a caller cannot influence bestScore by adding an unrelated field (e.g. a spoofed score) to the attempt object', () => {
    const attempt = makeAttempt();
    const spoofed = { ...attempt, score: 100, motor_score: 100, best_score: 100, override: true };
    const a = computeAuthoritativeBestScore({ attempts: [attempt], canvasWidth: CANVAS_W, canvasHeight: CANVAS_H });
    const b = computeAuthoritativeBestScore({ attempts: [spoofed], canvasWidth: CANVAS_W, canvasHeight: CANVAS_H });
    expect(a.bestScore).toBe(b.bestScore);
  });
});
