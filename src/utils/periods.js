'use strict';

/**
 * Calendar periods, resolved in the school's own timezone.
 *
 * A saved report names a period a teacher recognises — "the week of 18 August",
 * "August 2026" — and those words mean local days, not UTC instants. Getting this
 * wrong is not cosmetic: with the server in UTC, a Colombo child's 8pm session
 * lands on the following day, so it falls into the wrong week's report and the
 * figures a teacher takes to a meeting are quietly off by a session.
 *
 * Deliberately free of database and model imports. Everything here is arithmetic
 * on dates, so it can be reasoned about and tested without a connection.
 */

// Sri Lanka in practice. Override per deployment rather than per request: a report
// belongs to a school's calendar, not to whichever tablet happened to open it.
const REPORT_TZ = process.env.APP_TIMEZONE || 'Asia/Colombo';

const DAY_MS = 86400000;

/**
 * How far ahead of UTC `tz` is at a given instant, in milliseconds.
 *
 * Derived from Intl rather than a table, so it needs no timezone package and
 * stays correct as the IANA database is updated underneath Node.
 */
function offsetAt(utcMs, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));

  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  // hour comes back as 24 at midnight under hour12:false in some ICU versions.
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - utcMs;
}

/**
 * Local midnight of `YYYY-MM-DD` in `tz`, as a UTC instant.
 *
 * Two passes: read the wall time as if it were UTC, then correct by the offset
 * that actually applies at the resulting instant. The second pass is what makes
 * this right across a DST boundary — Sri Lanka has none, but the helper is used
 * for period edges and should not be quietly wrong if the app is ever deployed
 * somewhere that does.
 */
function zonedDayToUtc(isoDate, tz = REPORT_TZ) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  return new Date(guess - offsetAt(guess - offsetAt(guess, tz), tz));
}

/** The local calendar date, `YYYY-MM-DD`, that an instant falls on in `tz`. */
function localDateOf(instant, tz = REPORT_TZ) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instant instanceof Date ? instant : new Date(instant));
}

/** Plain date arithmetic on `YYYY-MM-DD`, with no timezone in play. */
function addDays(isoDate, n) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return toIso(new Date(Date.UTC(y, m - 1, d + n)));
}

function toIso(utcDate) {
  return utcDate.toISOString().slice(0, 10);
}

/**
 * The Monday on or before `isoDate`.
 *
 * ⚠️ Reports use a Monday–Sunday week. `teacherService.startOfWeek()` uses Sunday
 * and the server's own clock. The two are NOT interchangeable and are not meant
 * to be: the dashboard's "this week" is an existing contract with its own
 * on-screen meaning, while a report labelled "week of 18 August" should start on
 * the school week a teacher recognises. Do not "fix" one to match the other
 * without changing what both screens say.
 */
function startOfWeekLocal(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();  // 0 Sun … 6 Sat
  return addDays(isoDate, -((dow + 6) % 7));
}

/** The first of the month `isoDate` falls in. */
function startOfMonthLocal(isoDate) {
  return `${isoDate.slice(0, 7)}-01`;
}

/** The first of the month after the one `isoDate` falls in. */
function startOfNextMonth(isoDate) {
  const [y, m] = isoDate.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

function fmt(isoDate, opts) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opts })
    .format(new Date(Date.UTC(y, m - 1, d)));
}

/** "17 – 23 Aug 2026" within one month, "31 Aug – 6 Sep 2026" across two. */
function rangeLabel(startIso, endIso) {
  const sameMonth = startIso.slice(0, 7) === endIso.slice(0, 7);
  const left = sameMonth
    ? fmt(startIso, { day: 'numeric' })
    : fmt(startIso, { day: 'numeric', month: 'short' });
  return `${left} – ${fmt(endIso, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

/**
 * One period, resolved from a type and any date inside it.
 *
 * `start` is snapped to the period's real beginning, so a caller may pass any day
 * of the week or month and still get the same canonical period back. That snap is
 * what makes the unique key on `concept_reports` do its job — without it, two
 * teachers generating "this week" on different days would create two rows for the
 * same seven days.
 *
 * Returns the local dates for storage and display, and the half-open UTC instants
 * [from, to) for the query. Half-open means a period boundary belongs to exactly
 * one report rather than being counted in both.
 */
function resolvePeriod({ type, start, tz = REPORT_TZ } = {}) {
  if (type !== 'week' && type !== 'month') {
    throw new Error(`Unknown period type: ${type}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(start || ''))) {
    throw new Error(`Period start must be YYYY-MM-DD, got: ${start}`);
  }

  const periodStart = type === 'week' ? startOfWeekLocal(start) : startOfMonthLocal(start);
  const nextStart   = type === 'week' ? addDays(periodStart, 7) : startOfNextMonth(periodStart);
  const periodEnd   = addDays(nextStart, -1);

  return {
    type,
    period_start: periodStart,
    period_end:   periodEnd,
    from: zonedDayToUtc(periodStart, tz),
    to:   zonedDayToUtc(nextStart, tz),
    label: type === 'week'
      ? `Week of ${fmt(periodStart, { day: 'numeric', month: 'short', year: 'numeric' })}`
      : fmt(periodStart, { month: 'long', year: 'numeric' }),
    // Spelled out for the report header and the PDF, where "17 – 23 Aug 2026"
    // says more than the label alone. The month is printed once when both ends
    // share it and twice when they do not — a week running 31 Aug – 6 Sep has to
    // name both, or it reads as a week in August that ends on the 6th.
    range_label: type === 'week'
      ? rangeLabel(periodStart, periodEnd)
      : `1 – ${fmt(periodEnd, { day: 'numeric', month: 'short', year: 'numeric' })}`,
  };
}

/**
 * The weeks and months that actually contain something, newest first.
 *
 * Built from the days the child was actually active rather than by walking the
 * calendar between a first and last session, so a teacher is never offered a week
 * that would generate an empty report. The gaps matter: a child who was ill for a
 * fortnight should not be shown two blank weeks to pick from.
 *
 * @param {string[]} activeDates local `YYYY-MM-DD` dates that hold data
 */
function periodsFromDates(activeDates = []) {
  const weeks  = new Map();
  const months = new Map();

  for (const date of activeDates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    for (const [type, bucket] of [['week', weeks], ['month', months]]) {
      const period = resolvePeriod({ type, start: date });
      const seen = bucket.get(period.period_start);
      if (seen) seen.active_days += 1;
      else bucket.set(period.period_start, { ...period, from: undefined, to: undefined, active_days: 1 });
    }
  }

  const newestFirst = (a, b) => (a.period_start < b.period_start ? 1 : -1);
  return {
    weeks:  [...weeks.values()].sort(newestFirst),
    months: [...months.values()].sort(newestFirst),
  };
}

module.exports = {
  REPORT_TZ,
  resolvePeriod,
  periodsFromDates,
  zonedDayToUtc,
  localDateOf,
  startOfWeekLocal,
};
