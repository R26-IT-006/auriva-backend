'use strict';

// Proposal FR-16, Phase 7B — real-time teacher session monitoring.
// Ownership/validation/snapshot-semantics tests for liveSessionService +
// liveSessionController, mirroring the established pattern from
// collectionControllerAuthorization.test.js / recordLetterCompletionAuthorization.test.js.
const ApiError = require('../src/utils/ApiError');

const mockFindByPk = jest.fn();
const mockCreate    = jest.fn();
const mockGetOwnStudentById = jest.fn();

jest.mock('../src/models', () => ({
  StudentLiveHandwritingSession: {
    findByPk: (...a) => mockFindByPk(...a),
    create:   (...a) => mockCreate(...a),
  },
}));
jest.mock('../src/services/teacherService', () => ({
  getOwnStudentById: (...a) => mockGetOwnStudentById(...a),
}));

const { upsertLiveSession, getLiveSession, sanitizeLivePatch } = require('../src/services/liveSessionService');
const { putLiveSession, getLiveSession: getLiveSessionCtrl } = require('../src/controllers/liveSessionController');

const TEACHER_A_ID = 7;
const TEACHER_B_ID = 9;
const STUDENT_A_ID = 10;
const STUDENT_B_ID = 55;
const NOT_OWNED_ERROR = new ApiError(404, 'Student not found or not assigned to you');

function makeRes() { return { status: jest.fn().mockReturnThis(), json: jest.fn() }; }

// Minimal fake Sequelize-instance-like row: .update() mutates in place,
// exactly what liveSessionService relies on (no .reload() call).
function makeRow(overrides = {}) {
  const row = {
    student_id: STUDENT_A_ID,
    activity_type: 'lowercase_letter',
    status: 'active',
    current_item: 'a',
    case_type: 'lowercase',
    attempt_number: 1,
    support_level: 'high',
    elapsed_active_seconds: 30,
    latest_saved_score: null,
    started_at: new Date(), // real "now" by default — only the dedicated staleness tests below fix this to a specific instant (with Date.now mocked to match)
    last_updated_at: new Date(),
    ...overrides,
  };
  row.update = jest.fn(async (patch) => { Object.assign(row, patch); return row; });
  return row;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOwnStudentById.mockResolvedValue({ sid: STUDENT_A_ID, teacher_id: TEACHER_A_ID });
});

// ─── 1/7/8. Own student can update — upserts, never creates a second row ────
describe('upsertLiveSession — own student', () => {
  it('creates a new row when none exists yet', async () => {
    mockFindByPk.mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce(makeRow());

    const result = await upsertLiveSession(TEACHER_A_ID, STUDENT_A_ID, { activity_type: 'lowercase_letter', status: 'active' });

    expect(mockGetOwnStudentById).toHaveBeenCalledWith(TEACHER_A_ID, STUDENT_A_ID);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('active');
    expect(result.connection_status).toBe('live');
  });

  it('UPDATES the existing row rather than creating a second one (spec §6/§7 — no unbounded rows)', async () => {
    const existing = makeRow();
    mockFindByPk.mockResolvedValueOnce(existing);

    await upsertLiveSession(TEACHER_A_ID, STUDENT_A_ID, { current_item: 'b', attempt_number: 2 });

    expect(mockCreate).not.toHaveBeenCalled();
    expect(existing.update).toHaveBeenCalledTimes(1);
    expect(existing.update).toHaveBeenCalledWith(expect.objectContaining({ current_item: 'b', attempt_number: 2 }));
  });

  it('a meaningful state change always advances last_updated_at', async () => {
    const existing = makeRow({ last_updated_at: new Date('2026-08-20T10:00:00.000Z') });
    mockFindByPk.mockResolvedValueOnce(existing);

    const before = existing.last_updated_at.getTime();
    await upsertLiveSession(TEACHER_A_ID, STUDENT_A_ID, { current_item: 'c' });

    expect(existing.update).toHaveBeenCalledWith(
      expect.objectContaining({ last_updated_at: expect.any(Date) })
    );
    const [[patchArg]] = existing.update.mock.calls;
    expect(patchArg.last_updated_at.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('preserves started_at across updates within the same (non-ended) session (spec §17)', async () => {
    const originalStart = new Date('2026-08-20T09:00:00.000Z');
    const existing = makeRow({ status: 'active', started_at: originalStart });
    mockFindByPk.mockResolvedValueOnce(existing);

    await upsertLiveSession(TEACHER_A_ID, STUDENT_A_ID, { current_item: 'd' });

    const [[patchArg]] = existing.update.mock.calls;
    expect(patchArg.started_at).toBe(originalStart);
  });

  it('starts a NEW started_at when the previous row was ended (a fresh visit begins)', async () => {
    const oldStart = new Date('2026-08-19T09:00:00.000Z');
    const existing = makeRow({ status: 'ended', started_at: oldStart });
    mockFindByPk.mockResolvedValueOnce(existing);

    await upsertLiveSession(TEACHER_A_ID, STUDENT_A_ID, { status: 'active', activity_type: 'prewriting' });

    const [[patchArg]] = existing.update.mock.calls;
    expect(patchArg.started_at).not.toBe(oldStart);
    expect(patchArg.started_at.getTime()).toBeGreaterThan(oldStart.getTime());
  });
});

// ─── 2/22. Other teacher cannot update ──────────────────────────────────────
describe('upsertLiveSession — cross-teacher rejection', () => {
  it("OTHER TEACHER'S STUDENT — rejected, zero reads/writes to the live-session table", async () => {
    mockGetOwnStudentById.mockRejectedValueOnce(NOT_OWNED_ERROR);

    await expect(upsertLiveSession(TEACHER_B_ID, STUDENT_A_ID, { activity_type: 'prewriting', status: 'active' }))
      .rejects.toMatchObject({ statusCode: 404 });

    expect(mockFindByPk).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

// ─── 3/22. Other teacher cannot read ────────────────────────────────────────
describe('getLiveSession — cross-teacher rejection', () => {
  it("OTHER TEACHER'S STUDENT — rejected, the row is never returned", async () => {
    mockGetOwnStudentById.mockRejectedValueOnce(NOT_OWNED_ERROR);

    await expect(getLiveSession(TEACHER_B_ID, STUDENT_A_ID)).rejects.toMatchObject({ statusCode: 404 });
    expect(mockFindByPk).not.toHaveBeenCalled();
  });

  it('own student — returns the snapshot', async () => {
    mockFindByPk.mockResolvedValueOnce(makeRow({ last_updated_at: new Date() }));
    const result = await getLiveSession(TEACHER_A_ID, STUDENT_A_ID);
    expect(result.student_id).toBe(STUDENT_A_ID);
  });

  it('no row yet — NOT ACTIVE, never a leaked/guessed default', async () => {
    mockFindByPk.mockResolvedValueOnce(null);
    const result = await getLiveSession(TEACHER_A_ID, STUDENT_A_ID);
    expect(result).toEqual({ status: 'not_active' });
  });
});

// ─── 4/5/6. Server-side validation ──────────────────────────────────────────
describe('sanitizeLivePatch — validation (spec §12)', () => {
  it('rejects an invalid activity_type', () => {
    expect(() => sanitizeLivePatch({ activity_type: 'napping' })).toThrow(ApiError);
  });

  it('rejects an invalid status', () => {
    expect(() => sanitizeLivePatch({ status: 'sleeping' })).toThrow(ApiError);
  });

  it('rejects a negative elapsed_active_seconds', () => {
    expect(() => sanitizeLivePatch({ elapsed_active_seconds: -5 })).toThrow(ApiError);
  });

  it('rejects a non-integer elapsed_active_seconds', () => {
    expect(() => sanitizeLivePatch({ elapsed_active_seconds: 12.5 })).toThrow(ApiError);
  });

  it('rejects an out-of-range latest_saved_score', () => {
    expect(() => sanitizeLivePatch({ latest_saved_score: 150 })).toThrow(ApiError);
  });

  it('rejects an invalid case_type', () => {
    expect(() => sanitizeLivePatch({ case_type: 'mixedcase' })).toThrow(ApiError);
  });

  it('rejects an out-of-range attempt_number', () => {
    expect(() => sanitizeLivePatch({ attempt_number: 999 })).toThrow(ApiError);
  });

  it('rejects an invalid support_level', () => {
    expect(() => sanitizeLivePatch({ support_level: 'extreme' })).toThrow(ApiError);
  });

  it('accepts a valid partial patch (only the fields actually present)', () => {
    const patch = sanitizeLivePatch({ elapsed_active_seconds: 42 });
    expect(patch).toEqual({ elapsed_active_seconds: 42 });
  });
});

// ─── 10. No raw strokes / arbitrary body keys ever reach the row ───────────
describe('mass-assignment / privacy guard (spec §4/§12)', () => {
  it('unknown keys (raw strokes, arbitrary profile data) are silently dropped, never persisted', () => {
    const patch = sanitizeLivePatch({
      activity_type: 'lowercase_letter',
      strokes: [[{ x: 1, y: 2 }]],
      raw_points: [1, 2, 3],
      medical_notes: 'irrelevant',
      centroid_distance: 0.42,
      status: 'active',
    });
    expect(patch).toEqual({ activity_type: 'lowercase_letter', status: 'active' });
    expect(patch.strokes).toBeUndefined();
    expect(patch.raw_points).toBeUndefined();
    expect(patch.medical_notes).toBeUndefined();
    expect(patch.centroid_distance).toBeUndefined();
  });
});

// ─── 19. Stale/live/not-active connection_status calculation ───────────────
describe('connection_status calculation (spec §13)', () => {
  const REAL_NOW = Date.now;
  afterEach(() => { Date.now = REAL_NOW; });

  it('LIVE when last_updated_at is within the stale threshold', async () => {
    const fixedNow = new Date('2026-08-20T10:00:10.000Z').getTime();
    Date.now = () => fixedNow;
    mockFindByPk.mockResolvedValueOnce(makeRow({ status: 'active', last_updated_at: new Date('2026-08-20T10:00:00.000Z') })); // 10s old
    const result = await getLiveSession(TEACHER_A_ID, STUDENT_A_ID);
    expect(result.connection_status).toBe('live');
  });

  it('STALE once older than the threshold', async () => {
    const fixedNow = new Date('2026-08-20T10:01:00.000Z').getTime();
    Date.now = () => fixedNow;
    mockFindByPk.mockResolvedValueOnce(makeRow({ status: 'active', last_updated_at: new Date('2026-08-20T10:00:00.000Z') })); // 60s old
    const result = await getLiveSession(TEACHER_A_ID, STUDENT_A_ID);
    expect(result.connection_status).toBe('stale');
  });

  it('a row with status=ended is always NOT ACTIVE regardless of recency', async () => {
    mockFindByPk.mockResolvedValueOnce(makeRow({ status: 'ended', last_updated_at: new Date() }));
    const result = await getLiveSession(TEACHER_A_ID, STUDENT_A_ID);
    expect(result.connection_status).toBe('not_active');
  });
});

// ─── Controller-level wiring (studentId parsing + delegation) ──────────────
describe('liveSessionController', () => {
  function makeReq({ user, params, body } = {}) {
    return { user: user ?? { id: TEACHER_A_ID }, params: params ?? { studentId: String(STUDENT_A_ID) }, body: body ?? {} };
  }

  it('putLiveSession rejects a non-numeric studentId before touching the service', async () => {
    const res = makeRes();
    await expect(putLiveSession(makeReq({ params: { studentId: 'abc' } }), res)).rejects.toMatchObject({ statusCode: 422 });
    expect(mockGetOwnStudentById).not.toHaveBeenCalled();
  });

  it('putLiveSession happy path returns {status: "ok", session}', async () => {
    mockFindByPk.mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce(makeRow());
    const res = makeRes();
    await putLiveSession(makeReq({ body: { activity_type: 'prewriting', status: 'active' } }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'ok', session: expect.any(Object) }));
  });

  it('getLiveSession (controller) delegates studentId as a Number, not a string', async () => {
    mockFindByPk.mockResolvedValueOnce(null);
    const res = makeRes();
    await getLiveSessionCtrl(makeReq(), res);
    expect(mockGetOwnStudentById).toHaveBeenCalledWith(TEACHER_A_ID, STUDENT_A_ID);
  });
});

// ─── 23. collection_mode has zero CODE footprint in this service ───────────
// (comments are allowed to document the exclusion decision — and do; only
// actual executable code/identifiers are checked here).
describe('collection_mode exclusion (spec §19) — total, not partial', () => {
  const fs = require('fs');
  const path = require('path');

  function stripComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  }

  it('liveSessionService.js has no executable reference to collection_mode/collection_session_id/capture_status', () => {
    const source = stripComments(fs.readFileSync(path.resolve(__dirname, '../src/services/liveSessionService.js'), 'utf8'));
    expect(source).not.toMatch(/collection_mode|collection_session_id|capture_status/);
  });

  it('liveSessionController.js has no executable reference to collection_mode/collection_session_id/capture_status', () => {
    const source = stripComments(fs.readFileSync(path.resolve(__dirname, '../src/controllers/liveSessionController.js'), 'utf8'));
    expect(source).not.toMatch(/collection_mode|collection_session_id|capture_status/);
  });
});
