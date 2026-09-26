'use strict';

/**
 * Mastery evidence is the attempt that mastered the letter, or nothing.
 *
 * The report's Letter Details panel said "No writing evidence available yet"
 * for every letter. The strokes existed — LetterAttempt.stroke_points has held
 * them all along — but nothing recorded WHICH attempt established mastery, and
 * the bulk report deliberately excludes trajectories.
 *
 * These tests pin the half that matters most: it must never answer with an
 * attempt it cannot prove caused mastery.
 */

const fs = require('fs');
const path = require('path');

jest.mock('../models', () => ({
  LetterProgress: { findOne: jest.fn(), findAll: jest.fn() },
  LetterAttempt: { findOne: jest.fn() },
  LetterMotorMasteryEvidence: { findOne: jest.fn() },
}));
jest.mock('../utils/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const { LetterProgress, LetterAttempt, LetterMotorMasteryEvidence } = require('../models');
const {
  EVIDENCE_STATUS,
  getLetterMasteryEvidence,
  resolveMasteryAttemptId,
  listLettersWithMasteryEvidence,
} = require('./letterMasteryEvidenceService');

const STROKES = [{ stroke_id: 0, points: [{ x: 10, y: 10 }, { x: 40, y: 60 }] }];

const attemptRow = (over = {}) => ({
  id: 77, attempt_number: 3, best_score: 91, threshold: 70, passed: true,
  stroke_points: STROKES, canvas_width: 300, canvas_height: 300,
  created_at: new Date('2026-08-20T10:00:00Z'), ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  LetterMotorMasteryEvidence.findOne.mockResolvedValue(null);
});

describe('a provable mastery attempt', () => {
  it('returns that attempt’s own strokes', async () => {
    LetterProgress.findOne.mockResolvedValue({ mastered_at: new Date(), mastery_letter_attempt_id: 77 });
    LetterAttempt.findOne.mockResolvedValue(attemptRow());

    const result = await getLetterMasteryEvidence({ studentId: 51, letter: 's', caseType: 'lowercase' });

    expect(result.status).toBe(EVIDENCE_STATUS.AVAILABLE);
    expect(result.evidence.stroke_points).toBe(STROKES);
    expect(result.evidence.attempt_id).toBe(77);
    expect(result.evidence.attempt_number).toBe(3);
    expect(result.evidence.score).toBe(91);
  });

  it('reports the attempt number it actually stored, not the policy constant', async () => {
    LetterProgress.findOne.mockResolvedValue({ mastered_at: new Date(), mastery_letter_attempt_id: 77 });
    LetterAttempt.findOne.mockResolvedValue(attemptRow({ attempt_number: 2 }));

    const result = await getLetterMasteryEvidence({ studentId: 51, letter: 's', caseType: 'lowercase' });
    expect(result.evidence.attempt_number).toBe(2);
    expect(result.evidence.mastery_attempt_number).toBe(3);
  });

  it('falls back to the Feature 11B frozen evidence for a reference letter', async () => {
    // Mastered before the LetterProgress column existed, but it is a reference
    // letter, so letter_motor_mastery_evidence already froze the same fact.
    LetterProgress.findOne.mockResolvedValue({ mastered_at: new Date(), mastery_letter_attempt_id: null });
    LetterMotorMasteryEvidence.findOne.mockResolvedValue({ letter_attempt_id: 42 });
    LetterAttempt.findOne.mockResolvedValue(attemptRow({ id: 42 }));

    const result = await getLetterMasteryEvidence({ studentId: 51, letter: 'A', caseType: 'uppercase' });
    expect(result.status).toBe(EVIDENCE_STATUS.AVAILABLE);
    expect(result.evidence.attempt_id).toBe(42);
  });
});

describe('it never guesses', () => {
  it('a letter mastered with no link says so, and reads no attempt', async () => {
    LetterProgress.findOne.mockResolvedValue({ mastered_at: new Date(), mastery_letter_attempt_id: null });

    const result = await getLetterMasteryEvidence({ studentId: 51, letter: 'z', caseType: 'lowercase' });

    expect(result.status).toBe(EVIDENCE_STATUS.UNLINKED);
    expect(result.evidence).toBeNull();
    // Crucially: it does not go looking for a substitute.
    expect(LetterAttempt.findOne).not.toHaveBeenCalled();
  });

  it('never selects an attempt by score or recency', () => {
    const code = fs.readFileSync(path.resolve(__dirname, 'letterMasteryEvidenceService.js'), 'utf8');
    expect(code).not.toMatch(/order:/);
    expect(code).not.toMatch(/best_score:\s*\{/);
    expect(code).not.toMatch(/DESC|limit:\s*1/);
    // Every attempt read is by the linked id.
    expect(code).toMatch(/id: attemptId/);
  });

  it('an unmastered letter is not evidence', async () => {
    LetterProgress.findOne.mockResolvedValue({ mastered_at: null, mastery_letter_attempt_id: 77 });
    const result = await getLetterMasteryEvidence({ studentId: 51, letter: 'q', caseType: 'lowercase' });
    expect(result.status).toBe(EVIDENCE_STATUS.NOT_MASTERED);
    expect(LetterAttempt.findOne).not.toHaveBeenCalled();
  });

  it('a missing progress row is not evidence', async () => {
    LetterProgress.findOne.mockResolvedValue(null);
    const result = await getLetterMasteryEvidence({ studentId: 51, letter: 'q', caseType: 'lowercase' });
    expect(result.status).toBe(EVIDENCE_STATUS.NOT_MASTERED);
  });

  it('a linked row that cannot be read is reported, not substituted', async () => {
    LetterProgress.findOne.mockResolvedValue({ mastered_at: new Date(), mastery_letter_attempt_id: 77 });
    LetterAttempt.findOne.mockResolvedValue(null);
    const result = await getLetterMasteryEvidence({ studentId: 51, letter: 's', caseType: 'lowercase' });
    expect(result.status).toBe(EVIDENCE_STATUS.ATTEMPT_GONE);
    expect(result.evidence).toBeNull();
  });

  it('a linked row with no trajectory is reported, not faked', async () => {
    LetterProgress.findOne.mockResolvedValue({ mastered_at: new Date(), mastery_letter_attempt_id: 77 });
    for (const empty of [null, [], undefined, 'not-an-array']) {
      LetterAttempt.findOne.mockResolvedValue(attemptRow({ stroke_points: empty }));
      const result = await getLetterMasteryEvidence({ studentId: 51, letter: 's', caseType: 'lowercase' });
      expect(result.status).toBe(EVIDENCE_STATUS.NO_STROKES);
      expect(result.evidence).toBeNull();
    }
  });
});

describe('case is part of the identity', () => {
  it('lowercase and uppercase are queried separately, everywhere', async () => {
    LetterProgress.findOne.mockResolvedValue({ mastered_at: new Date(), mastery_letter_attempt_id: 77 });
    LetterAttempt.findOne.mockResolvedValue(attemptRow());

    await getLetterMasteryEvidence({ studentId: 51, letter: 's', caseType: 'lowercase' });

    expect(LetterProgress.findOne).toHaveBeenCalledWith(expect.objectContaining({
      where: { student_id: 51, letter: 's', case_type: 'lowercase' },
    }));
    // The attempt read re-asserts letter AND case — an id alone is not trusted.
    expect(LetterAttempt.findOne).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ letter: 's', case_type: 'lowercase', student_id: 51 }),
    }));
  });

  it('the attempt read is scoped to the requesting student', async () => {
    LetterProgress.findOne.mockResolvedValue({ mastered_at: new Date(), mastery_letter_attempt_id: 77 });
    LetterAttempt.findOne.mockResolvedValue(attemptRow());
    await getLetterMasteryEvidence({ studentId: 51, letter: 'S', caseType: 'uppercase' });
    expect(LetterAttempt.findOne).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ student_id: 51 }),
    }));
  });

  it('rejects a bad case or letter before touching the database', async () => {
    for (const args of [
      { studentId: 51, letter: 's', caseType: 'LOWERCASE' },
      { studentId: 51, letter: 's', caseType: 'both' },
      { studentId: 51, letter: 'ss', caseType: 'lowercase' },
      { studentId: 51, letter: '4', caseType: 'lowercase' },
      { studentId: 0, letter: 's', caseType: 'lowercase' },
      { studentId: -1, letter: 's', caseType: 'lowercase' },
    ]) {
      const result = await getLetterMasteryEvidence(args);
      expect(result.status).toBe(EVIDENCE_STATUS.NOT_MASTERED);
    }
    expect(LetterProgress.findOne).not.toHaveBeenCalled();
  });
});

describe('the listing sends no strokes', () => {
  it('returns letter/case pairs only', async () => {
    LetterProgress.findAll.mockResolvedValue([
      { letter: 'a', case_type: 'lowercase' },
      { letter: 'A', case_type: 'uppercase' },
    ]);
    const rows = await listLettersWithMasteryEvidence(51);
    expect(rows).toEqual([
      { letter: 'a', caseType: 'lowercase' },
      { letter: 'A', caseType: 'uppercase' },
    ]);
    const call = LetterProgress.findAll.mock.calls[0][0];
    expect(call.attributes).toEqual(['letter', 'case_type']);
    expect(call.attributes).not.toContain('stroke_points');
  });
});

describe('the bulk report still carries no trajectories', () => {
  const controller = fs.readFileSync(
    path.resolve(__dirname, '../controllers/handwritingController.js'), 'utf8');

  it('stroke_points is not added to any report payload', () => {
    // The only place stroke_points leaves the server for letters is the
    // targeted evidence read in this service.
    const service = fs.readFileSync(path.resolve(__dirname, 'letterMasteryEvidenceService.js'), 'utf8');
    expect(service).toMatch(/'stroke_points'/);
    for (const bulk of ['getLetterProgressReport', 'getProgress']) {
      const at = controller.indexOf(`async function ${bulk}(`);
      expect(at).toBeGreaterThan(-1);
      const body = controller.slice(at, at + 3000);
      expect(body).not.toMatch(/stroke_points/);
    }
  });

  it('the evidence endpoint checks ownership before reading anything', () => {
    const at = controller.indexOf('async function getLetterMasteryEvidence(');
    const body = controller.slice(at, controller.indexOf('\n}', at));
    expect(body.indexOf('teacherService.getOwnStudentById'))
      .toBeLessThan(body.indexOf('letterMasteryEvidenceService.getLetterMasteryEvidence'));
    expect(body).toMatch(/throw new ApiError\(422, 'Invalid student ID'\)/);
    expect(body).toMatch(/case_type must be lowercase or uppercase/);
  });
});

describe('the link is written honestly', () => {
  const controller = fs.readFileSync(
    path.resolve(__dirname, '../controllers/handwritingController.js'), 'utf8');

  it('it is stamped from the mastering session’s attempt-3 row', () => {
    expect(controller).toMatch(/session_key: sessionKey,\s*attempt_number: MASTERY_ATTEMPT_NUMBER,/);
    expect(controller).toMatch(/record\.update\(\{ mastery_letter_attempt_id: masteryAttemptRow\.id \}\)/);
  });

  it('the first mastery keeps its evidence permanently', () => {
    expect(controller).toMatch(/if \(attemptsSaved && record\.mastery_letter_attempt_id == null\)/);
  });

  it('a bookkeeping failure never undoes mastery', () => {
    const at = controller.indexOf('if (attemptsSaved && record.mastery_letter_attempt_id == null)');
    const block = controller.slice(at, at + 1400);
    expect(block).toMatch(/catch \(linkErr\)/);
    expect(block).not.toMatch(/mastered_at|throw /);
  });

  it('the column is nullable and never backfilled', () => {
    const model = fs.readFileSync(path.resolve(__dirname, '../models/LetterProgress.js'), 'utf8');
    expect(model).toMatch(/mastery_letter_attempt_id: \{\s*type:\s*DataTypes\.INTEGER,\s*allowNull: true,/);
    const migration = fs.readFileSync(path.resolve(
      __dirname, '../../migrations/20260829000001-add-mastery-letter-attempt-id-to-letter-progress.js'), 'utf8');
    expect(migration).toMatch(/allowNull: true/);
    // The doc comment explains that no UPDATE runs — check the CODE.
    const body = migration.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(body).not.toMatch(/UPDATE|bulkUpdate|sequelize\.query/);
    expect(body).toMatch(/addColumn\('letter_progress', 'mastery_letter_attempt_id'/);
  });
});

describe('mastery policy is untouched', () => {
  it('threshold 70, attempt-3 only, 3 attempts per cycle', () => {
    const policy = fs.readFileSync(path.resolve(__dirname, '../config/masteryPolicy.js'), 'utf8');
    expect(policy).toMatch(/NORMAL_PRACTICE_MASTERY_THRESHOLD = 70/);
    expect(policy).toMatch(/MASTERY_ATTEMPT_NUMBER = 3/);
    expect(policy).toMatch(/ATTEMPTS_PER_CYCLE = 3/);
  });

  it('resolveMasteryAttemptId reads, and only reads', () => {
    const code = fs.readFileSync(path.resolve(__dirname, 'letterMasteryEvidenceService.js'), 'utf8');
    expect(code).not.toMatch(/\.update\(|\.create\(|\.destroy\(|\.upsert\(/);
  });

  it('an unmastered letter short-circuits before any attempt lookup', async () => {
    LetterProgress.findOne.mockResolvedValue({ mastered_at: null });
    const { mastered, attemptId } = await resolveMasteryAttemptId({
      studentId: 51, letter: 'z', caseType: 'lowercase',
    });
    expect(mastered).toBe(false);
    expect(attemptId).toBeNull();
    expect(LetterMotorMasteryEvidence.findOne).not.toHaveBeenCalled();
  });
});
