'use strict';

// Proposal FR-19, Phase 7C — pure date-range validation/parsing for the
// periodic report endpoint. Framework-free (no Express/Sequelize import)
// so it is directly unit-testable.
//
// ── Semantics (spec §3) — documented exactly, not left implicit ─────────
// - start_date/end_date are plain YYYY-MM-DD calendar-day strings (the
//   same DATEONLY convention this schema already uses for
//   Student.date_of_birth) — never a full ISO datetime with a timezone
//   offset, so there is nothing for a caller to get wrong about *which*
//   timezone the boundary is in.
// - Both boundaries are interpreted in UTC, always — start_date is
//   00:00:00.000 UTC on that calendar day, end_date is 23:59:59.999 UTC on
//   that calendar day (INCLUSIVE on both ends). This is a deliberate,
//   fixed choice — never the server process's local timezone, never the
//   requesting device's local timezone — so a report is 100% reproducible
//   regardless of where it is generated or viewed.
// - "no future-only range" (spec §3): a request whose start_date is after
//   today (UTC) is rejected outright — there is no possible data there.
//   A range that starts in the past but extends past today is NOT
//   rejected; end_date is instead clamped to the end of today (UTC) so a
//   teacher can freely request "last 30 days" without needing to compute
//   an exact end date themselves.
// - MAX_RANGE_DAYS caps the request for query-cost predictability (spec
//   §3's "cap unreasonable range if necessary for performance") — a
//   PILOT / ENGINEERING DEFAULT, not a research-derived limit.

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

// PILOT / ENGINEERING DEFAULT — generous enough for "last 6 months" (the
// proposal's own example) and a full multi-year custom range, bounded
// enough that a single report query can never scan an unbounded history.
const MAX_RANGE_DAYS = 730;

/**
 * @param {string} dateStr — expected exactly 'YYYY-MM-DD'.
 * @returns {Date|null} a UTC Date at 00:00:00.000 on that calendar day, or
 *   null if the string is malformed OR not a real calendar date (e.g.
 *   '2026-02-30' is rejected, not silently rolled over to March).
 */
function parseDateOnlyUtc(dateStr) {
  if (typeof dateStr !== 'string' || !DATE_ONLY_RE.test(dateStr)) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Date.UTC silently rolls invalid day/month combinations forward
  // (e.g. month 13 → next January) — reconstructing and comparing catches
  // that instead of accepting a rolled-over date as if it were valid input.
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

function endOfDayUtc(dateAtMidnightUtc) {
  return new Date(dateAtMidnightUtc.getTime() + 24 * 60 * 60 * 1000 - 1);
}

/**
 * @param {string} startDateStr
 * @param {string} endDateStr
 * @param {Date} [now] — injectable for tests; defaults to real "now".
 * @returns {{ok: true, startAt: Date, endAt: Date, startDate: string, endDate: string, clampedToToday: boolean}
 *           | {ok: false, error: string}}
 */
function resolveReportDateRange(startDateStr, endDateStr, now = new Date()) {
  if (!startDateStr || !endDateStr) {
    return { ok: false, error: 'start_date and end_date are required (YYYY-MM-DD)' };
  }

  const startAtMidnight = parseDateOnlyUtc(startDateStr);
  if (!startAtMidnight) return { ok: false, error: 'start_date must be a valid YYYY-MM-DD date' };

  const endAtMidnight = parseDateOnlyUtc(endDateStr);
  if (!endAtMidnight) return { ok: false, error: 'end_date must be a valid YYYY-MM-DD date' };

  const todayAtMidnightUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  if (startAtMidnight.getTime() > todayAtMidnightUtc.getTime()) {
    return { ok: false, error: 'start_date cannot be in the future' };
  }
  if (startAtMidnight.getTime() > endAtMidnight.getTime()) {
    return { ok: false, error: 'start_date must be on or before end_date' };
  }

  const clampedToToday = endAtMidnight.getTime() > todayAtMidnightUtc.getTime();
  const effectiveEndAtMidnight = clampedToToday ? todayAtMidnightUtc : endAtMidnight;

  const rangeDays = Math.round((effectiveEndAtMidnight.getTime() - startAtMidnight.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  if (rangeDays > MAX_RANGE_DAYS) {
    return { ok: false, error: `Date range too large (max ${MAX_RANGE_DAYS} days)` };
  }

  return {
    ok: true,
    startAt: startAtMidnight,
    endAt: endOfDayUtc(effectiveEndAtMidnight),
    startDate: startDateStr,
    endDate: clampedToToday ? todayAtMidnightUtc.toISOString().slice(0, 10) : endDateStr,
    clampedToToday,
  };
}

module.exports = { resolveReportDateRange, parseDateOnlyUtc, MAX_RANGE_DAYS };
