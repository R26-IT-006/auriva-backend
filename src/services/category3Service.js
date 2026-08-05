'use strict';

const {
  DialogueWord,
  DialogueWordProgress,
  DialoguePhase3Attempt,
  ActionWordAttempt,
  CanYouGameRound,
  ActionIdentificationRound,
  VerbQAProductionRound,
  Student,
  Session,
} = require('../models');
const ApiError         = require('../utils/ApiError');
const speechAssessment = require('./speechAssessmentService');

// RC3 — echolalia detection thresholds (mirrors dialogueService.js)
const ECHOLALIA_THRESHOLD_MS = 1500;
const ECHOLALIA_EMA_ALPHA    = 0.3;
const ECHOLALIA_MIC_DELAY_MS = 3000;

// ── Helpers ───────────────────────────────────────────────────────────────

function todayString() {
  return new Date().toISOString().split('T')[0];
}

// Yes and No standalone words are seeded into dialogue_words with these asset_keys.
const STANDALONE_ASSET_KEYS = ['cat3_yes', 'cat3_no'];

// Cat3 teaching order is independent of dialogue_words teaching_order.
const CAT3_ASSET_ORDER = ['cat3_yes', 'cat3_no', 'clap', 'run', 'walk', 'jump', 'talk', 'dance', 'sing'];

// Avatar animation asset is derived from the word's asset_key.
const ANIMATION_MAP = {
  clap:  'anim_clap',
  run:   'anim_run',
  walk:  'anim_walk',
  jump:  'anim_jump',
  talk:  'anim_talk',
  dance: 'anim_dance',
  sing:  'anim_sing',
};

function isStandalone(word) {
  return STANDALONE_ASSET_KEYS.includes(word.asset_key);
}

function animationAsset(word) {
  return ANIMATION_MAP[word.asset_key] ?? null;
}

function cat3SortIndex(word) {
  const idx = CAT3_ASSET_ORDER.indexOf(word.asset_key);
  return idx === -1 ? 999 : idx;
}

async function assertStudentBelongsToTeacher(teacherId, studentId) {
  const student = await Student.findOne({ where: { sid: studentId, teacher_id: teacherId } });
  if (!student) throw new ApiError(404, 'Student not found or not assigned to you');
  return student;
}

async function assertCat3WordExists(wordId) {
  const word = await DialogueWord.findOne({
    where: { id: wordId, category: 'abilities' },
  });
  if (!word) throw new ApiError(404, 'Category 3 word not found');
  return word;
}

async function getOrCreateProgress(studentId, wordId) {
  const [progress] = await DialogueWordProgress.findOrCreate({
    where: { student_id: studentId, word_id: wordId },
    defaults: {
      student_id:             studentId,
      word_id:                wordId,
      status:                 'not_started',
      phase1_gate_passed:     false,
      session_pass_count:     0,
      last_pass_date:         null,
      last_session_date:      null,
      consecutive_fail_count: 0,
      total_sessions:         0,
      non_verbal_count:       0,
    },
  });
  return progress;
}

// Fetches all Cat3 abilities words (Yes, No + Clap–Sing) with this student's progress.
async function fetchCat3WordsWithProgress(studentId) {
  const words = await DialogueWord.findAll({
    where: { category: 'abilities', difficulty: 1 },
    include: [{
      model: DialogueWordProgress,
      as: 'cat3Progress',
      where: { student_id: studentId },
      required: false,
    }],
  });

  return words
    .map((w) => {
      const plain    = w.get({ plain: true });
      const progress = plain.cat3Progress?.[0] ?? null;
      return { word: plain, progress };
    })
    .sort((a, b) => cat3SortIndex(a.word) - cat3SortIndex(b.word));
}

function formatWord(word, progress) {
  return {
    id:                 word.id,
    word:               word.word,
    word_type:          isStandalone(word) ? 'standalone' : 'action_verb',
    asset_key:          word.asset_key,
    cue_grapheme:       word.cue_grapheme,
    animation_asset:    animationAsset(word),
    keyword_triggers:   word.keyword_triggers,
    status:             progress?.status ?? 'not_started',
    phase1_gate_passed: progress?.phase1_gate_passed ?? false,
    session_pass_count: progress?.session_pass_count ?? 0,
  };
}

// ── Word Teaching (UC1) ───────────────────────────────────────────────────

async function getCat3Overview(teacherId, studentId) {
  await assertStudentBelongsToTeacher(teacherId, studentId);
  const entries = await fetchCat3WordsWithProgress(studentId);
  return entries.map(({ word, progress }) => formatWord(word, progress));
}

/**
 * Returns the next word to teach in Cat3 order.
 * Yes and No (standalone) must both be mastered before any action_verb is returned.
 */
async function getNextWord(teacherId, studentId) {
  await assertStudentBelongsToTeacher(teacherId, studentId);

  const entries = await fetchCat3WordsWithProgress(studentId);

  const allStandaloneMastered = entries
    .filter(({ word }) => isStandalone(word))
    .every(({ progress }) => progress?.status === 'mastered');

  const today = todayString();

  const candidates = entries.filter(({ word, progress }) => {
    if (progress?.status === 'mastered') return false;
    if (progress?.last_session_date === today) return false;
    if (!isStandalone(word) && !allStandaloneMastered) return false;
    return true;
  });

  const pick =
    candidates.find(({ progress }) => progress?.status === 'in_progress') ??
    candidates.find(({ progress }) => !progress || progress.status === 'not_started') ??
    null;

  if (!pick) return null;
  return formatWord(pick.word, pick.progress);
}

/**
 * POST /phase1-tap
 * Engagement tap during Phase 1 avatar performance — non-scored.
 * Marks word in_progress on first tap.
 */
async function recordPhase1Tap(teacherId, studentId, wordId) {
  await assertStudentBelongsToTeacher(teacherId, studentId);
  await assertCat3WordExists(wordId);
  const progress = await getOrCreateProgress(studentId, wordId);
  if (progress.status === 'not_started') {
    await progress.update({ status: 'in_progress', updated_at: new Date() });
  }
  return { logged: true };
}

/**
 * POST /drag-to-line
 * Records the DragToLine recognition gate result.
 * Gate is always considered passed regardless of result; result is logged for analytics.
 */
async function recordDragToLine(teacherId, studentId, wordId, { result, session_id }) {
  await assertStudentBelongsToTeacher(teacherId, studentId);
  await assertCat3WordExists(wordId);

  const progress = await getOrCreateProgress(studentId, wordId);
  if (!progress.phase1_gate_passed) {
    await progress.update({ phase1_gate_passed: true, status: 'in_progress', updated_at: new Date() });
  }

  const existing = session_id
    ? await ActionWordAttempt.findOne({
        where: { student_id: studentId, word_id: wordId, session_id },
        order: [['attempted_at', 'DESC']],
      })
    : null;

  if (existing) {
    await existing.update({ drag_to_line_result: result });
  } else {
    await ActionWordAttempt.create({
      student_id: studentId, word_id: wordId,
      session_id: session_id ?? null, drag_to_line_result: result,
    });
  }

  return { drag_to_line_result: result, gate_passed: true };
}

/**
 * POST /phase2-assess
 * Runs STT + fuzzy matching on the child's spoken word.
 * score >= 2 → advance to Phase 3.  score === 0 three times → non-verbal fallback.
 */
async function assessPhase2Speech(teacherId, studentId, wordId, {
  audio_base64, mime_type, session_id,
  avatar_audio_end_ts, recording_start_ts,
}) {
  await assertStudentBelongsToTeacher(teacherId, studentId);
  const word = await assertCat3WordExists(wordId);

  let activeSessionId = session_id ?? null;
  if (!activeSessionId) {
    // No session yet — this is a word's first Phase 2 attempt, immediately after
    // drag-to-line, which itself ran with no session and wrote a row with
    // session_id=null. Without this, minting a session here and only ever looking
    // for a row under the NEW id later would silently orphan that drag-to-line row,
    // splitting one interaction across two disconnected ActionWordAttempt rows
    // (confirmed against real pilot data — see STATE.md 2026-07-21). Adopt the most
    // recent orphaned row for this (student, word) by backfilling its session_id, so
    // the "existing" lookup below finds and merges into it instead of creating a
    // second row.
    const orphanRow = await ActionWordAttempt.findOne({
      where: { student_id: studentId, word_id: wordId, session_id: null },
      order: [['attempted_at', 'DESC']],
    });

    const session = await Session.create({
      teacher_id: teacherId, student_id: studentId,
      started_at: new Date(), is_active: true,
    });
    activeSessionId = session.id;

    if (orphanRow) {
      await orphanRow.update({ session_id: activeSessionId });
    }
  }

  const {
    score, transcript, match_type, phoneme_error_class, phoneme_accuracy, first_word_offset_ms,
  } = await speechAssessment.assessSpeech(
    audio_base64, mime_type, word.keyword_triggers
  );

  // ── RC3 — echolalia detection (mirrors dialogueService.assessPhase2Speech) ─
  let response_latency_ms = null;
  let echolalia_flag = false;
  if (avatar_audio_end_ts && recording_start_ts) {
    const childSpeechOnsetTs = recording_start_ts + (first_word_offset_ms ?? 0);
    response_latency_ms = Math.max(0, childSpeechOnsetTs - avatar_audio_end_ts);
    echolalia_flag = response_latency_ms < ECHOLALIA_THRESHOLD_MS;
  }

  const progress = await getOrCreateProgress(studentId, wordId);
  const newConsecFails = score === 0 ? progress.consecutive_fail_count + 1 : 0;

  // RC3 — running echolalia rate (same EMA approach as dialogueService.js)
  const newEcholaliaRate = progress.echolalia_rate
    + ECHOLALIA_EMA_ALPHA * ((echolalia_flag ? 1 : 0) - progress.echolalia_rate);

  await progress.update({
    consecutive_fail_count: newConsecFails,
    status: 'in_progress',
    echolalia_rate: newEcholaliaRate,
    updated_at: new Date(),
  });

  const existing = await ActionWordAttempt.findOne({
    where: { student_id: studentId, word_id: wordId, session_id: activeSessionId },
    order: [['attempted_at', 'DESC']],
  });

  const attemptFields = {
    phase2_speech_score:        score,
    phase2_transcript:          transcript,
    phase2_match_type:          match_type,
    phase2_phoneme_error_class: phoneme_error_class,
    phase2_phoneme_accuracy:    phoneme_accuracy,
    phase2_response_latency_ms: response_latency_ms,
    phase2_echolalia_flag:      echolalia_flag,
  };

  if (existing) {
    await existing.update(attemptFields);
  } else {
    await ActionWordAttempt.create({
      student_id: studentId, word_id: wordId, session_id: activeSessionId,
      ...attemptFields,
    });
  }

  return {
    score, transcript, match_type,
    session_id:        activeSessionId,
    advance_to_phase3: score >= 2,
    trigger_nonverbal:      score === 0 && newConsecFails >= 3,
    consecutive_fail_count: newConsecFails,
    mic_delay_ms:           newEcholaliaRate > 0.5 ? ECHOLALIA_MIC_DELAY_MS : 0,
  };
}

/**
 * POST /phase2-nonverbal
 * Word-to-Action Matching fallback. Child always advances to Phase 3 after this.
 */
async function recordPhase2NonVerbal(teacherId, studentId, wordId, { tap_correct, session_id }) {
  await assertStudentBelongsToTeacher(teacherId, studentId);
  await assertCat3WordExists(wordId);

  const progress = await getOrCreateProgress(studentId, wordId);
  await progress.update({
    non_verbal_count: progress.non_verbal_count + 1,
    status: 'in_progress', updated_at: new Date(),
  });

  const existing = session_id
    ? await ActionWordAttempt.findOne({
        where: { student_id: studentId, word_id: wordId, session_id },
        order: [['attempted_at', 'DESC']],
      })
    : null;

  if (existing) {
    await existing.update({ phase2_speech_score: tap_correct ? 1 : 0, phase2_match_type: 'non_verbal' });
  } else {
    await ActionWordAttempt.create({
      student_id: studentId, word_id: wordId, session_id: session_id ?? null,
      phase2_speech_score: tap_correct ? 1 : 0, phase2_match_type: 'non_verbal',
    });
  }

  return { tap_correct, non_verbal_count: progress.non_verbal_count + 1, advance_to_phase3: true };
}

/**
 * POST /phase3-check
 * Records the Action Identification Check.
 * correct_on_first=true → attempts=1; otherwise child gets a second attempt.
 * If second also wrong → phase3_correct=false, session scored as failed.
 */
async function recordPhase3Check(teacherId, studentId, wordId, {
  correct_on_first, second_attempt_correct, session_id,
  attempt1_latency_ms, attempt2_latency_ms,
  attempt1_first_tap_correct, attempt2_first_tap_correct,
  attempt1_selection_change_count, attempt2_selection_change_count,
  attempt1_prompt_count, attempt2_prompt_count,
}) {
  await assertStudentBelongsToTeacher(teacherId, studentId);
  await assertCat3WordExists(wordId);

  const phase3Correct = correct_on_first || second_attempt_correct === true;
  const attempts      = correct_on_first ? 1 : 2;

  const existing = session_id
    ? await ActionWordAttempt.findOne({
        where: { student_id: studentId, word_id: wordId, session_id },
        order: [['attempted_at', 'DESC']],
      })
    : null;

  if (existing) {
    await existing.update({ phase3_correct: phase3Correct, phase3_attempts: attempts });
  } else {
    await ActionWordAttempt.create({
      student_id: studentId, word_id: wordId, session_id: session_id ?? null,
      phase3_correct: phase3Correct, phase3_attempts: attempts,
    });
  }

  // ── RC2 feature logging into dialogue_phase3_attempts ─────────────────
  await DialoguePhase3Attempt.create({
    student_id:             studentId,
    word_id:                wordId,
    session_id:             session_id ?? null,
    scenario_label:         'A',
    phase3_correct:         correct_on_first,
    response_latency_ms:    attempt1_latency_ms ?? null,
    selection_change_count: attempt1_selection_change_count ?? 0,
    prompt_count:           attempt1_prompt_count ?? 1,
    first_tap_correct:      attempt1_first_tap_correct ?? null,
  });

  if (second_attempt_correct !== undefined) {
    await DialoguePhase3Attempt.create({
      student_id:             studentId,
      word_id:                wordId,
      session_id:             session_id ?? null,
      scenario_label:         'B',
      phase3_correct:         second_attempt_correct,
      response_latency_ms:    attempt2_latency_ms ?? null,
      selection_change_count: attempt2_selection_change_count ?? 0,
      prompt_count:           attempt2_prompt_count ?? 1,
      first_tap_correct:      attempt2_first_tap_correct ?? null,
    });
  }

  return { phase3_correct: phase3Correct, attempts };
}

/**
 * POST /complete
 * Finalises the word teaching session and applies the mastery algorithm.
 * Session passes when: Phase 2 speech score >= 2 AND phase3_passed = true.
 * Mastery: 2+ passing sessions on different calendar days.
 * Struggling: consecutive_fail_count reaches 3.
 */
async function completeWordSession(teacherId, studentId, wordId, { phase3_passed, session_id }) {
  await assertStudentBelongsToTeacher(teacherId, studentId);
  await assertCat3WordExists(wordId);

  const progress = await getOrCreateProgress(studentId, wordId);

  const lastAttempt = session_id
    ? await ActionWordAttempt.findOne({
        where: { student_id: studentId, word_id: wordId, session_id },
        order: [['attempted_at', 'DESC']],
      })
    : await ActionWordAttempt.findOne({
        where: { student_id: studentId, word_id: wordId },
        order: [['attempted_at', 'DESC']],
      });

  const phase2Score     = lastAttempt?.phase2_speech_score ?? 0;
  const phase2Echolalic = lastAttempt?.phase2_echolalia_flag === true; // RC3
  const sessionPassed   = phase2Score >= 2 && phase3_passed;

  const today             = todayString();
  let newStatus           = progress.status;
  let newSessionPassCount = progress.session_pass_count;
  let newLastPassDate     = progress.last_pass_date;
  let newConsecFails      = progress.consecutive_fail_count;
  const newTotalSessions  = progress.total_sessions + 1;
  let mastered            = false;

  if (sessionPassed && phase2Echolalic) {
    // RC3 — echolalic pass: stays in_progress, no mastery credit, no fail penalty
    newStatus      = 'in_progress';
    newConsecFails = 0;
  } else if (sessionPassed) {
    const differentDay  = progress.last_pass_date && progress.last_pass_date !== today;
    newSessionPassCount = progress.session_pass_count + 1;
    newLastPassDate     = today;
    newConsecFails      = 0;
    if (newSessionPassCount >= 2 && differentDay) {
      newStatus = 'mastered';
      mastered  = true;
    } else {
      newStatus = 'in_progress';
    }
  } else {
    newConsecFails = progress.consecutive_fail_count + 1;
    if (newConsecFails >= 3) newStatus = 'struggling';
  }

  await progress.update({
    status: newStatus, phase1_gate_passed: false,
    session_pass_count: newSessionPassCount, last_pass_date: newLastPassDate,
    last_session_date: today,
    consecutive_fail_count: newConsecFails, total_sessions: newTotalSessions, updated_at: new Date(),
  });

  if (lastAttempt) await lastAttempt.update({ session_passed: sessionPassed });

  return { session_passed: sessionPassed, mastered, status: newStatus, session_pass_count: newSessionPassCount };
}

// ── Activity 3.1 – Can You? Tap and Say ──────────────────────────────────

async function getCanYouSession(teacherId, studentId) {
  await assertStudentBelongsToTeacher(teacherId, studentId);

  const entries = await fetchCat3WordsWithProgress(studentId);

  const yesNoIntroduced = entries
    .filter(({ word }) => isStandalone(word))
    .every(({ progress }) => (progress?.status ?? 'not_started') !== 'not_started');

  if (!yesNoIntroduced) {
    throw new ApiError(422, 'Yes and No must be introduced before Activity 3.1.');
  }

  const masteredVerbs = entries.filter(
    ({ word, progress }) => !isStandalone(word) && progress?.status === 'mastered'
  );

  if (masteredVerbs.length === 0) {
    throw new ApiError(422, 'At least one action verb must be mastered before Activity 3.1.');
  }

  return {
    mastered_verbs: masteredVerbs.map(({ word }) => ({
      id:              word.id,
      word:            word.word,
      asset_key:       word.asset_key,
      animation_asset: animationAsset(word),
    })),
    rounds_per_session: 4,
  };
}

async function recordCanYouRound(teacherId, studentId, {
  word_id, tap_response, voice_attempted, speech_detected, session_id, round_order,
}) {
  await assertStudentBelongsToTeacher(teacherId, studentId);
  await assertCat3WordExists(word_id);

  const round = await CanYouGameRound.create({
    student_id:      studentId,
    word_id,
    session_id:      session_id ?? null,
    tap_response,
    voice_attempted: voice_attempted ?? false,
    speech_detected: speech_detected ?? false,
    round_order,
  });

  return { id: round.id, logged: true };
}

// ── Activity 3.2 – What Am I Doing? ──────────────────────────────────────

async function getActionIdentificationSession(teacherId, studentId) {
  await assertStudentBelongsToTeacher(teacherId, studentId);

  const entries = await fetchCat3WordsWithProgress(studentId);
  const verbEntries = entries.filter(({ word }) => !isStandalone(word));

  const masteredVerbs    = verbEntries.filter(({ progress }) => progress?.status === 'mastered');
  const introducedVerbs  = verbEntries.filter(({ progress }) => (progress?.status ?? 'not_started') !== 'not_started');

  if (masteredVerbs.length < 2) {
    throw new ApiError(422, 'At least 2 mastered action verbs are required for Activity 3.2.');
  }

  return {
    available_verbs: masteredVerbs.map(({ word }) => ({
      id:              word.id,
      word:            word.word,
      asset_key:       word.asset_key,
      animation_asset: animationAsset(word),
    })),
    // Distractor pool: all introduced verbs (per Business Rule 1 — no uninstructed words)
    distractor_pool: introducedVerbs.map(({ word }) => ({
      id: word.id, word: word.word, asset_key: word.asset_key,
    })),
    rounds_per_session: 4,
  };
}

async function recordActionIdentificationRound(teacherId, studentId, {
  word_id, distractor_word_ids, first_attempt_correct,
  required_hint, auto_advanced, response_given, session_id, round_order,
}) {
  await assertStudentBelongsToTeacher(teacherId, studentId);
  await assertCat3WordExists(word_id);

  const round = await ActionIdentificationRound.create({
    student_id:           studentId,
    word_id,
    session_id:           session_id ?? null,
    distractor_word_ids:  distractor_word_ids ?? [],
    first_attempt_correct,
    required_hint:        required_hint ?? false,
    auto_advanced:        auto_advanced ?? false,
    response_given:       response_given ?? null,
    round_order,
  });

  return { id: round.id, logged: true };
}

// ── Activity 3.3 – Verb Q&A Production ───────────────────────────────────

async function getVerbQASession(teacherId, studentId) {
  await assertStudentBelongsToTeacher(teacherId, studentId);

  const has31 = await CanYouGameRound.findOne({ where: { student_id: studentId } });
  if (!has31) throw new ApiError(422, 'Activity 3.1 must be completed at least once first.');

  const has32 = await ActionIdentificationRound.findOne({ where: { student_id: studentId } });
  if (!has32) throw new ApiError(422, 'Activity 3.2 must be completed at least once first.');

  const entries = await fetchCat3WordsWithProgress(studentId);
  const masteredVerbs = entries.filter(
    ({ word, progress }) => !isStandalone(word) && progress?.status === 'mastered'
  );

  if (masteredVerbs.length === 0) {
    throw new ApiError(422, 'No mastered action verbs available for Activity 3.3.');
  }

  return {
    mastered_verbs: masteredVerbs.map(({ word }) => ({
      id:              word.id,
      word:            word.word,
      asset_key:       word.asset_key,
      animation_asset: animationAsset(word),
    })),
    rounds_per_session: 4,
  };
}

// Expected response arrays — FSD Business Rule 2
const YES_I_CAN_TRIGGERS = {
  score3: ['yes i can', 'yeh i can', 'ya i can', 'yes i ken'],
  score2: ['yes can', 'i can', 'yes i'],
  score1: ['yes', 'can'],
};

const NO_I_CANT_TRIGGERS = {
  score3: ['no i cant', 'no i cannot', 'no i can not'],
  score2: ['cant', 'i cannot', 'no cant'],
  score1: ['no', 'cant', 'cannot'],
};

/**
 * POST /cat3/activity/3.3/round
 * Tap on response card selects intended phrase; only speech is scored.
 */
async function assessVerbQARound(teacherId, studentId, {
  word_id, intended_response, audio_base64, mime_type, session_id, round_order,
}) {
  await assertStudentBelongsToTeacher(teacherId, studentId);
  await assertCat3WordExists(word_id);

  const triggers = intended_response === 'yes_i_can' ? YES_I_CAN_TRIGGERS : NO_I_CANT_TRIGGERS;
  const { score, transcript, match_type } = await speechAssessment.assessSpeech(
    audio_base64, mime_type, triggers
  );

  const round = await VerbQAProductionRound.create({
    student_id: studentId, word_id,
    session_id: session_id ?? null,
    intended_response, speech_score: score, transcript, match_type,
    non_verbal_fallback_used: false, round_order,
  });

  return { id: round.id, score, transcript, match_type, advance: score >= 2, trigger_nonverbal: score === 0 };
}

/**
 * POST /cat3/activity/3.3/round/nonverbal
 * Score 0 → response cards remain visible; child taps the correct card.
 * Updates the existing round if one was created for this session, otherwise creates it.
 */
async function recordVerbQANonVerbal(teacherId, studentId, {
  word_id, intended_response, tap_response, session_id, round_order,
}) {
  await assertStudentBelongsToTeacher(teacherId, studentId);
  await assertCat3WordExists(word_id);

  const existing = session_id
    ? await VerbQAProductionRound.findOne({
        where: { student_id: studentId, word_id, session_id, speech_score: 0 },
        order: [['played_at', 'DESC']],
      })
    : null;

  if (existing) {
    await existing.update({ non_verbal_fallback_used: true, tap_response, match_type: 'non_verbal' });
    return { id: existing.id, logged: true };
  }

  const round = await VerbQAProductionRound.create({
    student_id: studentId, word_id,
    session_id: session_id ?? null,
    intended_response, speech_score: 0, match_type: 'non_verbal',
    non_verbal_fallback_used: true, tap_response, round_order,
  });

  return { id: round.id, logged: true };
}

module.exports = {
  getCat3Overview,
  getNextWord,
  recordPhase1Tap,
  recordDragToLine,
  assessPhase2Speech,
  recordPhase2NonVerbal,
  recordPhase3Check,
  completeWordSession,
  getCanYouSession,
  recordCanYouRound,
  getActionIdentificationSession,
  recordActionIdentificationRound,
  getVerbQASession,
  assessVerbQARound,
  recordVerbQANonVerbal,
};
