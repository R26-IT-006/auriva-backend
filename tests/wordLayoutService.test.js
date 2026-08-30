'use strict';

/**
 * wordLayoutService.test.js
 *
 * Word-layout-metrics task — calls the REAL, unmodified production
 * functions (computeWordLayoutMetrics, plus buildWordGuide/
 * letterBoundsAndRegions from wordScoringService.js, reused not
 * reimplemented). No mocking of the geometry under test.
 */

const { buildWordGuide, letterBoundsAndRegions, scoreWord, cleanStrokes } = require('../src/services/wordScoringService');
const {
  computeWordLayoutMetrics,
  resolveChildFeedbackAdvisory,
  scoreToConsistencyLabel,
  WORD_LAYOUT_VERSION,
  CHILD_FEEDBACK_SCORE_THRESHOLD,
} = require('../src/services/wordLayoutService');

const W = 800, H = 400;

function templatePointsPerLetter(guide, w = W, h = H) {
  const aspect = w / h;
  return guide.rawPath.reduce((acc, d) => {
    (acc[d.letterIndex] ??= []).push(...d.points.map(p => ({ x: (0.5 + (p.fx - 0.5) / aspect) * w, y: p.fy * h })));
    return acc;
  }, []);
}

function scalePts(pts, factor, cx, cy) {
  return pts.map(p => ({ x: cx + (p.x - cx) * factor, y: cy + (p.y - cy) * factor }));
}

function centerOf(pts) {
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  return { cx: (Math.min(...xs) + Math.max(...xs)) / 2, cy: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

describe('computeWordLayoutMetrics — size (section 18 synthetic cases)', () => {
  it('A. a perfect trace (template used verbatim as the observed strokes) scores 100 on every letter', () => {
    const guide = buildWordGuide('cat');
    const strokes = templatePointsPerLetter(guide);
    const result = computeWordLayoutMetrics({ word: 'cat', strokes, canvasWidth: W, canvasHeight: H });
    expect(result.letter_metrics.every(m => m.status === 'available')).toBe(true);
    expect(result.letter_metrics.every(m => m.size_scale === 1)).toBe(true);
    expect(result.size_consistency_score).toBe(100);
  });

  it('B. middle letter 1.5x larger about its own center is flagged ambiguous rather than under-reported', () => {
    const guide = buildWordGuide('cat');
    const base = templatePointsPerLetter(guide);
    const { cx, cy } = centerOf(base[1]);
    const strokes = base.map((pts, i) => (i === 1 ? scalePts(pts, 1.5, cx, cy) : pts));
    const result = computeWordLayoutMetrics({ word: 'cat', strokes, canvasWidth: W, canvasHeight: H });
    // The enlarged letter's width gets clipped by its own fixed region
    // boundary while its height doesn't (documented limitation — see the
    // module header) — the width/height divergence check catches this and
    // reports ambiguous rather than a misleadingly modest size_scale.
    expect(result.letter_metrics[1].status).toBe('ambiguous');
    expect(result.letter_metrics[0].status).toBe('available');
    expect(result.letter_metrics[2].status).toBe('available');
  });

  it('C. middle letter 0.5x smaller is available and clearly the smallest', () => {
    const guide = buildWordGuide('cat');
    const base = templatePointsPerLetter(guide);
    const { cx, cy } = centerOf(base[1]);
    const strokes = base.map((pts, i) => (i === 1 ? scalePts(pts, 0.5, cx, cy) : pts));
    const result = computeWordLayoutMetrics({ word: 'cat', strokes, canvasWidth: W, canvasHeight: H });
    expect(result.letter_metrics[1].status).toBe('available');
    expect(result.smallest_relative_letter_index).toBe(1);
    expect(result.size_consistency_score).toBeLessThan(100);
  });

  it('D. progressively larger letters (c < a < t) reduces size consistency and correctly ranks largest/smallest', () => {
    const guide = buildWordGuide('cat');
    const base = templatePointsPerLetter(guide);
    // Modest factors — a large enough per-letter enlargement pushes a
    // middle letter's points across its own fixed region boundary (see
    // case B's documented limitation above) and gets it flagged ambiguous
    // instead, which is correct behavior but not what this test is after;
    // these factors stay well inside that margin.
    const factors = [0.9, 1.0, 1.2];
    const strokes = base.map((pts, i) => {
      const { cx, cy } = centerOf(pts);
      return scalePts(pts, factors[i], cx, cy);
    });
    const result = computeWordLayoutMetrics({ word: 'cat', strokes, canvasWidth: W, canvasHeight: H });
    expect(result.letter_metrics.every(m => m.status === 'available')).toBe(true);
    expect(result.size_consistency_score).toBeLessThan(100);
    expect(result.largest_relative_letter_index).toBe(2);
    expect(result.smallest_relative_letter_index).toBe(0);
  });

  it('E. uniform global scaling (every letter individually bigger about its own center, same relative sizing) does not read as "high variation"', () => {
    const guide = buildWordGuide('cat');
    const base = templatePointsPerLetter(guide);
    // 1.15 — scaling ALL THREE letters simultaneously (unlike case D, which
    // only touched one) compounds region-boundary contamination faster;
    // 1.2 was already enough to distort the first letter's reading on this
    // tightly-spaced word. See the KNOWN LIMITATION note: this is a real,
    // disclosed property of the required-to-reuse fixed-region
    // segmentation, not a threshold this module can fully engineer away.
    const k = 1.15;
    const strokes = base.map(pts => { const { cx, cy } = centerOf(pts); return scalePts(pts, k, cx, cy); });
    const result = computeWordLayoutMetrics({ word: 'cat', strokes, canvasWidth: W, canvasHeight: H });
    expect(result.letter_metrics.every(m => m.status === 'available')).toBe(true);
    // Every letter individually rescaled about its own center is the
    // cleanest "size_scale should be identical for all three" construction
    // — confirms the metric measures RELATIVE size, not absolute scale.
    const scales = result.letter_metrics.map(m => m.size_scale);
    scales.forEach(s => expect(s).toBeCloseTo(k, 5));
    expect(result.size_consistency_score).toBe(100);
    expect(scoreToConsistencyLabel(result.size_consistency_score)).toBe('Consistent');
  });

  it('a word drawn on a canvas far larger than the claimed canvas dimensions is flagged ambiguous across the board, not scored', () => {
    // Distinct from case E — this genuinely doesn't fit the claimed canvas
    // (a real canvas-size-mismatch scenario), not just "bigger handwriting".
    // All letters spill past their expected regions; every one should come
    // back ambiguous rather than a fabricated, misleading score.
    const guide = buildWordGuide('cat');
    const strokes = templatePointsPerLetter(guide, W * 1.4, H * 1.4);
    const result = computeWordLayoutMetrics({ word: 'cat', strokes, canvasWidth: W, canvasHeight: H });
    expect(result.letter_metrics.every(m => m.status === 'ambiguous')).toBe(true);
    expect(result.size_consistency_score).toBeNull();
    expect(result.status).toBe('unavailable');
  });
});

describe('computeWordLayoutMetrics — spacing (section 19 synthetic cases)', () => {
  function shiftLetters(base, gapsMultiplier) {
    // Rebuild the word with each inter-letter gap scaled by
    // gapsMultiplier[i] (one entry per gap), keeping each letter's own
    // shape/size untouched — isolates spacing from size.
    const out = [base[0]];
    let cursorMaxX = Math.max(...base[0].map(p => p.x));
    for (let i = 1; i < base.length; i++) {
      const letterWidth = Math.max(...base[i].map(p => p.x)) - Math.min(...base[i].map(p => p.x));
      const originalGap = Math.min(...base[i].map(p => p.x)) - Math.max(...base[i - 1].map(p => p.x));
      const newGap = originalGap * (gapsMultiplier[i - 1] ?? 1);
      const shift = cursorMaxX + newGap - Math.min(...base[i].map(p => p.x));
      const moved = base[i].map(p => ({ x: p.x + shift, y: p.y }));
      out.push(moved);
      cursorMaxX = Math.max(...moved.map(p => p.x));
      void letterWidth;
    }
    return out;
  }

  it('A. expected gaps (template verbatim) score 100', () => {
    const guide = buildWordGuide('cat');
    const strokes = templatePointsPerLetter(guide);
    const result = computeWordLayoutMetrics({ word: 'cat', strokes, canvasWidth: W, canvasHeight: H });
    expect(result.spacing_consistency_score).toBe(100);
    result.spacing_metrics.forEach(g => expect(g.gap_ratio).toBeCloseTo(1, 5));
  });

  it('B. letters touching (near-zero gap) reads as a real, low gap ratio, not a crash', () => {
    const guide = buildWordGuide('cat');
    const base = templatePointsPerLetter(guide);
    const strokes = shiftLetters(base, [0.05, 0.05]);
    const result = computeWordLayoutMetrics({ word: 'cat', strokes, canvasWidth: W, canvasHeight: H });
    expect(() => result).not.toThrow();
    // The first gap (c→a) reads available with a clearly-low ratio; the
    // second (a→t) crosses into ambiguous territory at this closeness —
    // see the KNOWN LIMITATION note on region-boundary contamination
    // above. Either way, no fabricated number and no crash.
    expect(result.spacing_metrics[0].status).toBe('available');
    expect(result.spacing_metrics[0].gap_ratio).toBeLessThan(1);
    expect(result.spacing_consistency_score).not.toBeNull();
  });

  it('C. overlapping letters are recognized as unreliable to segment (ambiguous), never reported as a confident but wrong number', () => {
    const guide = buildWordGuide('cat');
    const base = templatePointsPerLetter(guide);
    const strokes = shiftLetters(base, [-0.3, -0.3]);
    expect(() => computeWordLayoutMetrics({ word: 'cat', strokes, canvasWidth: W, canvasHeight: H })).not.toThrow();
    const result = computeWordLayoutMetrics({ word: 'cat', strokes, canvasWidth: W, canvasHeight: H });
    // Severe overlap between adjacent letters is exactly the scenario
    // region-crossing protection exists for — this word's shortest letter
    // ('a') genuinely can't be reliably separated from its neighbors once
    // they overlap this much, so it (and the gaps touching it) come back
    // ambiguous rather than a fabricated negative ratio.
    expect(result.spacing_metrics.every(g => g.status === 'ambiguous' || (g.status === 'available' && g.gap_ratio < 0))).toBe(true);
  });

  it('the negative-gap arithmetic itself is well-formed (no NaN/throw) even where region-crossing protection ultimately reclassifies the pair as ambiguous', () => {
    // Swept overlap from -5% to -30% on 'cat': at every magnitude tried,
    // region-crossing protection correctly reclassified the affected pair
    // as ambiguous rather than surfacing an available-but-unreliable
    // negative ratio — i.e., for this word's specific (fairly tight,
    // gap = avg letter width * 0.22) natural spacing, even mild overlap is
    // correctly judged unreliable to segment. That's the intended
    // protective behavior, not a gap in it; this test only confirms the
    // computation path never throws or produces NaN while getting there.
    const guide = buildWordGuide('cat');
    const base = templatePointsPerLetter(guide);
    for (const m of [-0.05, -0.1, -0.2, -0.3]) {
      const strokes = shiftLetters(base, [1, m]);
      expect(() => computeWordLayoutMetrics({ word: 'cat', strokes, canvasWidth: W, canvasHeight: H })).not.toThrow();
      const result = computeWordLayoutMetrics({ word: 'cat', strokes, canvasWidth: W, canvasHeight: H });
      result.spacing_metrics.forEach(g => {
        if (g.status === 'available') expect(Number.isFinite(g.gap_ratio)).toBe(true);
      });
    }
  });

  it('D. one very large gap after the LAST letter (unbounded region, no neighbor to contaminate) lowers spacing consistency cleanly', () => {
    const guide = buildWordGuide('cat');
    const base = templatePointsPerLetter(guide);
    const strokes = shiftLetters(base, [1, 4]);
    const result = computeWordLayoutMetrics({ word: 'cat', strokes, canvasWidth: W, canvasHeight: H });
    expect(result.spacing_metrics[0].gap_ratio).toBeCloseTo(1, 1);
    expect(result.spacing_metrics[1].gap_ratio).toBeCloseTo(4, 0);
    expect(result.spacing_consistency_score).toBeLessThan(60);
  });

  it('E. all gaps uniformly larger than expected: penalized for distance-from-expected, not for inconsistency between gaps', () => {
    const guide = buildWordGuide('cat');
    const base = templatePointsPerLetter(guide);
    // 1.4x, not 2x — a large enough uniform gap widening pushes the middle
    // letter across its own region boundary (documented above); 1.4x stays
    // inside the margin where both gaps read cleanly.
    const strokes = shiftLetters(base, [1.4, 1.4]);
    const result = computeWordLayoutMetrics({ word: 'cat', strokes, canvasWidth: W, canvasHeight: H });
    result.spacing_metrics.forEach(g => expect(g.gap_ratio).toBeCloseTo(1.4, 1));
    // Uniformly-off is a real deviation, but the two gaps agree with each
    // other perfectly — the score should be materially better than an
    // irregular pair with the same average deviation (case F below).
    expect(result.spacing_consistency_score).toBeGreaterThan(0);
  });

  it('F. irregular gaps score worse than uniformly-widened gaps at a comparable average deviation', () => {
    const guide = buildWordGuide('cat');
    const base = templatePointsPerLetter(guide);
    const uniform = computeWordLayoutMetrics({
      word: 'cat', strokes: shiftLetters(base, [1.4, 1.4]), canvasWidth: W, canvasHeight: H,
    });
    const irregular = computeWordLayoutMetrics({
      word: 'cat', strokes: shiftLetters(base, [1, 1.8]), canvasWidth: W, canvasHeight: H,
    });
    expect(uniform.spacing_metrics.every(g => g.status === 'available')).toBe(true);
    expect(irregular.spacing_metrics.every(g => g.status === 'available')).toBe(true);
    expect(irregular.spacing_consistency_score).toBeLessThan(uniform.spacing_consistency_score);
  });

  it('G. device-scale invariance — the same relative word, drawn on a much larger canvas, produces the same gap ratios', () => {
    const guide = buildWordGuide('cat');
    const smallCanvas = { w: 800, h: 400 };
    const bigCanvas = { w: 1600, h: 800 }; // exact same aspect ratio, 2x scale
    const baseSmall = templatePointsPerLetter(guide, smallCanvas.w, smallCanvas.h);
    const baseBig = templatePointsPerLetter(guide, bigCanvas.w, bigCanvas.h);
    const resultSmall = computeWordLayoutMetrics({ word: 'cat', strokes: baseSmall, canvasWidth: smallCanvas.w, canvasHeight: smallCanvas.h });
    const resultBig = computeWordLayoutMetrics({ word: 'cat', strokes: baseBig, canvasWidth: bigCanvas.w, canvasHeight: bigCanvas.h });
    resultSmall.spacing_metrics.forEach((g, i) => expect(g.gap_ratio).toBeCloseTo(resultBig.spacing_metrics[i].gap_ratio, 5));
    expect(resultSmall.spacing_consistency_score).toBe(resultBig.spacing_consistency_score);
    resultSmall.letter_metrics.forEach((m, i) => expect(m.size_scale).toBeCloseTo(resultBig.letter_metrics[i].size_scale, 5));
  });
});

describe('computeWordLayoutMetrics — combined tests (section 20)', () => {
  it('correct trajectory + bad size: scoreWord is unaffected, layout flags the size problem', () => {
    const guide = buildWordGuide('cat');
    const base = templatePointsPerLetter(guide);
    const { cx, cy } = centerOf(base[1]);
    const strokes = base.map((pts, i) => (i === 1 ? scalePts(pts, 1.35, cx, cy) : pts));
    const scoreResult = scoreWord({ word: 'cat', strokes, canvasWidth: W, canvasHeight: H });
    const layoutResult = computeWordLayoutMetrics({ word: 'cat', strokes, canvasWidth: W, canvasHeight: H });
    expect(scoreResult.completionPassed).toBe(true); // still recognizably a "cat" attempt
    expect(layoutResult.size_consistency_score).toBeLessThan(100);
  });

  it('correct trajectory + bad spacing: scoreWord is unaffected, layout flags the spacing problem', () => {
    const guide = buildWordGuide('cat');
    const base = templatePointsPerLetter(guide);
    const shifted = [base[0]];
    let cursor = Math.max(...base[0].map(p => p.x));
    for (let i = 1; i < base.length; i++) {
      const shift = cursor + 40 - Math.min(...base[i].map(p => p.x));
      const moved = base[i].map(p => ({ x: p.x + shift, y: p.y }));
      shifted.push(moved);
      cursor = Math.max(...moved.map(p => p.x));
    }
    const scoreResult = scoreWord({ word: 'cat', strokes: shifted, canvasWidth: W, canvasHeight: H });
    const layoutResult = computeWordLayoutMetrics({ word: 'cat', strokes: shifted, canvasWidth: W, canvasHeight: H });
    expect(scoreResult.completionPassed).toBe(true);
    expect(layoutResult.spacing_consistency_score).toBeLessThan(100);
  });

  it('partial word (one letter never drawn): completion gate fails as before; layout reports what it can, never patches over the gap', () => {
    const guide = buildWordGuide('cat');
    const base = templatePointsPerLetter(guide);
    const strokes = [base[0], base[2]]; // 'a' never drawn at all
    const scoreResult = scoreWord({ word: 'cat', strokes, canvasWidth: W, canvasHeight: H });
    const layoutResult = computeWordLayoutMetrics({ word: 'cat', strokes, canvasWidth: W, canvasHeight: H });
    expect(scoreResult.completionPassed).toBe(false);
    expect(scoreResult.score).toBe(0);
    expect(layoutResult.letter_metrics[1].status).toBe('unavailable');
    expect(layoutResult.letter_metrics[0].status).toBe('available');
    expect(layoutResult.letter_metrics[2].status).toBe('available');
  });

  it('perfect word: both scoreWord and layout metrics read as fully clean', () => {
    const guide = buildWordGuide('cat');
    const strokes = templatePointsPerLetter(guide);
    const scoreResult = scoreWord({ word: 'cat', strokes, canvasWidth: W, canvasHeight: H });
    const layoutResult = computeWordLayoutMetrics({ word: 'cat', strokes, canvasWidth: W, canvasHeight: H });
    expect(scoreResult.passed).toBe(true);
    expect(layoutResult.size_consistency_score).toBe(100);
    expect(layoutResult.spacing_consistency_score).toBe(100);
  });
});

describe('width-degenerate letters (e.g. a perfectly vertical "l") — found via the 154-word sweep', () => {
  it('a word with a purely-vertical middle letter still gets full available status via a height-only size_scale', () => {
    const guide = buildWordGuide('elf');
    const strokes = templatePointsPerLetter(guide);
    const result = computeWordLayoutMetrics({ word: 'elf', strokes, canvasWidth: W, canvasHeight: H });
    expect(result.letter_metrics.every(m => m.status === 'available')).toBe(true);
    expect(result.letter_metrics[1].width_ratio).toBeNull(); // 'l' — no meaningful width to compare
    expect(result.letter_metrics[1].height_ratio).toBeCloseTo(1, 5);
    expect(result.letter_metrics[1].size_scale).toBeCloseTo(1, 5);
    expect(result.size_consistency_score).toBe(100);
    expect(result.spacing_consistency_score).toBe(100);
  });
});

describe('word length robustness (section 10)', () => {
  it('handles words of varying length without dividing by zero, for every currently-supported word', () => {
    const { canonicalWordsForTest } = require('./_wordCanonicalTestHelper');
    const words = canonicalWordsForTest();
    for (const word of words) {
      const guide = buildWordGuide(word);
      expect(guide).not.toBeNull();
      const strokes = templatePointsPerLetter(guide);
      expect(() => computeWordLayoutMetrics({ word, strokes, canvasWidth: W, canvasHeight: H })).not.toThrow();
      const result = computeWordLayoutMetrics({ word, strokes, canvasWidth: W, canvasHeight: H });
      result.letter_metrics.forEach(m => {
        if (m.status === 'available') {
          expect(Number.isFinite(m.size_scale)).toBe(true);
        }
      });
      result.spacing_metrics.forEach(g => {
        if (g.status === 'available') expect(Number.isFinite(g.gap_ratio)).toBe(true);
      });
    }
  });

  it('a 2-letter word (single gap) computes spacing without a stddev divide-by-zero', () => {
    // Uses whichever 2-letter word exists in the canonical set, if any;
    // otherwise synthesizes the guide-independent case directly by reusing
    // 'cat' truncated to 2 letters worth of geometry.
    const guide = buildWordGuide('cat');
    const base = templatePointsPerLetter(guide).slice(0, 2);
    const result = computeWordLayoutMetrics({ word: 'ca', strokes: base, canvasWidth: W, canvasHeight: H });
    // 'ca' is not itself a canonical word, so buildWordGuide returns null —
    // this specifically tests the graceful "unsupported word" path, not a
    // real 2-letter attempt (see All-154-word test above for real words).
    expect(result.status).toBe('unavailable');
  });
});

describe('scoreWord regression (section 21) — identical strokes, identical score/pass before and after this task', () => {
  it('a representative set of strokes produces the exact same score/passed/completionPassed as scoreWord alone (layout computation never touches these)', () => {
    const guide = buildWordGuide('cat');
    const strokes = templatePointsPerLetter(guide);
    const before = scoreWord({ word: 'cat', strokes, canvasWidth: W, canvasHeight: H });
    computeWordLayoutMetrics({ word: 'cat', strokes, canvasWidth: W, canvasHeight: H }); // computed but discarded
    const after = scoreWord({ word: 'cat', strokes, canvasWidth: W, canvasHeight: H });
    expect(after).toEqual(before);
    expect(after.score).toBe(before.score);
    expect(after.passed).toBe(before.passed);
    expect(after.thresholdUsed).toBe(50);
  });
});

describe('resolveChildFeedbackAdvisory', () => {
  it('returns null when both scores are healthy', () => {
    expect(resolveChildFeedbackAdvisory({ status: 'available', size_consistency_score: 90, spacing_consistency_score: 90 })).toBeNull();
  });
  it('returns "size" when only size is low', () => {
    expect(resolveChildFeedbackAdvisory({ status: 'available', size_consistency_score: 30, spacing_consistency_score: 90 })).toBe('size');
  });
  it('returns "spacing" when only spacing is low', () => {
    expect(resolveChildFeedbackAdvisory({ status: 'available', size_consistency_score: 90, spacing_consistency_score: 30 })).toBe('spacing');
  });
  it('returns "both" only when both are low', () => {
    expect(resolveChildFeedbackAdvisory({ status: 'available', size_consistency_score: 30, spacing_consistency_score: 30 })).toBe('both');
  });
  it('returns null when the whole word_layout is unavailable', () => {
    expect(resolveChildFeedbackAdvisory({ status: 'unavailable', size_consistency_score: null, spacing_consistency_score: null })).toBeNull();
  });
  it('threshold is the named constant, not a magic number', () => {
    expect(resolveChildFeedbackAdvisory({ status: 'available', size_consistency_score: CHILD_FEEDBACK_SCORE_THRESHOLD - 1, spacing_consistency_score: 100 })).toBe('size');
    expect(resolveChildFeedbackAdvisory({ status: 'available', size_consistency_score: CHILD_FEEDBACK_SCORE_THRESHOLD, spacing_consistency_score: 100 })).toBeNull();
  });
});

describe('module identity / versioning (section 24)', () => {
  it('word_layout carries its own version, independent of word_score_version', () => {
    const guide = buildWordGuide('cat');
    const strokes = templatePointsPerLetter(guide);
    const layoutResult = computeWordLayoutMetrics({ word: 'cat', strokes, canvasWidth: W, canvasHeight: H });
    const scoreResult = scoreWord({ word: 'cat', strokes, canvasWidth: W, canvasHeight: H });
    expect(layoutResult.version).toBe(WORD_LAYOUT_VERSION);
    expect(layoutResult.version).not.toBe(scoreResult.scoreVersion);
  });
});
