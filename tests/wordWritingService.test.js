const mockAttempts = [];
const mockProgress = new Map();
const mockScoreWord = jest.fn();

jest.mock('../src/models', () => ({
  WordWritingAttempt: {
    findOne: jest.fn(async ({ where }) => mockAttempts.find(row => row.action_id === where.action_id) || null),
    create: jest.fn(async values => {
      const row = { ...values, id: mockAttempts.length + 1, get: () => ({ ...values, id: mockAttempts.length + 1 }) };
      mockAttempts.push(row);
      return row;
    }),
    findAll: jest.fn(async () => mockAttempts),
  },
  WordActivityProgress: {
    findOrCreate: jest.fn(async ({ where, defaults }) => {
      const key = `${where.student_id}:${where.word}`;
      if (!mockProgress.has(key)) {
        const row = {
          ...defaults,
          update: jest.fn(async values => Object.assign(row, values)),
          get: () => ({ ...row }),
        };
        mockProgress.set(key, row);
      }
      return [mockProgress.get(key)];
    }),
    findAll: jest.fn(async () => [...mockProgress.values()]),
  },
}));

jest.mock('../src/services/wordScoringService', () => ({ scoreWord: (...args) => mockScoreWord(...args) }));

// Word-layout-metrics task — this file tests wordWritingService's own
// orchestration in isolation (same philosophy as mocking scoreWord above),
// not the real layout math (see wordLayoutService.test.js for that).
jest.mock('../src/services/wordLayoutService', () => ({
  computeWordLayoutMetrics: jest.fn(() => ({ version: 'word_layout_v1', status: 'available' })),
  resolveChildFeedbackAdvisory: jest.fn(() => null),
}));

const { saveAttempt, upsertActivity } = require('../src/services/wordWritingService');
const { WordWritingAttempt } = require('../src/models');

const scoreResult = {
  valid: true,
  score: 72,
  passed: true,
  completionPassed: true,
  expectedLetterCount: 3,
  coveredLetterCount: 3,
  features: { dtw_distance: 4, smoothness: 0.1 },
  thresholdUsed: 50,
  scoreVersion: 'word_v1',
};

beforeEach(() => {
  mockAttempts.length = 0;
  mockProgress.clear();
  jest.clearAllMocks();
  mockScoreWord.mockReturnValue(scoreResult);
});

test('decimal canvas dimensions reach scoring unchanged and persist as safe integers', async () => {
  await saveAttempt({
    studentId: 40,
    actionId: 'decimal-action',
    word: 'cat',
    stage: 'guided_word_writing',
    attemptNumber: 1,
    strokes: [[{ x: 1, y: 1 }, { x: 2, y: 2 }]],
    canvasWidth: 916.6470588235295,
    canvasHeight: 388.4,
  });

  expect(mockScoreWord).toHaveBeenCalledWith(expect.objectContaining({
    canvasWidth: 916.6470588235295,
    canvasHeight: 388.4,
  }));
  expect(WordWritingAttempt.create).toHaveBeenCalledWith(expect.objectContaining({
    canvas_width: 917,
    canvas_height: 388,
    support_stage: 'high',
    collection_mode: false,
  }));
});

test('two words retain six guided rows, two E attempts, and independent A-E progress', async () => {
  for (const word of ['cat', 'car']) {
    for (const activity of ['A', 'B', 'C', 'D']) {
      await upsertActivity({ studentId: 40, word, activity, status: 'correct' });
    }
    for (const attemptNumber of [1, 2, 3]) {
      await saveAttempt({
        studentId: 40,
        actionId: `${word}-guided-${attemptNumber}`,
        word,
        stage: 'guided_word_writing',
        attemptNumber,
        strokes: [[{ x: 1, y: 1 }, { x: 2, y: 2 }]],
        canvasWidth: 916.6470588235295,
        canvasHeight: 388,
      });
    }
    await saveAttempt({
      studentId: 40,
      actionId: `${word}-exercise-e`,
      word,
      stage: 'practice_exercise_e',
      strokes: [[{ x: 1, y: 1 }, { x: 2, y: 2 }]],
      canvasWidth: 490,
      canvasHeight: 220,
    });
  }

  expect(mockAttempts.filter(row => row.stage === 'guided_word_writing')).toHaveLength(6);
  expect(mockAttempts.filter(row => row.stage === 'practice_exercise_e')).toHaveLength(2);
  expect(mockAttempts.filter(row => row.stage === 'guided_word_writing').map(row => row.support_stage)).toEqual([
    'high', 'medium', 'low', 'high', 'medium', 'low',
  ]);
  expect(mockProgress.size).toBe(2);
  expect(mockProgress.get('40:cat').activity_status).toEqual({ A: 'correct', B: 'correct', C: 'correct', D: 'correct', E: 'correct' });
  expect(mockProgress.get('40:car').activity_status).toEqual({ A: 'correct', B: 'correct', C: 'correct', D: 'correct', E: 'correct' });
});
