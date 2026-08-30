'use strict';

const { resolveReportDateRange, parseDateOnlyUtc, MAX_RANGE_DAYS } = require('../src/utils/reportDateRange');

const NOW = new Date('2026-08-20T15:30:00.000Z');

describe('parseDateOnlyUtc', () => {
  it('parses a valid date to UTC midnight', () => {
    const d = parseDateOnlyUtc('2026-08-20');
    expect(d.toISOString()).toBe('2026-08-20T00:00:00.000Z');
  });
  it('rejects a malformed string', () => {
    expect(parseDateOnlyUtc('08/20/2026')).toBeNull();
    expect(parseDateOnlyUtc('2026-8-20')).toBeNull();
    expect(parseDateOnlyUtc('not-a-date')).toBeNull();
    expect(parseDateOnlyUtc('')).toBeNull();
    expect(parseDateOnlyUtc(undefined)).toBeNull();
  });
  it('rejects a calendar-invalid date (never silently rolls over)', () => {
    expect(parseDateOnlyUtc('2026-02-30')).toBeNull();
    expect(parseDateOnlyUtc('2026-13-01')).toBeNull();
  });
});

describe('resolveReportDateRange — valid ranges', () => {
  it('a valid past range resolves with inclusive UTC boundaries', () => {
    const r = resolveReportDateRange('2026-01-01', '2026-01-31', NOW);
    expect(r.ok).toBe(true);
    expect(r.startAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(r.endAt.toISOString()).toBe('2026-01-31T23:59:59.999Z');
    expect(r.clampedToToday).toBe(false);
  });

  it('a single-day range (start === end) is valid', () => {
    const r = resolveReportDateRange('2026-08-01', '2026-08-01', NOW);
    expect(r.ok).toBe(true);
    expect(r.startAt.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(r.endAt.toISOString()).toBe('2026-08-01T23:59:59.999Z');
  });

  it('start_date exactly today is valid', () => {
    const r = resolveReportDateRange('2026-08-20', '2026-08-20', NOW);
    expect(r.ok).toBe(true);
  });
});

describe('resolveReportDateRange — invalid input', () => {
  it('rejects a missing start_date', () => {
    expect(resolveReportDateRange(undefined, '2026-08-20', NOW).ok).toBe(false);
  });
  it('rejects a missing end_date', () => {
    expect(resolveReportDateRange('2026-08-01', undefined, NOW).ok).toBe(false);
  });
  it('rejects a malformed start_date', () => {
    expect(resolveReportDateRange('garbage', '2026-08-20', NOW).ok).toBe(false);
  });
  it('rejects a malformed end_date', () => {
    expect(resolveReportDateRange('2026-08-01', 'garbage', NOW).ok).toBe(false);
  });
  it('rejects start_date > end_date', () => {
    const r = resolveReportDateRange('2026-08-20', '2026-08-01', NOW);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/on or before/);
  });
  it('rejects a start_date entirely in the future ("no future-only range")', () => {
    const r = resolveReportDateRange('2026-09-01', '2026-09-30', NOW);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/future/);
  });
  it('rejects a range exceeding MAX_RANGE_DAYS', () => {
    const r = resolveReportDateRange('2020-01-01', '2026-08-20', NOW);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/too large/);
  });
});

describe('resolveReportDateRange — end date beyond today is clamped, not rejected', () => {
  it('clamps end_date to today (UTC) when it is in the future, and reports the clamp', () => {
    const r = resolveReportDateRange('2026-08-01', '2026-12-31', NOW);
    expect(r.ok).toBe(true);
    expect(r.clampedToToday).toBe(true);
    expect(r.endDate).toBe('2026-08-20');
    expect(r.endAt.toISOString()).toBe('2026-08-20T23:59:59.999Z');
  });
});

describe('MAX_RANGE_DAYS', () => {
  it('is a positive, documented pilot constant', () => {
    expect(MAX_RANGE_DAYS).toBeGreaterThan(180); // must comfortably fit the proposal's own "6 months" example
  });
});
