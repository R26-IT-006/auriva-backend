'use strict';

/**
 * attemptCoverageValidity.test.js
 *
 * Coverage-fix audit — calls the REAL, unmodified production functions, no
 * reimplementation.
 */

const {
  isAttemptCoverageValid,
  getDrawingBounds,
  computeCoverageFilteredBestScore,
} = require('../src/utils/attemptCoverageValidity');

const CANVAS_W = 400;
const CANVAS_H = 300;

// A trace that clearly clears both bounds: long enough path length, and
// wide/tall enough bounding box.
function bigDrawing() {
  const points = [];
  for (let i = 0; i <= 50; i++) {
    points.push({ x: 20 + i * 6, y: 150 + Math.sin(i / 5) * 60, t: i * 10 });
  }
  return [{ stroke_id: 1, points }];
}

// A tiny scribble — short path length, small bounding box on both axes.
function tinyDrawing() {
  return [{ stroke_id: 1, points: [
    { x: 200, y: 150, t: 0 }, { x: 202, y: 151, t: 10 }, { x: 201, y: 149, t: 20 },
  ] }];
}

describe('isAttemptCoverageValid', () => {
  it('a real, full-size drawing is valid', () => {
    expect(isAttemptCoverageValid(bigDrawing(), CANVAS_W, CANVAS_H)).toBe(true);
  });

  it('a tiny scribble fails coverage', () => {
    expect(isAttemptCoverageValid(tinyDrawing(), CANVAS_W, CANVAS_H)).toBe(false);
  });

  it('missing canvasWidth returns null (undeterminable), not a guessed boolean', () => {
    expect(isAttemptCoverageValid(bigDrawing(), null, CANVAS_H)).toBeNull();
    expect(isAttemptCoverageValid(bigDrawing(), undefined, CANVAS_H)).toBeNull();
    expect(isAttemptCoverageValid(bigDrawing(), 0, CANVAS_H)).toBeNull();
  });

  it('missing canvasHeight returns null (undeterminable), not a guessed boolean', () => {
    expect(isAttemptCoverageValid(bigDrawing(), CANVAS_W, null)).toBeNull();
    expect(isAttemptCoverageValid(bigDrawing(), CANVAS_W, undefined)).toBeNull();
  });

  it('empty strokes fail coverage (zero length/width/height) when dimensions are known', () => {
    expect(isAttemptCoverageValid([], CANVAS_W, CANVAS_H)).toBe(false);
  });

  it('accepts the flat [{x,y}] shape as well as [{stroke_id,points}]', () => {
    const flat = bigDrawing()[0].points;
    expect(isAttemptCoverageValid(flat, CANVAS_W, CANVAS_H)).toBe(true);
  });
});

describe('getDrawingBounds', () => {
  it('computes length/width/height across all points, all strokes', () => {
    const bounds = getDrawingBounds(bigDrawing());
    expect(bounds.length).toBeGreaterThan(0);
    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.height).toBeGreaterThan(0);
  });

  it('empty input returns all zeros, never throws', () => {
    expect(getDrawingBounds([])).toEqual({ length: 0, width: 0, height: 0 });
  });
});

describe('computeCoverageFilteredBestScore', () => {
  it('excludes a coverage-invalid attempt from bestScore, even though it has the higher raw score', () => {
    const result = computeCoverageFilteredBestScore({
      attemptScores: [60, 95], // attempt 2's raw score is higher...
      attempts: [
        { strokes: bigDrawing() },  // ...but attempt 2's drawing is a tiny scribble
        { strokes: tinyDrawing() },
      ],
      canvasWidth: CANVAS_W, canvasHeight: CANVAS_H,
    });
    expect(result.bestScore).toBe(60); // the valid attempt wins, not the higher-scoring invalid one
    expect(result.skippedForMismatch).toBe(false);
  });

  it('bestScore is null when every attempt fails coverage', () => {
    const result = computeCoverageFilteredBestScore({
      attemptScores: [80, 90],
      attempts: [{ strokes: tinyDrawing() }, { strokes: tinyDrawing() }],
      canvasWidth: CANVAS_W, canvasHeight: CANVAS_H,
    });
    expect(result.bestScore).toBeNull();
    expect(result.skippedForMismatch).toBe(false);
  });

  it('fails open (identical to the pre-fix Math.max behavior) when attempt_scores and attempts are different lengths', () => {
    const result = computeCoverageFilteredBestScore({
      attemptScores: [40, 70, 90], // 3 scores...
      attempts: [{ strokes: tinyDrawing() }], // ...but only 1 attempt record — index alignment broken
      canvasWidth: CANVAS_W, canvasHeight: CANVAS_H,
    });
    expect(result.bestScore).toBe(90); // reverts to plain Math.max — the coverage filter never runs
    expect(result.skippedForMismatch).toBe(true);
  });

  it('fails open on mismatch even when attempts is missing entirely', () => {
    const result = computeCoverageFilteredBestScore({
      attemptScores: [55, 65],
      attempts: undefined,
      canvasWidth: CANVAS_W, canvasHeight: CANVAS_H,
    });
    expect(result.bestScore).toBe(65);
    expect(result.skippedForMismatch).toBe(true);
  });

  it('an attempt with undeterminable coverage (missing canvas dims) counts as valid, not excluded', () => {
    const result = computeCoverageFilteredBestScore({
      attemptScores: [72, 88],
      attempts: [{ strokes: tinyDrawing() }, { strokes: tinyDrawing() }],
      canvasWidth: null, canvasHeight: null, // coverage can't be determined at all
    });
    expect(result.bestScore).toBe(88); // both treated as valid — same as pre-fix behavior
    expect(result.skippedForMismatch).toBe(false);
  });

  it('no attempts at all: bestScore is null, not a crash', () => {
    const result = computeCoverageFilteredBestScore({
      attemptScores: [], attempts: [], canvasWidth: CANVAS_W, canvasHeight: CANVAS_H,
    });
    expect(result.bestScore).toBeNull();
    expect(result.skippedForMismatch).toBe(false); // 0 === 0, lengths do match
  });
});
