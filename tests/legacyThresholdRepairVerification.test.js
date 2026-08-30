'use strict';

// Reliability investigation (2026-08-09) — confirms the legacy per-letter
// threshold path (unrelated to and untouched by Feature 2) still behaves
// correctly against personal_thresholds={}, exactly the value the repair
// migration backfilled onto every existing student. Entirely offline —
// mocks ../src/models, no real DB connection, no live student touched.
const mockFindByPk = jest.fn(); // Student.findByPk (thresholdUtils)
const mockFindOne  = jest.fn(); // Student.findOne (teacherService)

jest.mock('../src/models', () => ({
  Student: { findByPk: (...a) => mockFindByPk(...a), findOne: (...a) => mockFindOne(...a) },
}));

const { getStudentThreshold } = require('../src/utils/thresholdUtils');
const teacherService = require('../src/services/teacherService');

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Test 9 — getStudentThreshold fallback to 55 with {} ──────────────────

describe('Test 9 — getStudentThreshold falls back to the global default with personal_thresholds={}', () => {
  it('returns 55 for a student whose personal_thresholds is {} (the exact post-repair state)', async () => {
    mockFindByPk.mockResolvedValueOnce({ personal_thresholds: {} });

    const threshold = await getStudentThreshold(13, 'a');

    expect(threshold).toBe(55);
  });

  it('still prefers a per-letter override when one exists', async () => {
    mockFindByPk.mockResolvedValueOnce({ personal_thresholds: { a: 70 } });
    expect(await getStudentThreshold(13, 'a')).toBe(70);
  });

  it('still prefers a student-level default over the global default', async () => {
    mockFindByPk.mockResolvedValueOnce({ personal_thresholds: { default: 60 } });
    expect(await getStudentThreshold(13, 'z')).toBe(60);
  });

  it('falls back to 55 even when the student row itself is not found', async () => {
    mockFindByPk.mockResolvedValueOnce(null);
    expect(await getStudentThreshold(999, 'a')).toBe(55);
  });
});

// ─── Test 10 — legacy teacher threshold service still works ───────────────

describe('Test 10 — teacherService.setThreshold still writes personal_thresholds[letter] correctly', () => {
  it('merges the new letter value into an existing {} object and persists it', async () => {
    const studentInstance = {
      sid: 999, // a disposable/mock student id — never the real student 13
      personal_thresholds: {},
      update: jest.fn(async function (fields) { Object.assign(this, fields); return this; }),
    };
    mockFindOne.mockResolvedValueOnce(studentInstance);

    const result = await teacherService.setThreshold(5, 999, 'a', 70);

    expect(studentInstance.update).toHaveBeenCalledWith({ personal_thresholds: { a: 70 } });
    expect(result).toEqual({ student_id: 999, letter: 'a', value: 70, personal_thresholds: { a: 70 } });
  });

  it('an unowned/nonexistent student is rejected exactly as before', async () => {
    mockFindOne.mockResolvedValueOnce(null);
    await expect(teacherService.setThreshold(5, 999, 'a', 70)).rejects.toMatchObject({ statusCode: 404 });
  });
});
