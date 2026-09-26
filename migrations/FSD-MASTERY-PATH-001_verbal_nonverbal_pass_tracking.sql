-- FSD-MASTERY-PATH-001: allow non-verbal Phase 2 success to reach full
-- 'mastered' status (previously blocked — phase2Passed required
-- speech_score >= 2, a threshold non-verbal attempts can never clear since
-- their max speech_score is 1). Adds separate verbal/non-verbal pass
-- counters and a mastery_path label so the path taken stays visible for
-- teacher reporting and stays distinct in the ML feature set (mirrors
-- R-32's phase1_applicable precedent).
-- No backfill — every existing row starts at 0/NULL, same "honestly
-- excluded, never backfilled" precedent as DEC-06/R-24/TASK-34.
ALTER TABLE dialogue_word_progress
  ADD COLUMN verbal_pass_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN non_verbal_pass_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN mastery_path VARCHAR(20) NULL;
