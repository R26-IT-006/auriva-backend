'use strict';

// Verifies that a single collection_session_id sent on one request ends up
// on every row created from it — without hitting the real database. Models
// are mocked so this stays a fast, safe unit test.
jest.mock('../src/models', () => ({
  HandwritingAssessment: { count: jest.fn(), create: jest.fn() },
  LetterProgress:        { findOrCreate: jest.fn(), findAll: jest.fn(), findOne: jest.fn() },
  Student:                { findByPk: jest.fn() },
  ExplanationResult:     { create: jest.fn(), findOne: jest.fn() },
  RecommendationHistory: { create: jest.fn() },
  StudentMotorFeature:   { create: jest.fn() },
  ShapeFeature:          { bulkCreate: jest.fn() },
  LetterAttempt:         { bulkCreate: jest.fn() },
}));

const models = require('../src/models');
const { submitAssessment, recordLetterCompletion } = require('../src/controllers/handwritingController');

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

describe('collection_session_id propagation', () => {
  beforeEach(() => jest.clearAllMocks());

  it('submitAssessment copies collection_session_id onto the assessment and every ShapeFeature row', async () => {
    models.HandwritingAssessment.count.mockResolvedValue(0);
    models.HandwritingAssessment.create.mockResolvedValue({ id: 42, student_id: 10 });
    models.ShapeFeature.bulkCreate.mockResolvedValue([]);
    models.StudentMotorFeature.create.mockResolvedValue({});

    const SESSION_ID = '11111111-1111-4111-8111-111111111111';
    const req = {
      body: {
        student_id: 10,
        session_start: 1000,
        session_end: 2000,
        collection_mode: true,
        collection_session_id: SESSION_ID,
        protocol_version: 'v1',
        shapes: [
          { shape_id: 'horizontal_line', stroke_count: 1, strokes: [], features: { duration_ms: 100 } },
          { shape_id: 'vertical_line',   stroke_count: 1, strokes: [], features: { duration_ms: 100 } },
        ],
      },
    };

    await submitAssessment(req, makeRes());

    expect(models.HandwritingAssessment.create).toHaveBeenCalledWith(
      expect.objectContaining({ collection_session_id: SESSION_ID })
    );

    const bulkCreateRows = models.ShapeFeature.bulkCreate.mock.calls[0][0];
    expect(bulkCreateRows).toHaveLength(2);
    for (const row of bulkCreateRows) {
      expect(row.collection_session_id).toBe(SESSION_ID);
    }
    // task_order assigned from array position, per the plan's design.
    expect(bulkCreateRows[0].task_order).toBe(0);
    expect(bulkCreateRows[1].task_order).toBe(1);
  });

  it('recordLetterCompletion (collection mode) copies collection_session_id onto every LetterAttempt row', async () => {
    models.LetterAttempt.bulkCreate.mockResolvedValue([]);

    const SESSION_ID = '22222222-2222-4222-8222-222222222222';
    const req = {
      body: {
        student_id: 10,
        letter: 'i',
        case_type: 'lowercase',
        attempt_scores: [80, 85, 90],
        wrote_correctly: true,
        collection_mode: true,
        collection_session_id: SESSION_ID,
        protocol_version: 'v1',
        task_order: 6,
        quality_threshold: 50, // provided so the collection-mode branch skips the DB threshold lookup
        attempts: [
          { attempt_number: 1, features: { completionTime: 400 }, strokes: [] },
          { attempt_number: 2, features: { completionTime: 380 }, strokes: [] },
          { attempt_number: 3, features: { completionTime: 350 }, strokes: [] },
        ],
      },
    };

    await recordLetterCompletion(req, makeRes());

    const bulkCreateRows = models.LetterAttempt.bulkCreate.mock.calls[0][0];
    expect(bulkCreateRows).toHaveLength(3);
    for (const row of bulkCreateRows) {
      expect(row.collection_session_id).toBe(SESSION_ID);
      expect(row.task_order).toBe(6);
      // collection_accepted is always true here — it must never be read as a quality label.
      expect(row.collection_accepted).toBe(true);
    }
    // threshold_passed is the real comparison (90 >= 50), independent of collection_accepted.
    expect(bulkCreateRows[0].threshold_passed).toBe(true);
  });
});
