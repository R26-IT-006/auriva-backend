'use strict';

/**
 * wordLayoutService.js
 *
 * Word-writing layout analysis — two research measurements ADDITIVE to the
 * existing authoritative word scoring in wordScoringService.js:
 *   1. letter-size inconsistency (one letter disproportionately larger/
 *      smaller than ITS OWN expected template size)
 *   2. inter-letter spacing difficulty (gaps too tight, too wide, or
 *      inconsistent relative to the canonical word's own expected gap)
 *
 * Deliberately reuses wordScoringService.js's own geometry rather than
 * duplicating it: buildWordGuide() (canonical word template) and
 * letterBoundsAndRegions() (the SAME per-letter expected bounding boxes and
 * x-coordinate regions scoreWord() uses for its completion-coverage check)
 * are imported, not reimplemented. Region assignment (which observed points
 * belong to which letter) uses the exact same half-open x-interval test
 * scoreWord()'s own coverage check uses (`x >= region.min && x < region.max`).
 *
 * Pure computation, no DB/network I/O. Never influences score, passed, or
 * completion_passed — those remain scoreWord()'s exclusive responsibility.
 * This module's output is informational only (see handwritingController.js/
 * wordWritingService.js for where it's persisted, never gated on).
 *
 * Normalization: buildWordGuide()'s x-coordinate conversion already applies
 * an aspect-ratio correction (`x = 0.5*w + (fx-0.5)*h`, i.e. x-distances are
 * effectively scaled by canvas HEIGHT, not width — the same convention this
 * whole codebase already uses, e.g. ShapeAssessmentScreen's aspectX/
 * LetterWritingScreen's aspectX). That means both x-based (width/gap) and
 * y-based (height) pixel measurements share one natural normalizing
 * divisor: canvas height. Dividing any pixel measurement by `canvasHeight`
 * yields a device- and canvas-size-independent value directly comparable
 * across attempts/devices — this is what `*_normalized` fields below store.
 * Ratios (width_ratio, height_ratio, gap_ratio) are already device-
 * independent without any normalization (both operands come from the same
 * canvas), computed straight from the raw pixel values.
 */

const { buildWordGuide, letterBoundsAndRegions, cleanStrokes } = require('./wordScoringService');

const WORD_LAYOUT_VERSION = 'word_layout_v1';

// ── Named config — pilot/engineering defaults, NOT clinically validated.
// Calibrated against the synthetic test fixtures in
// tests/wordLayoutService.test.js (see that file for the worked numbers
// behind each constant) — not against real collected data, since none
// exists yet for this brand-new metric. Revisit once real word-writing
// attempts accumulate. ──────────────────────────────────────────────────

// Fewer than this many observed points in a letter's assigned region means
// there isn't enough there to trust ANY bounding box from it at all.
const MIN_POINTS_FOR_LETTER_BBOX = 2;

// A region-crossing safety margin: if a letter's observed bounding-box
// width exceeds its own assigned region's width by more than this factor,
// the observed strokes plausibly spilled into a neighboring letter's
// territory — flag ambiguous rather than trust the number.
const REGION_CROSS_WIDTH_MULTIPLIER = 1.6;

// The first and last letters have one open (+/-Infinity) region edge, so
// "region width" isn't defined for the sanity check above. Use this
// multiple of the letter's own EXPECTED (template) width as the substitute
// cap instead  -  generous enough to allow a genuinely large but real letter,
// tight enough to catch a scrawl that plausibly bled across the boundary.
const EDGE_REGION_WIDTH_FALLBACK_MULTIPLIER = 2.2;

// Third region-crossing signal (see the letterMetrics loop): the ratio
// between a letter's width_ratio and height_ratio, whichever is larger over
// whichever is smaller. Calibrated so a uniformly-scaled letter's natural
// noise floor (~1.0-1.3, observed when a whole word is rescaled about its
// own center — width/height clip slightly differently against fixed region
// boundaries even with no real size problem) passes, while a genuinely
// clipped middle letter (~1.9 in this module's own synthetic test) is
// caught. Narrow margin on both sides — revisit once tested against the
// full word catalogue and real data.
const WIDTH_HEIGHT_DIVERGENCE_THRESHOLD = 1.6;

// Need at least 2 available (non-ambiguous, non-unavailable) letters to
// compute any meaningful spread (mean/SD/CV) at all.
const MIN_AVAILABLE_LETTERS_FOR_CONSISTENCY = 2;

// Maps coefficient-of-variation of per-letter size_scale to a 0-100 score:
// score = clamp(100 - cv * SIZE_CONSISTENCY_CV_SCALE, 0, 100).
// CV=0 (perfectly consistent relative sizing) -> 100. Calibrated so a
// single letter at 1.5x/0.5x its expected size (the synthetic "one big/
// small letter" case) lands solidly in the lower half, while a uniformly
// globally-rescaled word (every letter the same multiple of its own
// template) stays at exactly 100 (CV=0 by construction, regardless of the
// multiple - see the module header's normalization note).
const SIZE_CONSISTENCY_CV_SCALE = 220;

// Combines (a) how far the average gap deviates from the expected gap and
// (b) how much the gaps vary among themselves, into one score:
// score = clamp(100 - (0.5*|meanGapRatio-1| + 0.5*sdGapRatio) * SPACING_CONSISTENCY_SCALE, 0, 100).
const SPACING_CONSISTENCY_SCALE = 110;

function mean(values) { return values.reduce((s, v) => s + v, 0) / values.length; }
function stddev(values, avg) { return Math.sqrt(values.reduce((s, v) => s + (v - avg) ** 2, 0) / values.length); }
function clamp01to100(value) { return Math.max(0, Math.min(100, value)); }

/**
 * @param {{word: string, strokes: any, canvasWidth: number, canvasHeight: number}} input
 * @returns {object} the word_layout structure — see module header / final
 *   report for the exact shape. Always returns a well-formed object, never
 *   throws, even for an unsupported word, missing strokes, or a word too
 *   short to have any gaps.
 */
function computeWordLayoutMetrics({ word, strokes, canvasWidth, canvasHeight }) {
  const empty = {
    version: WORD_LAYOUT_VERSION,
    letter_metrics: [],
    size_consistency_score: null,
    spacing_metrics: [],
    spacing_consistency_score: null,
    largest_relative_letter_index: null,
    smallest_relative_letter_index: null,
    status: 'unavailable',
  };

  const guide = buildWordGuide(String(word || '').toLowerCase());
  const clean = cleanStrokes(strokes);
  const w = Number(canvasWidth), h = Number(canvasHeight);
  if (!guide || clean.length === 0 || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return empty;
  }

  const { bounds, regions } = letterBoundsAndRegions(guide, w, h);
  const flatPoints = clean.flat();
  // Same half-open interval assignment scoreWord()'s own coverage check
  // uses  -  one shared definition of "which points belong to which letter".
  const perLetterPoints = regions.map(r => flatPoints.filter(p => p.x >= r.min && p.x < r.max));

  const letters = String(word || '').replace(/[^a-zA-Z]/g, '').split('');

  const letterMetrics = perLetterPoints.map((pts, i) => {
    const base = { letter: letters[i] ?? null, index: i };
    const expectedWidth = bounds[i].max - bounds[i].min;
    const expectedHeight = bounds[i].maxY - bounds[i].minY;
    // A purely vertical (or, symmetrically, purely horizontal) template
    // stroke — e.g. 'l' — has a genuinely, exactly zero expected width by
    // construction, not an ambiguous measurement. Found by sweeping all
    // 154 canonical words: 55 of them (71 of 730 letters) have at least one
    // letter like this. width_ratio is undefined for such a letter (there
    // is nothing to divide by), but height_ratio is completely real and
    // meaningful — falling back to a height-only size_scale instead of
    // marking the whole letter unavailable is what keeps those 55 words
    // from losing size/spacing coverage over letters that are perfectly
    // fine to measure, just not on the width axis.
    const widthDegenerate = !(expectedWidth > 1e-6);
    const heightDegenerate = !(expectedHeight > 1e-6);

    if (pts.length < MIN_POINTS_FOR_LETTER_BBOX || (widthDegenerate && heightDegenerate)) {
      return { ...base, status: 'unavailable' };
    }

    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const observedWidth = maxX - minX;
    const observedHeight = maxY - minY;
    const observedCenterX = (minX + maxX) / 2;
    const expectedCenterX = (bounds[i].min + bounds[i].max) / 2;

    // ── Region-crossing protection (section 9)  -  conservative, combines
    // expected region + observed bounding box + expected center. No new
    // segmentation model: still the same fixed x-region assignment above;
    // this only decides whether THIS letter's resulting bbox is trustworthy.
    // Skipped for a width-degenerate letter — its "width" cap has no
    // meaningful reference scale to compare against, and center-based
    // checks below still cover cross-contamination on the axis that matters.
    const regionWidth = regions[i].max - regions[i].min; // Infinity for an edge region
    const widthCapExceeded = !widthDegenerate && (Number.isFinite(regionWidth)
      ? observedWidth > regionWidth * REGION_CROSS_WIDTH_MULTIPLIER
      : observedWidth > expectedWidth * EDGE_REGION_WIDTH_FALLBACK_MULTIPLIER);

    const closerToPrevCenter = i > 0
      && Math.abs(observedCenterX - (bounds[i - 1].min + bounds[i - 1].max) / 2) < Math.abs(observedCenterX - expectedCenterX);
    const closerToNextCenter = i < bounds.length - 1
      && Math.abs(observedCenterX - (bounds[i + 1].min + bounds[i + 1].max) / 2) < Math.abs(observedCenterX - expectedCenterX);

    const widthRatio = widthDegenerate ? null : observedWidth / expectedWidth;
    const heightRatio = heightDegenerate ? null : observedHeight / expectedHeight;

    // A third, independent signal: an oversized MIDDLE letter can get its
    // width clipped by its own fixed region boundary (X is region-bounded,
    // Y never is), while its height ratio still measures the real inflation
    // correctly. That disagreement between the two axes is itself evidence
    // the width reading is contaminated by clipping, even when neither
    // check above fires (found via this module's own synthetic testing,
    // not a hypothetical case) — width and height ratio for a genuinely
    // uniformly-sized letter should stay reasonably close to each other.
    // Not applicable (and skipped) when either ratio is null — a
    // width-degenerate letter has nothing to compare against on that axis.
    const widthHeightDivergence = (widthRatio != null && heightRatio != null)
      ? Math.max(widthRatio, heightRatio) / Math.max(Math.min(widthRatio, heightRatio), 1e-6)
      : 0;

    if (widthCapExceeded || closerToPrevCenter || closerToNextCenter || widthHeightDivergence > WIDTH_HEIGHT_DIVERGENCE_THRESHOLD) {
      return { ...base, status: 'ambiguous' };
    }

    // size_scale: the geometric mean when both axes are measurable; falls
    // back to whichever single ratio is real when the other axis is
    // width- or height-degenerate by template design (see above).
    const sizeScale = (widthRatio != null && heightRatio != null)
      ? Math.sqrt(widthRatio * heightRatio)
      : (widthRatio ?? heightRatio);

    return {
      ...base,
      status: 'available',
      observed_width_normalized: observedWidth / h,
      observed_height_normalized: observedHeight / h,
      expected_width_normalized: expectedWidth / h,
      expected_height_normalized: expectedHeight / h,
      width_ratio: widthRatio,
      height_ratio: heightRatio,
      size_scale: sizeScale,
    };
  });

  const availableForSize = letterMetrics.filter(m => m.status === 'available');
  let sizeConsistencyScore = null;
  let largestIndex = null, smallestIndex = null;
  if (availableForSize.length >= MIN_AVAILABLE_LETTERS_FOR_CONSISTENCY) {
    const scales = availableForSize.map(m => m.size_scale);
    const m1 = mean(scales), sd1 = stddev(scales, m1);
    const cv = m1 > 1e-6 ? sd1 / m1 : 0;
    sizeConsistencyScore = Math.round(clamp01to100(100 - cv * SIZE_CONSISTENCY_CV_SCALE));

    const largest = availableForSize.reduce((a, b) => (b.size_scale > a.size_scale ? b : a));
    const smallest = availableForSize.reduce((a, b) => (b.size_scale < a.size_scale ? b : a));
    largestIndex = largest.index;
    smallestIndex = smallest.index;
  }

  // ── Spacing — consecutive AVAILABLE letters only (an unavailable/
  // ambiguous letter's bounding box can't be trusted, so any gap touching
  // it can't be either; that pair is simply absent from spacing_metrics,
  // never filled with a fabricated number). Recomputed from each letter's
  // raw observed points rather than from letterMetrics (which only carries
  // normalized dimensions, not the raw min/max needed for a gap).
  const observedEdges = perLetterPoints.map((pts, i) => {
    if (letterMetrics[i].status !== 'available') return null;
    const xs = pts.map(p => p.x);
    return { minX: Math.min(...xs), maxX: Math.max(...xs) };
  });

  const finalSpacingMetrics = [];
  const gapRatios = [];
  for (let i = 0; i < observedEdges.length - 1; i++) {
    const from = observedEdges[i], to = observedEdges[i + 1];
    if (!from || !to) {
      const status = !from ? letterMetrics[i].status : letterMetrics[i + 1].status;
      finalSpacingMetrics.push({ from_index: i, to_index: i + 1, status });
      continue;
    }
    const observedGap = to.minX - from.maxX;
    // Expected gap for this pair, read directly from the template's own
    // consecutive bounds  -  buildWordGuide() uses a single average-based gap
    // for the whole word (avg letter width * 0.22), so this is the same
    // value for every pair; computed per-pair anyway rather than assumed
    // uniform, so a future template change that varies it per-pair is
    // still handled correctly with no code change here.
    const expectedGap = bounds[i + 1].min - bounds[i].max;
    if (!(expectedGap > 1e-6)) {
      finalSpacingMetrics.push({ from_index: i, to_index: i + 1, status: 'unavailable' });
      continue;
    }
    const gapRatio = observedGap / expectedGap;
    gapRatios.push(gapRatio);
    finalSpacingMetrics.push({
      from_index: i, to_index: i + 1, status: 'available',
      observed_gap_normalized: observedGap / h,
      expected_gap_normalized: expectedGap / h,
      gap_ratio: gapRatio,
    });
  }

  let spacingConsistencyScore = null;
  if (gapRatios.length >= 1) {
    const meanGapRatio = mean(gapRatios);
    // A lone gap (2-letter word) has no variation to measure between gaps
    //  -  score reflects deviation-from-expected only, sd term is 0.
    const sdGapRatio = gapRatios.length >= 2 ? stddev(gapRatios, meanGapRatio) : 0;
    const combinedError = 0.5 * Math.abs(meanGapRatio - 1) + 0.5 * sdGapRatio;
    spacingConsistencyScore = Math.round(clamp01to100(100 - combinedError * SPACING_CONSISTENCY_SCALE));
  }

  const overallStatus = (availableForSize.length >= MIN_AVAILABLE_LETTERS_FOR_CONSISTENCY || gapRatios.length >= 1)
    ? 'available'
    : 'unavailable';

  return {
    version: WORD_LAYOUT_VERSION,
    letter_metrics: letterMetrics,
    size_consistency_score: sizeConsistencyScore,
    spacing_metrics: finalSpacingMetrics,
    spacing_consistency_score: spacingConsistencyScore,
    largest_relative_letter_index: largestIndex,
    smallest_relative_letter_index: smallestIndex,
    status: overallStatus,
  };
}

// ── Section 17 support  -  a simple, non-numeric advisory for optional child-
// facing feedback. Bands are pilot/engineering defaults (same disclosure as
// the scoring constants above), used ONLY to pick which single message (if
// any) to show  -  never displayed as a number, never both messages unless
// both are genuinely low. Deliberately conservative: only fires on a clear
// signal, not a borderline one, per "prefer conservative educational
// wording" and "do not overwhelm the child with analytics".
const CHILD_FEEDBACK_SCORE_THRESHOLD = 55;

function resolveChildFeedbackAdvisory(layout) {
  if (layout.status !== 'available') return null;
  const sizeLow = layout.size_consistency_score != null && layout.size_consistency_score < CHILD_FEEDBACK_SCORE_THRESHOLD;
  const spacingLow = layout.spacing_consistency_score != null && layout.spacing_consistency_score < CHILD_FEEDBACK_SCORE_THRESHOLD;
  if (sizeLow && spacingLow) return 'both';
  if (sizeLow) return 'size';
  if (spacingLow) return 'spacing';
  return null;
}

// ── Section 16 support  -  a small, non-numeric teacher-report summary.
// Bands are explicit pilot/engineering defaults, stated as such  -  not a
// clinical or validated cutoff. Kept separate from the raw scores (which
// remain available in normalized_features for research use).
const TEACHER_SUMMARY_CONSISTENT_MIN = 80;
const TEACHER_SUMMARY_SOME_VARIATION_MIN = 50;

function scoreToConsistencyLabel(score) {
  if (score == null) return null;
  if (score >= TEACHER_SUMMARY_CONSISTENT_MIN) return 'Consistent';
  if (score >= TEACHER_SUMMARY_SOME_VARIATION_MIN) return 'Some variation';
  return 'High variation';
}

module.exports = {
  WORD_LAYOUT_VERSION,
  MIN_POINTS_FOR_LETTER_BBOX,
  REGION_CROSS_WIDTH_MULTIPLIER,
  EDGE_REGION_WIDTH_FALLBACK_MULTIPLIER,
  WIDTH_HEIGHT_DIVERGENCE_THRESHOLD,
  MIN_AVAILABLE_LETTERS_FOR_CONSISTENCY,
  SIZE_CONSISTENCY_CV_SCALE,
  SPACING_CONSISTENCY_SCALE,
  CHILD_FEEDBACK_SCORE_THRESHOLD,
  TEACHER_SUMMARY_CONSISTENT_MIN,
  TEACHER_SUMMARY_SOME_VARIATION_MIN,
  computeWordLayoutMetrics,
  resolveChildFeedbackAdvisory,
  scoreToConsistencyLabel,
};
