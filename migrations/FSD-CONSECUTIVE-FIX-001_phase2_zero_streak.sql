-- FSD-CONSECUTIVE-FIX-001: separate the two conflated meanings of
-- consecutive_fail_count (session-level Rule 2 counter vs. within-session
-- Phase 2 sub-attempt counter) by giving the latter its own column.
-- Not backfilled from consecutive_fail_count — that history conflates both
-- meanings; every existing row starts at 0 and is correct going forward
-- (see DEC-06/R-24 "honestly excluded, never backfilled" precedent).
ALTER TABLE dialogue_word_progress
  ADD COLUMN phase2_zero_streak INTEGER NOT NULL DEFAULT 0;
