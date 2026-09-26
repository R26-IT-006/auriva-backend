-- FSD-PROBE-001: Rule 5 — periodic production probe. Lets a teacher
-- re-check a non-verbal-mastered word for emerged speech without ever
-- risking the word's mastery status. Probe writes are narrow by design:
-- they never touch status/current_phase/session_pass_count/
-- consecutive_fail_count/phase2_zero_streak (see recordProbeResult() in
-- dialogueService.js/category3Service.js). is_probe on the attempt tables
-- lets analytics/ML queries exclude probe rows from baseline ordering.
-- No backfill — every existing row starts at NULL/false, same "honestly
-- excluded, never backfilled" precedent as DEC-06/R-24/TASK-34/TASK-35.
ALTER TABLE dialogue_word_progress
  ADD COLUMN last_probe_date DATE NULL;

ALTER TABLE dialogue_word_attempts
  ADD COLUMN is_probe BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE action_word_attempts
  ADD COLUMN is_probe BOOLEAN NOT NULL DEFAULT false;
