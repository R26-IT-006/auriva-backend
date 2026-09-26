CREATE TABLE dialogue_evaluation_attempts (
  id               SERIAL PRIMARY KEY,
  student_id       INTEGER NOT NULL REFERENCES students(sid),
  category         VARCHAR(32) NOT NULL,   -- 'greetings' | 'magic_words' | 'abilities'
  word_ids         INTEGER[] NOT NULL,     -- the words included in this evaluation
  pairs_detail     JSONB NOT NULL,         -- [{word_id, chosen_word_id_for_image, correct}]
  correct_count    INTEGER NOT NULL,
  total_count      INTEGER NOT NULL,
  attempted_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_eval_attempts_student ON dialogue_evaluation_attempts (student_id, category, attempted_at);
