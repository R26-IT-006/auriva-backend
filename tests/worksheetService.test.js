'use strict';

// Homework worksheet service — target derivation, teacher-approved generation,
// duplicate control, submission, review, and isolation from progression.

const mockEvaluateRecs = jest.fn();
const mockWsFindOne = jest.fn();
const mockWsFindAll = jest.fn();
const mockWsFindByPk = jest.fn();
const mockWsCreate = jest.fn();
const mockSubFindAll = jest.fn();
const mockSubFindByPk = jest.fn();
const mockSubCreate = jest.fn();

jest.mock('../src/models', () => ({
  HandwritingWorksheet: {
    findOne: (...a) => mockWsFindOne(...a),
    findAll: (...a) => mockWsFindAll(...a),
    findByPk: (...a) => mockWsFindByPk(...a),
    create: (...a) => mockWsCreate(...a),
  },
  HandwritingWorksheetSubmission: {
    findAll: (...a) => mockSubFindAll(...a),
    findByPk: (...a) => mockSubFindByPk(...a),
    create: (...a) => mockSubCreate(...a),
  },
}));

jest.mock('../src/services/worksheetRecommendationService', () => ({
  evaluateWorksheetRecommendations: (...a) => mockEvaluateRecs(...a),
}));

const svc = require('../src/services/worksheetService');

const SID = 40;

function row(over = {}) {
  return {
    id: 1, student_id: SID, worksheet_code: 'HW-2026-0001',
    target_letter: 'c', case_type: 'lowercase', motor_family: 'curved',
    worksheet_intensity: 'standard', status: 'generated',
    generated_at: new Date('2026-08-26T00:00:00.000Z'),
    update: jest.fn().mockResolvedValue(undefined), ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockWsFindOne.mockResolvedValue(null);
  mockWsFindAll.mockResolvedValue([]);
  mockSubFindAll.mockResolvedValue([]);
  mockWsCreate.mockImplementation(async (p) => row(p));
  mockSubCreate.mockImplementation(async (p) => ({ id: 5, ...p, update: jest.fn() }));
  mockEvaluateRecs.mockResolvedValue({ status: 'evaluated', recommendations: [] });
});

// ─── Target derivation (Phase 3) ──────────────────────────────────────────

describe('target letter is derived from real evidence, not a new model', () => {
  it('ranks by the failure counts Feature 7 already recorded', () => {
    const targets = svc.deriveTargetLetters({
      affectedLetters: [
        { letter: 'c', totalCycles: 4, failedCycles: 4 },
        { letter: 'o', totalCycles: 3, failedCycles: 1 },
      ],
    });
    expect(targets.map((t) => t.letter)).toEqual(['c', 'o']);
    expect(targets[0].failedCycles).toBe(4);
  });

  it('a letter that never failed is never a target', () => {
    const targets = svc.deriveTargetLetters({
      affectedLetters: [
        { letter: 'c', totalCycles: 4, failedCycles: 2 },
        { letter: 'o', totalCycles: 6, failedCycles: 0 },
      ],
    });
    expect(targets.map((t) => t.letter)).toEqual(['c']);
  });

  it('no affected letters yields no target', () => {
    expect(svc.deriveTargetLetters({ affectedLetters: [] })).toEqual([]);
    expect(svc.deriveTargetLetters({})).toEqual([]);
  });
});

describe('candidates come only from persistent streams', () => {
  it('no persistent recommendation yields no candidate', async () => {
    mockEvaluateRecs.mockResolvedValue({ status: 'evaluated', recommendations: [] });
    const r = await svc.getWorksheetCandidates({ studentId: SID });
    expect(r.status).toBe('evaluated');
    expect(r.candidates).toEqual([]);
  });

  it('insufficient data propagates, never invents a candidate', async () => {
    mockEvaluateRecs.mockResolvedValue({ status: 'read_failed', recommendations: null });
    const r = await svc.getWorksheetCandidates({ studentId: SID });
    expect(r.candidates).toEqual([]);
  });

  it('a persistent stream produces a candidate with a suggested letter', async () => {
    mockEvaluateRecs.mockResolvedValue({
      status: 'evaluated',
      recommendations: [{
        caseType: 'lowercase', family: 'curved', title: 'Curved Movement Practice',
        rationale: 'Repeated difficulty was observed across separated practice sessions.',
        recommendationFingerprint: 'abc123',
        affectedLetters: [{ letter: 'c', totalCycles: 4, failedCycles: 3 }],
      }],
    });
    const r = await svc.getWorksheetCandidates({ studentId: SID });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].suggestedLetter).toBe('c');
    expect(r.candidates[0].alreadyAssigned).toBe(false);
    expect(r.candidates[0].candidateLetters).toHaveLength(1);
  });

  it('flags a stream whose suggested letter already has a live worksheet', async () => {
    mockEvaluateRecs.mockResolvedValue({
      status: 'evaluated',
      recommendations: [{
        caseType: 'lowercase', family: 'curved', title: 't', rationale: 'r',
        affectedLetters: [{ letter: 'c', totalCycles: 4, failedCycles: 3 }],
      }],
    });
    mockWsFindAll.mockResolvedValue([{ target_letter: 'c', case_type: 'lowercase', status: 'assigned' }]);
    const r = await svc.getWorksheetCandidates({ studentId: SID });
    expect(r.candidates[0].alreadyAssigned).toBe(true);
  });

  it('evaluates the recommendation service exactly once', async () => {
    await svc.getWorksheetCandidates({ studentId: SID });
    expect(mockEvaluateRecs).toHaveBeenCalledTimes(1);
  });
});

// ─── Generation (Phases 9, 18) ────────────────────────────────────────────

describe('teacher-approved generation', () => {
  it('creates a worksheet for the approved target and attaches the motor plan', async () => {
    const r = await svc.generateWorksheet({
      studentId: SID, targetLetter: 'c', caseType: 'lowercase', family: 'curved',
    });
    expect(r.status).toBe('created');
    expect(mockWsCreate).toHaveBeenCalledTimes(1);
    const payload = mockWsCreate.mock.calls[0][0];
    expect(payload.target_letter).toBe('c');
    expect(payload.status).toBe('generated');
    expect(payload.worksheet_code).toMatch(/^HW-\d{4}-\d{4}$/);
    expect(r.plan.warmUp.map((w) => w.id)).toEqual(['half_circle']);
  });

  it("the TEACHER's chosen letter wins over the system suggestion", async () => {
    // The stream suggested 'c'; the teacher picks 'o'.
    const r = await svc.generateWorksheet({
      studentId: SID, targetLetter: 'o', caseType: 'lowercase', family: 'curved',
    });
    expect(r.status).toBe('created');
    expect(mockWsCreate.mock.calls[0][0].target_letter).toBe('o');
    expect(r.plan.warmUp.map((w) => w.id)).toEqual(['full_circle']);
  });

  it('an unmapped letter is reported, never guessed at', async () => {
    const r = await svc.generateWorksheet({ studentId: SID, targetLetter: 'é', caseType: 'lowercase' });
    expect(r.status).toBe('unmapped_letter');
    expect(mockWsCreate).not.toHaveBeenCalled();
  });

  it('a case mismatch is rejected', async () => {
    const r = await svc.generateWorksheet({ studentId: SID, targetLetter: 'C', caseType: 'lowercase' });
    expect(r.status).toBe('invalid_input');
    expect(mockWsCreate).not.toHaveBeenCalled();
  });

  it('DUPLICATE CONTROL: a live worksheet blocks a second one for the same letter', async () => {
    mockWsFindOne.mockResolvedValue(row({ status: 'assigned' }));
    const r = await svc.generateWorksheet({ studentId: SID, targetLetter: 'c', caseType: 'lowercase' });
    expect(r.status).toBe('already_assigned');
    expect(mockWsCreate).not.toHaveBeenCalled();
    expect(r.worksheet.id).toBe(1);
  });

  it('a unique-constraint race resolves to the existing worksheet, never a duplicate', async () => {
    const err = new Error('dup'); err.name = 'SequelizeUniqueConstraintError';
    mockWsCreate.mockRejectedValueOnce(err);
    // findOne is used three times here: the duplicate pre-check, the
    // worksheet-code sequence lookup, then the post-race re-fetch.
    mockWsFindOne
      .mockResolvedValueOnce(null)                                  // pre-check
      .mockResolvedValueOnce(null)                                  // code sequence
      .mockResolvedValueOnce(row({ id: 9, status: 'generated' }));  // race re-fetch
    const r = await svc.generateWorksheet({ studentId: SID, targetLetter: 'c', caseType: 'lowercase' });
    expect(r.status).toBe('already_assigned');
    expect(r.worksheet.id).toBe(9);
  });

  it('a reviewed worksheet does not block a new one', async () => {
    // findOne only matches live statuses; a reviewed sheet is not returned.
    mockWsFindOne.mockResolvedValue(null);
    const r = await svc.generateWorksheet({ studentId: SID, targetLetter: 'c', caseType: 'lowercase' });
    expect(r.status).toBe('created');
    expect(mockWsFindOne.mock.calls[0][0].where.status).toBeDefined();
  });

  it('an invalid intensity falls back to standard', async () => {
    await svc.generateWorksheet({
      studentId: SID, targetLetter: 'c', caseType: 'lowercase', intensity: 'severe',
    });
    expect(mockWsCreate.mock.calls[0][0].worksheet_intensity).toBe('standard');
  });

  it('a whitespace-only teacher note is stored as null', async () => {
    await svc.generateWorksheet({
      studentId: SID, targetLetter: 'c', caseType: 'lowercase', teacherNote: '   ',
    });
    expect(mockWsCreate.mock.calls[0][0].teacher_note).toBeNull();
  });
});

// ─── Submission and review (Phases 13, 14) ────────────────────────────────

describe('submission', () => {
  it('records a returned photo and moves the worksheet to submitted', async () => {
    const ws = row({ status: 'assigned' });
    mockWsFindByPk.mockResolvedValue(ws);
    const r = await svc.submitWorksheet({
      worksheetId: 1, studentId: SID, fileReference: 'https://blob/x.jpg', submissionType: 'photo',
    });
    expect(r.status).toBe('submitted');
    expect(mockSubCreate.mock.calls[0][0].review_status).toBe('pending_review');
    expect(ws.update.mock.calls[0][0].status).toBe('submitted');
  });

  it('accepts a scan as well as a photo', async () => {
    mockWsFindByPk.mockResolvedValue(row());
    await svc.submitWorksheet({ worksheetId: 1, studentId: SID, fileReference: 'u', submissionType: 'scan' });
    expect(mockSubCreate.mock.calls[0][0].submission_type).toBe('scan');
  });

  it('REJECTS a submission for another student\'s worksheet', async () => {
    mockWsFindByPk.mockResolvedValue(row({ student_id: 99 }));
    const r = await svc.submitWorksheet({ worksheetId: 1, studentId: SID, fileReference: 'u' });
    expect(r.status).toBe('student_mismatch');
    expect(mockSubCreate).not.toHaveBeenCalled();
  });

  it('a submission is never auto-scored — no analysis field is written', async () => {
    mockWsFindByPk.mockResolvedValue(row());
    await svc.submitWorksheet({ worksheetId: 1, studentId: SID, fileReference: 'u' });
    const payload = mockSubCreate.mock.calls[0][0];
    for (const f of ['analysis_status', 'analysis_result', 'analysis_model_version']) {
      expect(payload).not.toHaveProperty(f);
    }
  });
});

describe('teacher review', () => {
  it('saves the teacher\'s own verdict and comment', async () => {
    const sub = { id: 5, worksheet_id: 1, student_id: SID, update: jest.fn().mockResolvedValue(undefined) };
    mockSubFindByPk.mockResolvedValue(sub);
    mockWsFindByPk.mockResolvedValue(row({ status: 'submitted' }));
    const r = await svc.reviewSubmission({
      submissionId: 5, reviewStatus: 'needs_more_practice', teacherComment: 'Keep practising c.',
    });
    expect(r.status).toBe('reviewed');
    expect(sub.update.mock.calls[0][0].review_status).toBe('needs_more_practice');
    expect(sub.update.mock.calls[0][0].teacher_comment).toBe('Keep practising c.');
  });

  it('there is no "failed" review status', () => {
    expect(svc.VALID_REVIEW_STATUSES).toEqual(['pending_review', 'reviewed', 'needs_more_practice']);
    expect(svc.VALID_REVIEW_STATUSES).not.toContain('failed');
  });

  it('rejects an unknown or pending review verdict', async () => {
    for (const bad of ['failed', 'pending_review', 'passed', undefined]) {
      const r = await svc.reviewSubmission({ submissionId: 5, reviewStatus: bad });
      expect(r.status).toBe('invalid_input');
    }
  });
});

// ─── Isolation (Phase 19) ─────────────────────────────────────────────────

describe('isolation from mastery, scoring and adaptation', () => {
  const src = require('fs').readFileSync(
    require.resolve('../src/services/worksheetService.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('never references LetterProgress, mastered_at or blocked_attempts', () => {
    expect(code).not.toMatch(/LetterProgress/);
    expect(code).not.toMatch(/mastered_at/);
    expect(code).not.toMatch(/blocked_attempts/);
  });

  it('never calls a threshold, Motor Score, adaptive or ML service', () => {
    for (const forbidden of [
      'dynamicThresholdService', 'adaptiveSupportService', 'progressionThresholdResolver',
      'computeMotorScore', 'letterMotorMasteryService', 'letterMotorPatternCheckService',
      'predictLetterMotorState', 'repetitionRecommendationService', 'mlServiceClient',
    ]) {
      expect(code).not.toMatch(new RegExp(forbidden));
    }
  });

  it('never writes a LetterAttempt or touches word unlock', () => {
    expect(code).not.toMatch(/LetterAttempt/);
    expect(code).not.toMatch(/wordUnlock|word_unlock/);
  });

  it('does not re-derive persistent-difficulty rules — it composes the service', () => {
    expect(code).toMatch(/evaluateWorksheetRecommendations/);
    expect(code).not.toMatch(/WINDOW_SIZE|MIN_WINDOW_SEPARATION_MS|DIFFICULTY_MAX_SUCCESSFUL_CYCLES/);
  });

  it('performs no automatic handwriting analysis of a submitted scan', () => {
    expect(code).not.toMatch(/analysis_status|analysis_result|analysis_model_version/);
    expect(code).not.toMatch(/ocr|recogni[sz]e|classif/i);
  });
});

// ─── History ──────────────────────────────────────────────────────────────

describe('history', () => {
  it('returns worksheets newest first with submissions attached and the active one flagged', async () => {
    mockWsFindAll.mockResolvedValue([
      { id: 2, student_id: SID, target_letter: 'o', case_type: 'lowercase', status: 'assigned', generated_at: new Date('2026-09-01') },
      { id: 1, student_id: SID, target_letter: 'c', case_type: 'lowercase', status: 'reviewed', generated_at: new Date('2026-08-26') },
    ]);
    mockSubFindAll.mockResolvedValue([
      { id: 7, worksheet_id: 1, review_status: 'reviewed', submitted_at: new Date('2026-08-29') },
    ]);
    const r = await svc.getWorksheetHistory({ studentId: SID });
    expect(r.status).toBe('found');
    expect(r.worksheets.map((w) => w.id)).toEqual([2, 1]);
    expect(r.worksheets[1].submissions).toHaveLength(1);
    expect(r.active.id).toBe(2);
  });

  it('an empty history is an honest empty result', async () => {
    const r = await svc.getWorksheetHistory({ studentId: SID });
    expect(r.worksheets).toEqual([]);
    expect(r.active).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Frozen worksheet plan — a printed worksheet must stay reproducible
// ═══════════════════════════════════════════════════════════════════════════

describe('the generated plan is frozen with the worksheet', () => {
  it('stores the plan the worksheet was actually generated from', async () => {
    await svc.generateWorksheet({
      studentId: SID, targetLetter: 'c', caseType: 'lowercase', family: 'curved',
    });
    const stored = mockWsCreate.mock.calls[0][0].worksheet_plan;
    expect(stored).toBeTruthy();
    expect(stored.target_letter).toBe('c');
    expect(stored.case_type).toBe('lowercase');
    expect(stored.motor_family).toBe('curved');
    expect(stored.stroke_types).toEqual(['half_circle']);
    expect(stored.warm_up.map((w) => w.id)).toEqual(['half_circle']);
    expect(stored.primary_shape.id).toBe('half_circle');
    expect(stored.shape_practice_sizes).toEqual(['large', 'medium', 'small']);
  });

  it('carries a plan version so a historical artefact is identifiable', async () => {
    await svc.generateWorksheet({ studentId: SID, targetLetter: 'c', caseType: 'lowercase' });
    expect(mockWsCreate.mock.calls[0][0].worksheet_plan.worksheet_plan_version)
      .toBe(svc.WORKSHEET_PLAN_VERSION);
    expect(svc.WORKSHEET_PLAN_VERSION).toBe('worksheet-plan-v1');
  });

  it('freezes the section settings, not just the shapes', async () => {
    await svc.generateWorksheet({
      studentId: SID, targetLetter: 'c', caseType: 'lowercase', intensity: 'extended',
    });
    const stored = mockWsCreate.mock.calls[0][0].worksheet_plan;
    expect(stored.trace).toEqual({ rows: 2, per_row: 5, dotted: true, show_start: true });
    expect(stored.copy).toEqual({ rows: 2, blanks_per_row: 4 });
    expect(stored.independent).toEqual({ rows: 3 });   // extended
    expect(stored.worksheet_intensity).toBe('extended');
  });

  it('records the family emphasis that was in force at generation time', async () => {
    await svc.generateWorksheet({
      studentId: SID, targetLetter: 'b', caseType: 'lowercase', family: 'curved',
    });
    const warm = mockWsCreate.mock.calls[0][0].worksheet_plan.warm_up;
    const byId = Object.fromEntries(warm.map((w) => [w.id, w]));
    expect(byId.half_circle.emphasised).toBe(true);
    expect(byId.half_circle.rows).toBe(2);
    expect(byId.vertical_line.emphasised).toBe(false);
  });

  it('stores structured data, never rendered HTML', async () => {
    await svc.generateWorksheet({ studentId: SID, targetLetter: 'c', caseType: 'lowercase' });
    const text = JSON.stringify(mockWsCreate.mock.calls[0][0].worksheet_plan);
    expect(text).not.toMatch(/<svg|<div|<html|<path/);
  });

  it('freezePlan is pure — it copies the given plan and reads no live mapping', () => {
    const plan = {
      strokeTypes: ['zigzag'],
      warmUp: [{ id: 'zigzag', label: 'Slanted lines', instruction: 'x', rows: 3, emphasised: true }],
      primaryShape: { id: 'zigzag', label: 'Slanted lines', instruction: 'x' },
      shapePracticeSizes: ['large'],
    };
    const frozen = svc.freezePlan({ plan, letter: 'K', caseType: 'uppercase', family: 'complex', intensity: 'standard' });
    expect(frozen.stroke_types).toEqual(['zigzag']);
    expect(frozen.warm_up[0].rows).toBe(3);
    // Mutating the source afterwards must not change what was frozen.
    plan.strokeTypes.push('vertical_line');
    expect(frozen.stroke_types).toEqual(['zigzag']);
  });
});

describe('the history read returns the frozen plan', () => {
  it('includes worksheet_plan on each row so a reprint can use it', async () => {
    mockWsFindAll.mockResolvedValue([
      { id: 1, student_id: SID, target_letter: 'c', case_type: 'lowercase',
        status: 'assigned', generated_at: new Date(),
        worksheet_plan: { worksheet_plan_version: 'worksheet-plan-v1', warm_up: [] } },
    ]);
    const r = await svc.getWorksheetHistory({ studentId: SID });
    expect(r.worksheets[0].worksheet_plan.worksheet_plan_version).toBe('worksheet-plan-v1');
  });

  it('a legacy row with no plan is returned honestly, never crashed on', async () => {
    mockWsFindAll.mockResolvedValue([
      { id: 1, student_id: SID, target_letter: 'c', case_type: 'lowercase',
        status: 'reviewed', generated_at: new Date(), worksheet_plan: null },
    ]);
    const r = await svc.getWorksheetHistory({ studentId: SID });
    expect(r.status).toBe('found');
    expect(r.worksheets[0].worksheet_plan).toBeNull();
  });
});
