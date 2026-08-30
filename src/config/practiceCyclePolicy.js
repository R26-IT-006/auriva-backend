'use strict';

/**
 * practiceCyclePolicy.js
 *
 * The hard ceiling on how much practice one letter may receive in one day,
 * and the date rule that defines "one day".
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * Until now there was NO ceiling at all. A failed 3-attempt cycle reset the
 * child straight back to attempt 1 on the same letter, forever, until they
 * passed — see LetterWritingScreen's failure branch, and repetitionPolicy.js's
 * own header, which states plainly that the immediate same-letter retry is
 * "still unbounded". A child who could not yet form `c` would sit on `c`.
 *
 * The rule now:
 *
 *   at most THREE completed 3-attempt cycles
 *   per (student, letter, case_type, practice date)
 *
 * = 9 real attempts. Each failed cycle is followed immediately by the next
 * one on the same letter. If Cycle 3 also fails, the letter is set aside for
 * the rest of that date, home practice is recommended for that exact letter,
 * and it becomes eligible again on the next practice date.
 *
 * Raised from TWO to THREE alongside the Attempt-3-only mastery rule (see
 * config/masteryPolicy.js). The two changes belong together: mastery is now
 * judged on the UNGUIDED attempt only, which is materially harder — the
 * retrospective analysis put mastery at 96.2% under best-of-3 versus 73.4%
 * under attempt-3-only. A third cycle restores some of the room the stricter
 * gate removes, rather than simply making the day harder.
 *
 * ── This ceiling is AUTHORITATIVE ────────────────────────────────────────
 * It binds every path that could start a cycle, not just the immediate retry:
 * Feature 5's spaced repetition must also refuse to reinsert a letter that
 * has already used its three cycles today (see repetitionRecommendationService).
 * Two mechanisms, one ceiling.
 *
 * ── Not clinically validated ─────────────────────────────────────────────
 * `3` is a conservative engineering/pilot default in the same tradition as
 * Feature 2's +5 margin and Feature 3's 4-of-5 rule — a safety rule requiring
 * teacher/pilot validation, not a clinical prescription.
 */

const MAX_CYCLES_PER_LETTER_PER_DATE = 3;

/**
 * The timezone a "practice date" is measured in.
 *
 * Deliberately a named zone, not a fixed offset: the boundary between one
 * practice date and the next must fall at LOCAL midnight, where no child is
 * writing. Measuring in raw UTC would roll the day over at 05:30 local time
 * here, so a morning session could be split across two "dates" and silently
 * grant a letter four cycles.
 *
 * Note that the periodic report's own daily bucketing still uses raw UTC
 * (periodicReportService.buildDailySeries). That is a separate, reporting-only
 * concern and was deliberately left alone — this constant governs the practice
 * CAP only. If the two are ever unified, unify them here.
 */
const PRACTICE_TIMEZONE = 'Asia/Colombo';

// 'en-CA' formats as YYYY-MM-DD, which sorts and compares as a plain string.
const PRACTICE_DATE_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: PRACTICE_TIMEZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
});

/**
 * The practice date a timestamp belongs to, as 'YYYY-MM-DD' in
 * PRACTICE_TIMEZONE.
 *
 * @param {Date|string|number} timestamp
 * @returns {string|null} null for anything unparseable — callers must treat
 *   that as "unknown date", never as "today".
 */
function toPracticeDate(timestamp) {
  const d = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(d.getTime())) return null;
  return PRACTICE_DATE_FORMAT.format(d);
}

/** Today's practice date. */
function currentPracticeDate(now = new Date()) {
  return toPracticeDate(now);
}

// Stable reason vocabulary — never an overloaded generic string.
const CYCLE_CAP_REASON = {
  WITHIN_CAP: 'within_cap',
  CAP_REACHED: 'cycle_cap_reached_for_date',
  UNKNOWN_DATE: 'unknown_practice_date',
  READ_FAILED: 'read_failed',
};

module.exports = {
  MAX_CYCLES_PER_LETTER_PER_DATE,
  PRACTICE_TIMEZONE,
  toPracticeDate,
  currentPracticeDate,
  CYCLE_CAP_REASON,
};
