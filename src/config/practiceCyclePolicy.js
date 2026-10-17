'use strict';

/**
 * practiceCyclePolicy.js — daily practice-cycle limit and the practice-date rule.
 *
 * Rule: at most THREE completed 3-attempt cycles (9 attempts) per
 * (student, letter, case_type, practice date). Without a ceiling, a child who
 * could not yet form a letter would repeat it indefinitely.
 *
 * Cycle 1 fail -> Cycle 2. Cycle 2 fail -> short warm-up, then Cycle 3.
 * Cycle 3 fail -> the letter is set aside for the rest of that date, becomes
 * a home-practice candidate, and is eligible again on the next practice date.
 *
 * Raised from two to three cycles together with the attempt-3-only mastery
 * rule (masteryPolicy.js): judging only the unguided attempt is harder (the
 * retrospective analysis put mastery at 96.2% under best-of-3 versus 73.4%
 * under attempt-3-only), and a third cycle restores some of that room.
 *
 * ── Where the limit is enforced ──────────────────────────────────────────
 *   - Client: letterCycleGuard (frontend) stops the immediate retry, seeded
 *     with the server's per-date count returned as `cycle_usage`.
 *   - Server: repetitionRecommendationService refuses to reinsert a letter
 *     that reached the cap today.
 * recordLetterCompletion counts and reports cycles but does not itself reject
 * a fourth cycle's submission.
 *
 * `3` is a pilot engineering default, not clinically validated.
 */

const MAX_CYCLES_PER_LETTER_PER_DATE = 3;

/**
 * The timezone a "practice date" is measured in.
 *
 * A named zone so the day boundary falls at LOCAL midnight. Raw UTC would roll
 * the day over at 05:30 local time, splitting a morning session across two
 * dates and allowing extra cycles.
 *
 * Known inconsistency: the periodic report's daily bucketing still uses UTC
 * (periodicReportService.buildDailySeries). This constant governs the
 * practice cap only.
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
