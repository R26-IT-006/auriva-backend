'use strict';

// Reliability investigation (2026-08-09) — students.personal_thresholds was
// found missing from the live DB. This tests the self-heal function
// directly (extracted from index.js — identical logic/SQL/logging, see
// src/utils/ensurePersonalThresholdsColumn.js for the full incident
// context), entirely offline via a mocked `sequelize` object. No real DB
// connection, no real ALTER TABLE.
const mockAddColumn = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();

jest.mock('../src/utils/logger', () => ({
  warn: (...args) => mockLoggerWarn(...args),
  error: (...args) => mockLoggerError(...args),
  info: jest.fn(),
}));

const { ensurePersonalThresholdsColumn } = require('../src/utils/ensurePersonalThresholdsColumn');

function makeMockSequelize({ hasCol }) {
  return {
    query: jest.fn().mockResolvedValue([[{ has_col: hasCol }]]),
    getQueryInterface: jest.fn().mockReturnValue({ addColumn: mockAddColumn }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAddColumn.mockResolvedValue(undefined);
});

// ─── Test 1 — schema-check detects missing column ──────────────────────────

describe('Test 1 — schema-check detects a missing column', () => {
  it('queries information_schema.columns and reads has_col=0 as missing', async () => {
    const sequelize = makeMockSequelize({ hasCol: 0 });

    await ensurePersonalThresholdsColumn(sequelize);

    // Second argument is { logging: false }: the probe runs on a 60s interval,
    // so logging it would print the same SELECT once a minute forever. Asserted
    // rather than ignored — re-enabling it is a regression, not a tidy-up.
    expect(sequelize.query).toHaveBeenCalledWith(
      expect.stringContaining('information_schema.columns'),
      expect.objectContaining({ logging: false }),
    );
    expect(sequelize.query).toHaveBeenCalledWith(
      expect.stringContaining("table_name='students'"),
      expect.objectContaining({ logging: false }),
    );
    expect(sequelize.query).toHaveBeenCalledWith(
      expect.stringContaining("column_name='personal_thresholds'"),
      expect.objectContaining({ logging: false }),
    );
  });
});

// ─── Test 2 — repair adds column when absent ───────────────────────────────

describe('Test 2 — repair adds the column when absent', () => {
  it('calls addColumn on students.personal_thresholds', async () => {
    const sequelize = makeMockSequelize({ hasCol: 0 });

    await ensurePersonalThresholdsColumn(sequelize);

    expect(mockAddColumn).toHaveBeenCalledTimes(1);
    expect(mockAddColumn).toHaveBeenCalledWith('students', 'personal_thresholds', expect.any(Object));
  });

  it('logs a warning that the column was missing and re-added', async () => {
    const sequelize = makeMockSequelize({ hasCol: 0 });
    await ensurePersonalThresholdsColumn(sequelize);
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining('missing'));
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining('re-added'));
  });
});

// ─── Test 3 — repair does nothing when present ─────────────────────────────

describe('Test 3 — repair does nothing when the column is already present', () => {
  it('never calls addColumn', async () => {
    const sequelize = makeMockSequelize({ hasCol: 1 });

    await ensurePersonalThresholdsColumn(sequelize);

    expect(mockAddColumn).not.toHaveBeenCalled();
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });
});

// ─── Test 4 — repair does not overwrite existing values ────────────────────

describe('Test 4 — repair never overwrites existing data', () => {
  it('the only write operation is ADD COLUMN — no UPDATE-style call exists anywhere in this function', async () => {
    const sequelize = makeMockSequelize({ hasCol: 0 });

    await ensurePersonalThresholdsColumn(sequelize);

    // getQueryInterface() is called exactly once, and only .addColumn is
    // ever invoked on it — there is no update()/bulkUpdate() call path in
    // this function at all, so existing row VALUES can never be touched;
    // ADD COLUMN backfills every row with the column's own DEFAULT, which
    // is exactly what Sections 9/12 of the investigation require.
    expect(sequelize.getQueryInterface).toHaveBeenCalledTimes(1);
    expect(mockAddColumn).toHaveBeenCalledTimes(1);
  });
});

// ─── Test 5/6 — default, type, and nullability match the Student model ────

describe('Test 5/6 — the repaired column matches src/models/Student.js exactly', () => {
  it('type=JSONB, allowNull=false, defaultValue={}', async () => {
    const sequelize = makeMockSequelize({ hasCol: 0 });
    const { DataTypes } = require('sequelize');

    await ensurePersonalThresholdsColumn(sequelize);

    const columnDef = mockAddColumn.mock.calls[0][2];
    expect(columnDef.type).toBe(DataTypes.JSONB);
    expect(columnDef.allowNull).toBe(false);
    expect(columnDef.defaultValue).toEqual({}); // never a fabricated/reconstructed value
  });
});

// ─── Test 7 — repeated repair is idempotent ────────────────────────────────

describe('Test 7 — repeated calls are idempotent', () => {
  it('a second call, after the column now exists, does not add it again', async () => {
    const sequelize = makeMockSequelize({ hasCol: 0 });
    await ensurePersonalThresholdsColumn(sequelize);
    expect(mockAddColumn).toHaveBeenCalledTimes(1);

    // Simulate the column now existing (as it would after the first repair).
    sequelize.query.mockResolvedValue([[{ has_col: 1 }]]);
    await ensurePersonalThresholdsColumn(sequelize);

    expect(mockAddColumn).toHaveBeenCalledTimes(1); // still just the one call
  });
});

// ─── Test 8 — failure is visible, not silently swallowed ──────────────────

describe('Test 8 — a failure propagates rather than being silently swallowed', () => {
  it('rejects when the detection query itself fails', async () => {
    const sequelize = { query: jest.fn().mockRejectedValue(new Error('connection terminated')), getQueryInterface: jest.fn() };
    await expect(ensurePersonalThresholdsColumn(sequelize)).rejects.toThrow('connection terminated');
    expect(mockAddColumn).not.toHaveBeenCalled();
  });

  it('rejects when the ALTER TABLE itself fails — it does not resolve as if nothing happened', async () => {
    const sequelize = makeMockSequelize({ hasCol: 0 });
    mockAddColumn.mockRejectedValueOnce(new Error('permission denied for table students'));

    await expect(ensurePersonalThresholdsColumn(sequelize)).rejects.toThrow('permission denied for table students');
  });

  // The function itself deliberately has no try/catch — index.js's own two
  // call sites are what log a failure (`.catch(err => logger.error(...))`),
  // confirmed by direct inspection of index.js (both the startup `await`,
  // which propagates into start().catch(...) → logger.error('Startup
  // failed', ...) → process.exit(1), and the setInterval call, which has
  // its own explicit .catch(err => logger.error('personal_thresholds
  // self-heal check failed', ...))). This function rejecting (proven above)
  // is exactly what makes both of those call-site catches reachable.
});

// ─── Feature 2 regression guard ────────────────────────────────────────────

describe('this module never references Feature 2 concepts', () => {
  it('the source never mentions ThresholdHistory, dynamicThresholdService, or baseline_family', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/utils/ensurePersonalThresholdsColumn.js'), 'utf8');
    expect(source).not.toMatch(/ThresholdHistory|dynamicThresholdService|baseline_family|scope_type/);
  });
});
