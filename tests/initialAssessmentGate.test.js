'use strict';

// The initial-assessment ROUTING gate.
//
// GET /handwriting/initial-report returns `hasData`, meaning "there is an
// assessment row I can render a report from". WelcomeScreen was using it as a
// routing gate, where it needed to mean "this learner completed a usable
// assessment and should proceed to practice". Student 41 proved the gap: one
// non-collection row, six shapes, but motor_profile=null and no baseline —
// hasData was true, Welcome skipped to LetterHome, and there was no route
// back to the assessment through the real product UI, ever.
//
// hasData is deliberately unchanged (two other consumers rely on its current
// meaning). `assessmentStatus` is the additive answer for routing.

const mockAssessmentFindAll = jest.fn();
const mockShapeFindAll = jest.fn();

jest.mock('../src/models', () => ({
  HandwritingAssessment: { findAll: (...a) => mockAssessmentFindAll(...a) },
  ShapeFeature:          { findAll: (...a) => mockShapeFindAll(...a) },
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const {
  getInitialAssessmentStatus, ASSESSMENT_STATUS, ASSESSMENT_STATUS_REASON,
} = require('../src/services/initialAssessmentStatusService');
const { REQUIRED_SHAPES } = require('../src/services/motorBaselineService');

// A motor_profile the real validator accepts.
const VALID_PROFILE = {
  straightScore: 70, curvedScore: 65, complexScore: 60,
  primaryStrength: 'straight',
  categoryOrder: ['straight', 'curved', 'complex'],
  recommendedSequence: 'straight_first',
  shapeScores: {
    horizontal_line: 72, vertical_line: 68, full_circle: 66,
    half_circle: 64, zigzag: 61, curve_wave: 59,
  },
};

const validAssessment = (id, over = {}) => ({
  id, student_id: 1, collection_mode: false, is_initial: true,
  motor_score: 65, motor_profile: VALID_PROFILE, created_at: new Date(), ...over,
});

/** The student-41 shape: a row that exists but produced nothing usable. */
const kamalAssessment = (id = 222) => validAssessment(id, { motor_score: null, motor_profile: null });

const sixShapesFor = (assessmentId) =>
  REQUIRED_SHAPES.map((shape_type, i) => ({ assessment_id: assessmentId, shape_type, motor_score: 60 + i }));

beforeEach(() => {
  // mockReset(), NOT clearAllMocks(): clearAllMocks clears CALLS but does not
  // drain a queued mockResolvedValueOnce, so an unconsumed value from an
  // earlier test leaks into the next one and silently answers the wrong
  // query. That is exactly what happened here first time round.
  mockAssessmentFindAll.mockReset();
  mockShapeFindAll.mockReset();
  mockShapeFindAll.mockResolvedValue([]);
});

// ─── A / B / C: the three states ────────────────────────────────────────

describe('A — no assessment at all', () => {
  it('is not_started, and the shape query is never even run', async () => {
    mockAssessmentFindAll.mockResolvedValueOnce([]);
    const r = await getInitialAssessmentStatus({ studentId: 4 });
    expect(r.status).toBe(ASSESSMENT_STATUS.NOT_STARTED);
    expect(r.reason).toBe(ASSESSMENT_STATUS_REASON.NONE);
    expect(r.assessmentCount).toBe(0);
    expect(mockShapeFindAll).not.toHaveBeenCalled();
  });
});

describe('B — an assessment row with no usable motor data', () => {
  it('is incomplete, not complete', async () => {
    mockAssessmentFindAll.mockResolvedValueOnce([kamalAssessment()]);
    const r = await getInitialAssessmentStatus({ studentId: 41 });
    expect(r.status).toBe(ASSESSMENT_STATUS.INCOMPLETE);
    expect(r.reason).toBe(ASSESSMENT_STATUS_REASON.INCOMPLETE);
    expect(r.usableAssessmentId).toBeNull();
    // The row still EXISTS — hasData would rightly still be true.
    expect(r.assessmentCount).toBe(1);
  });

  it('a null motor_score alone is enough to make it unusable', async () => {
    mockAssessmentFindAll.mockResolvedValueOnce([validAssessment(1, { motor_score: null })]);
    expect((await getInitialAssessmentStatus({ studentId: 1 })).status)
      .toBe(ASSESSMENT_STATUS.INCOMPLETE);
  });
});

describe('C — a valid, fully evidenced assessment', () => {
  it('is complete and names the usable assessment', async () => {
    mockAssessmentFindAll.mockResolvedValueOnce([validAssessment(223)]);
    mockShapeFindAll.mockResolvedValueOnce(sixShapesFor(223));
    const r = await getInitialAssessmentStatus({ studentId: 51 });
    expect(r.status).toBe(ASSESSMENT_STATUS.COMPLETE);
    expect(r.reason).toBe(ASSESSMENT_STATUS_REASON.COMPLETE);
    expect(r.usableAssessmentId).toBe(223);
  });

  it('missing even ONE canonical shape keeps it incomplete', async () => {
    mockAssessmentFindAll.mockResolvedValueOnce([validAssessment(300)]);
    mockShapeFindAll.mockResolvedValueOnce(sixShapesFor(300).slice(0, 5));
    expect((await getInitialAssessmentStatus({ studentId: 1 })).status)
      .toBe(ASSESSMENT_STATUS.INCOMPLETE);
  });

  it('a shape row with a non-finite motor_score does not count as evidence', async () => {
    mockAssessmentFindAll.mockResolvedValueOnce([validAssessment(301)]);
    const rows = sixShapesFor(301);
    rows[2] = { ...rows[2], motor_score: null };
    mockShapeFindAll.mockResolvedValueOnce(rows);
    expect((await getInitialAssessmentStatus({ studentId: 1 })).status)
      .toBe(ASSESSMENT_STATUS.INCOMPLETE);
  });
});

// ─── D: historical compatibility — the critical one ─────────────────────

describe('D — a valid historical assessment WITHOUT a StudentMotorBaseline', () => {
  it('is COMPLETE — baseline existence is never required', async () => {
    // This is the regression the live-data audit ruled out: definition
    // "baseline exists" would have sent FOUR legitimate learners back through
    // the initial assessment, including one with 181 assessments, purely
    // because their baseline rows predate automatic baseline creation.
    mockAssessmentFindAll.mockResolvedValueOnce([validAssessment(176)]);
    mockShapeFindAll.mockResolvedValueOnce(sixShapesFor(176));
    const r = await getInitialAssessmentStatus({ studentId: 10 });
    expect(r.status).toBe(ASSESSMENT_STATUS.COMPLETE);
  });

  it('SENTINEL — the service never reads StudentMotorBaseline at all', () => {
    const src = require('fs').readFileSync(require('path').resolve(
      __dirname, '../src/services/initialAssessmentStatusService.js'), 'utf8');
    expect(src).not.toMatch(/StudentMotorBaseline\.\w+\(/);
  });
});

// ─── E / F: collection mode and Writing Check ───────────────────────────

describe('E — research/collection assessments never satisfy the gate', () => {
  it('queries with collection_mode:false, so they are excluded at source', async () => {
    mockAssessmentFindAll.mockResolvedValueOnce([]);
    await getInitialAssessmentStatus({ studentId: 1 });
    expect(mockAssessmentFindAll).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ collection_mode: false }) }),
    );
  });

  it('a student with ONLY collection assessments is not_started', async () => {
    mockAssessmentFindAll.mockResolvedValueOnce([]);   // the filter removed them
    expect((await getInitialAssessmentStatus({ studentId: 1 })).status)
      .toBe(ASSESSMENT_STATUS.NOT_STARTED);
  });
});

describe('F — Writing Check can never open this gate', () => {
  it('only initial_assessment shape rows are counted as evidence', async () => {
    mockAssessmentFindAll.mockResolvedValueOnce([validAssessment(400)]);
    mockShapeFindAll.mockResolvedValueOnce(sixShapesFor(400));
    await getInitialAssessmentStatus({ studentId: 1 });
    expect(mockShapeFindAll).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ source: 'initial_assessment' }) }),
    );
  });

  it('Writing Check writes letter_attempts, which this service never reads', () => {
    const src = require('fs').readFileSync(require('path').resolve(
      __dirname, '../src/services/initialAssessmentStatusService.js'), 'utf8');
    expect(src).not.toMatch(/LetterAttempt/);
    expect(src).not.toMatch(/letter_motor_pattern/);
  });
});

// ─── G / H: the two live sentinels ──────────────────────────────────────

describe('G — the student-41 pattern', () => {
  it('SENTINEL — a row with six shapes but no motor profile is INCOMPLETE', async () => {
    mockAssessmentFindAll.mockResolvedValueOnce([kamalAssessment(222)]);
    mockShapeFindAll.mockResolvedValueOnce(sixShapesFor(222));
    const r = await getInitialAssessmentStatus({ studentId: 41 });
    expect(r.status).toBe(ASSESSMENT_STATUS.INCOMPLETE);
    // Under the OLD gate this exact shape produced hasData:true and skipped
    // the assessment forever.
    expect(r.status).not.toBe(ASSESSMENT_STATUS.COMPLETE);
  });

  it('reassigning that student and re-assessing successfully makes them complete', async () => {
    // The old unusable row is NEVER deleted; a new valid one coexists.
    mockAssessmentFindAll.mockResolvedValueOnce([kamalAssessment(222), validAssessment(500)]);
    mockShapeFindAll.mockResolvedValueOnce(sixShapesFor(500));
    const r = await getInitialAssessmentStatus({ studentId: 41 });
    expect(r.status).toBe(ASSESSMENT_STATUS.COMPLETE);
    expect(r.usableAssessmentId).toBe(500);
    expect(r.assessmentCount).toBe(2);   // both rows still present
  });
});

describe('H — the student-51 pattern must not regress', () => {
  it('SENTINEL — valid assessment + six linked shapes stays COMPLETE', async () => {
    mockAssessmentFindAll.mockResolvedValueOnce([validAssessment(223)]);
    mockShapeFindAll.mockResolvedValueOnce(sixShapesFor(223));
    expect((await getInitialAssessmentStatus({ studentId: 51 })).status)
      .toBe(ASSESSMENT_STATUS.COMPLETE);
  });
});

// ─── I: earliest broken, later valid ────────────────────────────────────

describe('I — an earlier broken assessment never blocks a later valid one', () => {
  it('is complete, and points at the valid one', async () => {
    mockAssessmentFindAll.mockResolvedValueOnce([
      kamalAssessment(100), validAssessment(101), validAssessment(102),
    ]);
    mockShapeFindAll.mockResolvedValueOnce([...sixShapesFor(101), ...sixShapesFor(102)]);
    const r = await getInitialAssessmentStatus({ studentId: 1 });
    expect(r.status).toBe(ASSESSMENT_STATUS.COMPLETE);
    // Earliest USABLE one, matching the baseline selector's own chronology.
    expect(r.usableAssessmentId).toBe(101);
  });

  it('a later valid assessment with NO shapes still leaves the student incomplete', async () => {
    mockAssessmentFindAll.mockResolvedValueOnce([kamalAssessment(100), validAssessment(101)]);
    mockShapeFindAll.mockResolvedValueOnce([]);
    expect((await getInitialAssessmentStatus({ studentId: 1 })).status)
      .toBe(ASSESSMENT_STATUS.INCOMPLETE);
  });
});

// ─── Failure handling ───────────────────────────────────────────────────

describe('a database failure never CLAIMS completeness', () => {
  // The two failure modes are not equally bad. Wrongly showing the assessment
  // costs one repeated assessment a teacher sees at once, and which the
  // earliest-fully-eligible baseline selector ignores. Wrongly skipping it is
  // silent: no baseline, no personalization, no route back.
  it('an assessment read error reports incomplete, with a distinct reason', async () => {
    mockAssessmentFindAll.mockRejectedValueOnce(new Error('db down'));
    const r = await getInitialAssessmentStatus({ studentId: 10 });
    expect(r.status).toBe(ASSESSMENT_STATUS.INCOMPLETE);
    expect(r.reason).toBe(ASSESSMENT_STATUS_REASON.READ_FAILED);
    // Never silently indistinguishable from a genuinely incomplete learner.
    expect(r.reason).not.toBe(ASSESSMENT_STATUS_REASON.INCOMPLETE);
  });

  it('a shape read error does the same', async () => {
    mockAssessmentFindAll.mockResolvedValueOnce([validAssessment(1)]);
    mockShapeFindAll.mockRejectedValueOnce(new Error('db down'));
    const r = await getInitialAssessmentStatus({ studentId: 10 });
    expect(r.status).toBe(ASSESSMENT_STATUS.INCOMPLETE);
    expect(r.reason).toBe(ASSESSMENT_STATUS_REASON.READ_FAILED);
  });

  it('SENTINEL — no failure path ever returns complete', () => {
    const src = require('fs').readFileSync(require('path').resolve(
      __dirname, '../src/services/initialAssessmentStatusService.js'), 'utf8');
    const failBlocks = src.match(/READ_FAILED[\s\S]{0,120}/g) ?? [];
    expect(failBlocks.length).toBeGreaterThan(0);
    for (const b of failBlocks) expect(b).not.toMatch(/ASSESSMENT_STATUS\.COMPLETE/);
  });
});

// ─── The response contract stays additive ───────────────────────────────

describe('the endpoint contract', () => {
  const src = require('fs').readFileSync(require('path').resolve(
    __dirname, '../src/controllers/handwritingController.js'), 'utf8');

  it('hasData is UNCHANGED — still true whenever a renderable row exists', () => {
    expect(src).toMatch(/hasData: true,/);
    expect(src).toMatch(/hasData: false,/);
  });

  it('assessmentStatus is returned on BOTH the empty and populated responses', () => {
    const matches = src.match(/assessmentStatus:\s+initialStatus\.status/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it('the status reason travels with it', () => {
    const matches = src.match(/assessmentStatusReason:\s+initialStatus\.reason/g) ?? [];
    expect(matches.length).toBe(2);
  });
});
