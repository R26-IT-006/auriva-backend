-- FSD-PROMPT-HIERARCHY-001: add cue_grapheme to dialogue_words
ALTER TABLE dialogue_words
  ADD COLUMN IF NOT EXISTS cue_grapheme VARCHAR(10);
