-- Cat3 (abilities) sub-activities 3.1 (Can You? Tap and Say), 3.2 (What Am I
-- Doing?), and 3.3 (Verb Q&A Production) were built backend-only in May 2026
-- and never got a frontend implementation. A 2026-08-16 audit confirmed the
-- frontend has no API wrapper and no screen calling any of these endpoints,
-- so no row could ever have been written to these tables. Human confirmed
-- these activities will not be built; application code (routes, controller
-- functions, service functions, models) was removed in the same change.
--
-- Before running, confirm the tables are actually empty:
--   SELECT count(*) FROM can_you_game_rounds;
--   SELECT count(*) FROM action_identification_rounds;
--   SELECT count(*) FROM verb_qa_production_rounds;

DROP TABLE IF EXISTS can_you_game_rounds;
DROP TABLE IF EXISTS action_identification_rounds;
DROP TABLE IF EXISTS verb_qa_production_rounds;

-- Sequelize auto-creates a Postgres ENUM type per ENUM column; dropping the
-- tables above does not drop these, so they'd otherwise be left orphaned.
DROP TYPE IF EXISTS enum_can_you_game_rounds_tap_response;
DROP TYPE IF EXISTS enum_action_identification_rounds_response_given;
DROP TYPE IF EXISTS enum_verb_qa_production_rounds_intended_response;
DROP TYPE IF EXISTS enum_verb_qa_production_rounds_match_type;
DROP TYPE IF EXISTS enum_verb_qa_production_rounds_tap_response;
