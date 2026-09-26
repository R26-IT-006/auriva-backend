-- Adds 'describe_friend' and 'describe_pet' to the Level 2 topic enum, and
-- nine friend/pet fields to sentence_questionnaires (TASK-19).
--
-- Enum type name: enum_level2_topic_progress_topic. Not verified live (no DB
-- connection available in this session, per hard rule 12 / no full-boot
-- verification) — this is Sequelize's documented default naming convention
-- (enum_<tableName>_<columnName>) for a sequelize.define(...).ENUM(...)
-- column, and Level2TopicProgress.js's tableName is 'level2_topic_progress'
-- with column 'topic', which produces exactly this name. No migration in
-- this repo created this table's enum (it predates the migration
-- discipline, created via sync()), so there is no other migration to
-- cross-check the name against. Flagged in STATE.md for the human to
-- confirm via \dT before running.
ALTER TYPE "enum_level2_topic_progress_topic" ADD VALUE IF NOT EXISTS 'describe_friend';
ALTER TYPE "enum_level2_topic_progress_topic" ADD VALUE IF NOT EXISTS 'describe_pet';

-- sentence_questionnaires already has portrait_strokes (FSD-L2-PORTRAIT-001)
-- and child_first_name_sinhala (FSD-L2-NAME-001) landed ahead of this
-- migration — purely additive, no conflict with either.
ALTER TABLE sentence_questionnaires
  ADD COLUMN friend_name          VARCHAR(100) NULL,
  ADD COLUMN friend_name_sinhala  VARCHAR(100) NULL,
  ADD COLUMN friend_gender        VARCHAR(10)  NULL,  -- 'boy'|'girl' — see §FRIEND-SENTENCES validation
  ADD COLUMN friend_age           INTEGER      NULL,  -- 5-12, same range as child_age (AgePicker.js)
  ADD COLUMN friend_grade         INTEGER      NULL,  -- 1-8
  ADD COLUMN friend_personality   VARCHAR(20)  NULL,  -- one of: kind, funny, nice (closed set)
  ADD COLUMN pet_type             VARCHAR(20)  NULL,  -- one of: cat,dog,cow,fish,parrot,rabbit
  ADD COLUMN pet_name             VARCHAR(100) NULL,
  ADD COLUMN pet_name_sinhala     VARCHAR(100) NULL;
