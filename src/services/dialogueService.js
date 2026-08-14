'use strict';

const { Op }                    = require('sequelize');
const { DialogueWord, DialogueWordProgress, DialogueWordAttempt, DialoguePhase3Attempt, Student, Session } = require('../models');
const ApiError                  = require('../utils/ApiError');
const speechAssessment          = require('./speechAssessmentService');
const { getTrajectoryPrediction } = require('./trajectoryService');

// RC3 — echolalia detection thresholds
const ECHOLALIA_THRESHOLD_MS = 1500;  // below this, treat as probable echolalia
const ECHOLALIA_EMA_ALPHA    = 0.3;   // smoothing factor for the running echolalia_rate
const ECHOLALIA_MIC_DELAY_MS = 3000;  // delay applied to the next attempt when echolalia_rate > 0.5

// Rule 5 — periodic production probe. tunable default, not yet confirmed
// with student/supervisor — adjust here.
const PROBE_INTERVAL_DAYS = 14;

// ── Helpers ───────────────────────────────────────────────────────────────

function todayString() {
  return new Date().toISOString().split('T')[0]; // 'YYYY-MM-DD'
}

async function assertStudentBelongsToTeacher(teacherId, studentId) {
  const student = await Student.findOne({ where: { sid: studentId, teacher_id: teacherId } });
  if (!student) throw new ApiError(404, 'Student not found or not assigned to you');
  return student;
}

async function assertWordExists(wordId) {
  const word = await DialogueWord.findByPk(wordId);
  if (!word) throw new ApiError(404, 'Dialogue word not found');
  return word;
}

async function getOrCreateProgress(studentId, wordId) {
  const [progress] = await DialogueWordProgress.findOrCreate({
    where: { student_id: studentId, word_id: wordId },
    defaults: {
      student_id: studentId,
      word_id: wordId,
      status: 'not_started',
      current_phase: 1,
      phase1_exposure_count: 0,
      phase1_required_exposures: 4,
      phase1_gate_passed: false,
      session_pass_count: 0,
      last_pass_date: null,
      consecutive_fail_count: 0,
      total_sessions: 0,
      non_verbal_count: 0,
    },
  });
  return progress;
}

// ── Public service functions ──────────────────────────────────────────────

async function getLevel1Overview(teacherId, studentId) {
  await assertStudentBelongsToTeacher(teacherId, studentId);

  const words = await DialogueWord.findAll({
    order: [
      ['category', 'ASC'],
      ['teaching_order', 'ASC'],
    ],
    include: [
      {
        model: DialogueWordProgress,
        as: 'progress',
        where: { student_id: studentId },
        required: false,
      },
    ],
  });

  return words.map((w) => {
    const plain    = w.get({ plain: true });
    const progress = plain.progress?.[0] ?? null;
    return {
      id:             plain.id,
      word:           plain.word,
      category:       plain.category,
      difficulty:     plain.difficulty,
      teaching_order: plain.teaching_order,
      asset_key:      plain.asset_key,
      status:         progress?.status ?? 'not_started',
      current_phase:  progress?.current_phase ?? 1,
      session_pass_count: progress?.session_pass_count ?? 0,
      non_verbal_count:   progress?.non_verbal_count ?? 0,
    };
  });
}

/**
 * Returns the recommended next word for this student.
 *
 * Options:
 *   category        – filter to one category (optional)
 *   exclude_word_id – the word just finished; never returned again this call
 *   session_passed  – true  → relax difficulty gate so a higher-difficulty word
 *                             can be introduced after one session pass
 *   status          – the post-session status of the finished word; used to
 *                     route struggling students to easier words
 *
 * Difficulty gates:
 *   Normal:        all lower-difficulty words must be mastered
 *   Session-pass:  at least one lower-difficulty word has session_pass_count ≥ 1
 *
 * Struggling routing:
 *   D2 struggling → prefer D1 not-mastered, then D2 not-mastered
 *   D3 struggling → prefer D3, then D2, then D1 not-mastered
 */
async function getNextWord(teacherId, studentId, { category = null, exclude_word_id = null, session_passed = null, status = null } = {}) {
  await assertStudentBelongsToTeacher(teacherId, studentId);

  const whereClause = category ? { category } : { category: { [Op.ne]: 'days_of_week' } };

  const words = await DialogueWord.findAll({
    where: whereClause,
    order: [['category', 'ASC'], ['difficulty', 'ASC'], ['teaching_order', 'ASC']],
    include: [
      {
        model: DialogueWordProgress,
        as: 'progress',
        where: { student_id: studentId },
        required: false,
      },
    ],
  });

  const entries = words.map((w) => ({
    word:             w.get({ plain: true }),
    progress:         w.progress?.[0]?.get({ plain: true }) ?? null,
    progressInstance: w.progress?.[0] ?? null,
  }));

  // Strict gate: all lower-difficulty words must be mastered
  function allLowerDifficultyMastered(targetWord) {
    if (targetWord.difficulty === 1) return true;

    for (let d = 1; d < targetWord.difficulty; d++) {
      const lowerWords = entries.filter(
        (e) => e.word.category === targetWord.category && e.word.difficulty === d
      );
      if (!lowerWords.every((e) => e.progress?.status === 'mastered')) return false;
    }
    return true;
  }

  // Relaxed gate: at least one lower-difficulty word has a session pass
  function isSessionUnlocked(word) {
    if (word.difficulty === 1) return true;

    for (let d = 1; d < word.difficulty; d++) {
      const lowerWords = entries.filter(
        (e) => e.word.category === word.category && e.word.difficulty === d
      );
      if (!lowerWords.some((e) => (e.progress?.session_pass_count ?? 0) >= 1)) return false;
    }
    return true;
  }

  // Loose gate ('fast' trajectory only): at least one lower-difficulty word
  // (any tier below, not merely session-passed) is mastered.
  function anyLowerDifficultyMastered(targetWord) {
    if (targetWord.difficulty === 1) return true;

    return entries.some(
      (e) =>
        e.word.category === targetWord.category &&
        e.word.difficulty < targetWord.difficulty &&
        e.progress?.status === 'mastered'
    );
  }

  const excludedId       = exclude_word_id ? parseInt(exclude_word_id, 10) : null;
  const currentDifficulty = excludedId
    ? (entries.find((e) => e.word.id === excludedId)?.word.difficulty ?? null)
    : null;

  // Pool: exclude the just-finished word and words already mastered
  const candidates = entries.filter(
    (e) => e.word.id !== excludedId && e.progress?.status !== 'mastered'
  );

  function pickFrom(pool) {
    // in_progress first, then not_started
    return (
      pool.find((e) => e.progress?.status === 'in_progress') ??
      pool.find((e) => !e.progress || e.progress.status === 'not_started') ??
      null
    );
  }

  // ── Case 1: session passed → can unlock next difficulty ────────────────────
  if (session_passed === true && currentDifficulty !== null) {
    // Try same difficulty first (other unlearned words at this level)
    const sameDiff = candidates.filter(
      (e) => e.word.difficulty === currentDifficulty && allLowerDifficultyMastered(e.word)
    );
    const samePick = pickFrom(sameDiff);
    if (samePick) return formatNextWord(samePick.word, samePick.progress);

    // Offer next difficulty — trajectory-conditioned gate, evaluated per
    // candidate (Scope Amendment A1: no single "just passed" word is used).
    // 'typical' must always resolve to today's pre-existing gate function,
    // unchanged — this is the fallback path every session takes until
    // TASK-04 exists.
    const nextDiffPool = candidates.filter((e) => e.word.difficulty === currentDifficulty + 1);
    const nextDiff = [];
    for (const e of nextDiffPool) {
      const trajectory = await getTrajectoryPrediction(studentId, e.word.id);
      const nextDiffGate =
        trajectory === 'struggling' ? allLowerDifficultyMastered :
        trajectory === 'fast'       ? anyLowerDifficultyMastered :
        isSessionUnlocked;
      if (nextDiffGate(e.word)) nextDiff.push(e);
    }
    const nextPick = pickFrom(nextDiff);
    if (nextPick) return formatNextWord(nextPick.word, nextPick.progress);
  }

  // ── Case 2: struggling at D2 → D1 not-mastered, then D2 not-mastered ─────
  if (status === 'struggling' && currentDifficulty === 2) {
    const d1 = pickFrom(candidates.filter((e) => e.word.difficulty === 1));
    if (d1) return formatNextWord(d1.word, d1.progress);

    const d2 = pickFrom(candidates.filter((e) => e.word.difficulty === 2));
    if (d2) return formatNextWord(d2.word, d2.progress);
  }

  // ── Case 3: struggling at D3 → D3, then D2, then D1 not-mastered ──────────
  if (status === 'struggling' && currentDifficulty === 3) {
    const d3 = pickFrom(candidates.filter((e) => e.word.difficulty === 3));
    if (d3) return formatNextWord(d3.word, d3.progress);

    const d2 = pickFrom(candidates.filter((e) => e.word.difficulty === 2));
    if (d2) return formatNextWord(d2.word, d2.progress);

    const d1 = pickFrom(candidates.filter((e) => e.word.difficulty === 1));
    if (d1) return formatNextWord(d1.word, d1.progress);
  }

  // ── Default: in_progress → not_started → Rule 3 re-introduction ──────────
  const inProgress = candidates.find(
    ({ word, progress }) => progress?.status === 'in_progress' && allLowerDifficultyMastered(word)
  );
  if (inProgress) return formatNextWord(inProgress.word, inProgress.progress);

  const notStarted = candidates.find(
    ({ word, progress }) =>
      (!progress || progress.status === 'not_started') && allLowerDifficultyMastered(word)
  );
  if (notStarted) return formatNextWord(notStarted.word, notStarted.progress);

  // Rule 3 — re-introduce a struggling word when lower difficulty is resolved
  const reintroEntry = candidates.find(
    ({ word, progress }) => progress?.status === 'struggling' && allLowerDifficultyMastered(word)
  );
  if (reintroEntry) {
    await reintroEntry.progressInstance.update({
      status:                 'in_progress',
      consecutive_fail_count: 0,
      current_phase:          1,
      phase1_gate_passed:     false,
      phase1_exposure_count:  0,
      updated_at:             new Date(),
    });
    const refreshed = await reintroEntry.progressInstance.reload();
    return { ...formatNextWord(reintroEntry.word, refreshed), reintroduced: true };
  }

  return null;
}

function formatNextWord(word, progress) {
  return {
    id:                        word.id,
    word:                      word.word,
    category:                  word.category,
    difficulty:                word.difficulty,
    asset_key:                 word.asset_key,
    cue_grapheme:              word.cue_grapheme,
    keyword_triggers:          word.keyword_triggers,
    current_phase:             progress?.current_phase ?? 1,
    phase1_exposure_count:     progress?.phase1_exposure_count ?? 0,
    phase1_required_exposures: progress?.phase1_required_exposures ?? 4,
    phase1_gate_passed:        progress?.phase1_gate_passed ?? false,
    status:                    progress?.status ?? 'not_started',
  };
}

// RC-PROMPT: minimal single-word lookup so Phase 2 screens can fetch
// cue_grapheme by wordId at mount time instead of relying on it being
// threaded through the navigation params chain.
async function getWordById(wordId) {
  const word = await assertWordExists(wordId);
  return { id: word.id, cue_grapheme: word.cue_grapheme };
}

async function recordPhase1Exposure(teacherId, studentId, wordId) {
  await assertStudentBelongsToTeacher(teacherId, studentId);
  await assertWordExists(wordId);

  const progress = await getOrCreateProgress(studentId, wordId);

  await progress.update({
    phase1_exposure_count: progress.phase1_exposure_count + 1,
    status: 'in_progress',
    updated_at: new Date(),
  });

  const newCount = progress.phase1_exposure_count + 1;
  return {
    phase1_exposure_count:     newCount,
    phase1_required_exposures: progress.phase1_required_exposures,
    gate_ready: newCount >= progress.phase1_required_exposures,
  };
}

async function recordPhase1Gate(teacherId, studentId, wordId, gatePassed) {
  await assertStudentBelongsToTeacher(teacherId, studentId);
  await assertWordExists(wordId);

  const progress = await getOrCreateProgress(studentId, wordId);

  if (gatePassed) {
    const updates = {
      phase1_gate_passed: true,
      current_phase: 2,
      status: 'in_progress',
      updated_at: new Date(),
    };

    // Point-in-time baseline snapshot (TASK-25): written ONCE, on this word's
    // first-ever gate pass. Rule 3 re-introduction can reset phase1_gate_passed
    // and cause this branch to run again later for the same word — the
    // === null check (not a truthy check) ensures a later pass never
    // overwrites the original baseline, since 0.0 is itself a valid ratio.
    if (progress.phase1_exposure_ratio_snapshot === null) {
      updates.phase1_exposure_ratio_snapshot =
        progress.phase1_exposure_count / progress.phase1_required_exposures;
    }

    await progress.update(updates);
  }

  return { gate_passed: gatePassed, current_phase: gatePassed ? 2 : 1 };
}

async function assessPhase2Speech(teacherId, studentId, wordId, {
  audio_base64, mime_type, session_id,
  avatar_audio_end_ts, recording_start_ts,
}) {
  await assertStudentBelongsToTeacher(teacherId, studentId);
  const word = await assertWordExists(wordId);

  // Create a dialogue session on the first call for this word (session_id not yet known)
  let activeSessionId = session_id ?? null;
  if (!activeSessionId) {
    const session = await Session.create({
      teacher_id: teacherId,
      student_id: studentId,
      started_at: new Date(),
      is_active:  true,
    });
    activeSessionId = session.id;
  }

  const {
    score, transcript, match_type, phoneme_error_class, phoneme_accuracy, first_word_offset_ms,
  } = await speechAssessment.assessSpeech(
    audio_base64,
    mime_type,
    word.keyword_triggers
  );

  // ── RC3 — echolalia detection ──────────────────────────────────────────────
  // child_speech_onset_ts = when recording started + offset of first detected
  // word within that recording. response_latency_ms = onset - avatar audio end.
  // Both stay null/false until the frontend sends real timestamps (separate FSD).
  let response_latency_ms = null;
  let echolalia_flag = false;
  if (avatar_audio_end_ts && recording_start_ts) {
    const childSpeechOnsetTs = recording_start_ts + (first_word_offset_ms ?? 0);
    response_latency_ms = Math.max(0, childSpeechOnsetTs - avatar_audio_end_ts);
    echolalia_flag = response_latency_ms < ECHOLALIA_THRESHOLD_MS;
  }

  const progress = await getOrCreateProgress(studentId, wordId);

  // Track consecutive score-0s to trigger non-verbal fallback at 3
  const newPhase2ZeroStreak = score === 0
    ? progress.phase2_zero_streak + 1
    : 0;

  // RC3 — running echolalia rate (exponential moving average, no extra column needed)
  const newEcholaliaRate = progress.echolalia_rate
    + ECHOLALIA_EMA_ALPHA * ((echolalia_flag ? 1 : 0) - progress.echolalia_rate);

  const updates = {
    phase2_zero_streak: newPhase2ZeroStreak,
    status: 'in_progress',
    echolalia_rate: newEcholaliaRate,
    updated_at: new Date(),
  };

  if (score >= 2) {
    updates.current_phase = 3;
  }

  await progress.update(updates);

  await DialogueWordAttempt.create({
    student_id:   studentId,
    word_id:      wordId,
    session_id:   activeSessionId,
    phase:        2,
    speech_score: score,
    transcript,
    match_type,
    phoneme_error_class,
    phoneme_accuracy,
    response_latency_ms,
    echolalia_flag,
  });

  return {
    score,
    transcript,
    match_type,
    session_id:             activeSessionId,
    advance_to_phase3:      score >= 2,
    trigger_nonverbal:      newPhase2ZeroStreak >= 3,
    phase2_zero_streak:     newPhase2ZeroStreak,
    mic_delay_ms:           newEcholaliaRate > 0.5 ? ECHOLALIA_MIC_DELAY_MS : 0,
  };
}

/**
 * POST /phase2-nonverbal
 * Records the result of the non-verbal fallback Word-to-Scene Matching activity.
 * Increments non_verbal_count on the progress record.
 * Child always proceeds to Phase 3 after this activity regardless of result.
 */
async function recordNonVerbalResult(teacherId, studentId, wordId, { image_selected_correct, session_id, is_probe = false }) {
  await assertStudentBelongsToTeacher(teacherId, studentId);
  await assertWordExists(wordId);

  const progress = await getOrCreateProgress(studentId, wordId);

  if (is_probe) {
    // Rule 5 retention-check fallback: never touches current_phase/status —
    // a probe's non-verbal result must never move the word off its mastered state.
    await progress.update({
      non_verbal_count: progress.non_verbal_count + 1,
      last_probe_date:  todayString(),
      updated_at:       new Date(),
    });
  } else {
    await progress.update({
      non_verbal_count: progress.non_verbal_count + 1,
      current_phase:    3,
      status:           'in_progress',
      updated_at:       new Date(),
    });
  }

  await DialogueWordAttempt.create({
    student_id:   studentId,
    word_id:      wordId,
    session_id:   session_id ?? null,
    phase:        2,
    speech_score: image_selected_correct ? 1 : 0,
    match_type:   'non_verbal',
    phase3_correct: null,
    is_probe,
  });

  return {
    image_selected_correct,
    non_verbal_count: progress.non_verbal_count + 1,
    advance_to_phase3: !is_probe,
  };
}

/**
 * POST /phase3-scenario
 * Records a single Phase 3 scenario attempt (A, B, C, or checkpoint).
 * Does NOT trigger mastery computation — call phase3-complete for that.
 */
async function recordPhase3Scenario(teacherId, studentId, wordId, {
  scenario_label, selected_correct, session_id,
  response_latency_ms, selection_change_count, prompt_count, first_tap_correct,
}) {
  await assertStudentBelongsToTeacher(teacherId, studentId);
  await assertWordExists(wordId);

  await DialoguePhase3Attempt.create({
    student_id:             studentId,
    word_id:                wordId,
    session_id:             session_id ?? null,
    scenario_label,
    phase3_correct:         selected_correct,
    response_latency_ms:    response_latency_ms ?? null,
    selection_change_count: selection_change_count ?? 0,
    prompt_count:           prompt_count ?? 1,
    first_tap_correct:      first_tap_correct ?? null,
  });

  return { scenario_label, selected_correct };
}

/**
 * POST /phase3-complete
 * Body: { phase3_passed: boolean, session_id? }
 *
 * phase3_passed = true  when:
 *   - All of A, B, C correct, OR
 *   - A wrong but B & C correct AND checkpoint passed
 *
 * Triggers mastery algorithm (Rules 1–4).
 */
async function recordPhase3Result(teacherId, studentId, wordId, { phase3_passed, session_id }) {
  await assertStudentBelongsToTeacher(teacherId, studentId);
  await assertWordExists(wordId);

  const progress = await getOrCreateProgress(studentId, wordId);

  // Determine if the full session passed: Phase 2 score >= 2 AND Phase 3 passed.
  const lastPhase2 = await DialogueWordAttempt.findOne({
    where: { student_id: studentId, word_id: wordId, phase: 2 },
    order: [['attempted_at', 'DESC']],
  });

  // A non-verbal attempt (match_type='non_verbal') counts as phase2 partial credit
  // and allows moving to Phase 3; non-verbal's max speech_score is 1, not a lower
  // version of the verbal 0-3 scale, so it needs its own pass threshold.
  const phase2NonVerbal = lastPhase2?.match_type === 'non_verbal';
  const phase2Score     = lastPhase2?.speech_score ?? 0;
  const phase2Passed    = phase2NonVerbal ? phase2Score >= 1 : phase2Score >= 2;
  const phase2Echolalic = lastPhase2?.echolalia_flag === true; // RC3
  const sessionPassed   = phase2Passed && phase3_passed;

  const today = todayString();
  let newStatus           = progress.status;
  let newSessionPassCount = progress.session_pass_count;
  let newLastPassDate     = progress.last_pass_date;
  // Session-level only (Rule 2) — never write this from a Phase-2 sub-attempt-level function; use phase2_zero_streak for that.
  let newConsecFails      = progress.consecutive_fail_count;
  let newTotalSessions    = progress.total_sessions + 1;
  let mastered            = false;
  // Accumulate only on a genuine (non-echolalic) pass; unchanged in every other branch.
  let newVerbalPassCount    = progress.verbal_pass_count;
  let newNonVerbalPassCount = progress.non_verbal_pass_count;
  // Only set when mastery triggers this call; unchanged in every other branch.
  let newMasteryPath = progress.mastery_path;

  if (sessionPassed && phase2Echolalic) {
    // RC3 — echolalic pass: genuine comprehension not yet confirmed.
    // Stays in_progress; does not count toward the 2-pass mastery rule,
    // but is not penalised as a failure either.
    newStatus      = 'in_progress';
    newConsecFails = 0;
  } else if (sessionPassed) {
    const differentDay = progress.last_pass_date && progress.last_pass_date !== today;
    newSessionPassCount = progress.session_pass_count + 1;
    newLastPassDate     = today;
    newConsecFails      = 0;

    newVerbalPassCount    = progress.verbal_pass_count + (phase2NonVerbal ? 0 : 1);
    newNonVerbalPassCount = progress.non_verbal_pass_count + (phase2NonVerbal ? 1 : 0);

    // Rule 1: mastery requires 2+ passes on different calendar days
    if (newSessionPassCount >= 2 && differentDay) {
      newStatus = 'mastered';
      mastered  = true;
      // mastery_path is otherwise only ever written by recordProbeResult() (Rule 5's
      // probe-driven non_verbal → mixed upgrade when emerged speech clears the bar).
      newMasteryPath =
        newVerbalPassCount > 0 && newNonVerbalPassCount > 0 ? 'mixed'
        : newNonVerbalPassCount > 0 ? 'non_verbal'
        : 'verbal';
    } else {
      newStatus = 'in_progress';
    }
  } else {
    newConsecFails = progress.consecutive_fail_count + 1;
    // Rule 2: 3 consecutive failures → struggling
    if (newConsecFails >= 3) {
      newStatus = 'struggling';
    }
  }

  // Rule 4: adaptive pacing on required Phase 1 exposures
  let newRequiredExposures = progress.phase1_required_exposures;
  if (mastered && newTotalSessions <= 1) {
    // Very fast learner — reduce future Phase 1 exposures
    newRequiredExposures = Math.max(2, newRequiredExposures - 2);
  } else if (newTotalSessions >= 3 && !sessionPassed) {
    // Slow learner — extend Phase 1 for next session
    newRequiredExposures = Math.min(6, newRequiredExposures + 1);
  }

  // Reset phase to 1 for next session
  await progress.update({
    status:                    newStatus,
    current_phase:             1,
    phase1_gate_passed:        false,
    phase1_exposure_count:     0,
    phase1_required_exposures: newRequiredExposures,
    session_pass_count:        newSessionPassCount,
    last_pass_date:            newLastPassDate,
    consecutive_fail_count:    newConsecFails,
    total_sessions:            newTotalSessions,
    verbal_pass_count:         newVerbalPassCount,
    non_verbal_pass_count:     newNonVerbalPassCount,
    mastery_path:              newMasteryPath,
    updated_at:                new Date(),
  });

  await DialoguePhase3Attempt.create({
    student_id:     studentId,
    word_id:        wordId,
    session_id:     session_id ?? null,
    phase3_correct: phase3_passed,
    session_passed: sessionPassed,
    // blooms_level and pragmatic_confidence are added
    // in the pragmatic model FSD. They remain null here.
  });

  return {
    session_passed:     sessionPassed,
    mastered,
    status:             newStatus,
    session_pass_count: newSessionPassCount,
  };
}

/**
 * GET /probe-candidate
 * Rule 5 — periodic production probe. Read-only: picks the single
 * non-verbal-mastered word most overdue for a probe (never-probed words
 * count as most overdue), or null if none are due. Never writes anything —
 * this is explicitly outside Rules 1-4's transition logic.
 */
async function getProbeCandidate(teacherId, studentId, category = null) {
  await assertStudentBelongsToTeacher(teacherId, studentId);

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - PROBE_INTERVAL_DAYS);
  const cutoffString = cutoff.toISOString().split('T')[0];

  const candidates = await DialogueWordProgress.findAll({
    where: {
      student_id: studentId,
      mastery_path: 'non_verbal',
      [Op.or]: [
        { last_probe_date: null },
        { last_probe_date: { [Op.lte]: cutoffString } },
      ],
    },
    include: [{
      model: DialogueWord,
      as: 'word',
      where: category ? { category } : {},
      required: true,
    }],
  });

  if (candidates.length === 0) return null;

  // Oldest-probed (or never-probed) first: a null last_probe_date always
  // outranks any dated one, since it has never been checked at all.
  const chosen = candidates.reduce((oldest, current) => {
    if (!oldest) return current;
    if (oldest.last_probe_date === null) return oldest;
    if (current.last_probe_date === null) return current;
    return current.last_probe_date < oldest.last_probe_date ? current : oldest;
  }, null);

  const word = chosen.word;
  return {
    word_id:            word.id,
    word:                word.word,
    // TASK-39 Scope Amendment A1: the frontend's asset maps (DIALOGUE_WORD_ASSETS/
    // WORD_AUDIO, CAT3_WORD_IMAGE/CAT3_WORD_AUDIO) are keyed by asset_key, not
    // `word` — added so ProbeProductionScreen.js can resolve displayable assets
    // in this one call, without a second getWordById lookup.
    asset_key:           word.asset_key,
    category:            word.category,
    cue_grapheme:        word.cue_grapheme,
    keyword_triggers:    word.keyword_triggers,
    mastery_path:        chosen.mastery_path,
    last_probe_date:     chosen.last_probe_date,
  };
}

/**
 * POST /probe-result
 * Rule 5 — records a periodic production probe attempt on an already
 * non-verbal-mastered word. Deliberately narrow: unlike assessPhase2Speech(),
 * this never writes status/current_phase/session_pass_count/
 * consecutive_fail_count/phase2_zero_streak — a probe must never risk the
 * word's mastery status. Only last_probe_date is always updated; mastery_path
 * and verbal_pass_count are upgraded only when speech has genuinely emerged
 * (score >= 2, the same bar a normal verbal pass requires).
 */
async function recordProbeResult(teacherId, studentId, wordId, { audio_base64, mime_type, session_id }) {
  await assertStudentBelongsToTeacher(teacherId, studentId);
  const word = await assertWordExists(wordId);
  const progress = await getOrCreateProgress(studentId, wordId);

  if (progress.mastery_path !== 'non_verbal') {
    throw new ApiError(422, 'Word is not on the non-verbal mastery path; probe is not applicable.');
  }

  const { score, transcript, match_type, phoneme_error_class, phoneme_accuracy } = await speechAssessment.assessSpeech(
    audio_base64,
    mime_type,
    word.keyword_triggers
  );

  await DialogueWordAttempt.create({
    student_id:   studentId,
    word_id:      wordId,
    session_id:   session_id ?? null,
    phase:        2,
    speech_score: score,
    transcript,
    match_type,
    phoneme_error_class,
    phoneme_accuracy,
    is_probe:     true,
  });

  const speechEmerged = score >= 2;
  const updates = {
    last_probe_date: todayString(),
    updated_at:       new Date(),
  };

  let newMasteryPath = progress.mastery_path;
  if (speechEmerged) {
    newMasteryPath          = 'mixed';
    updates.mastery_path    = newMasteryPath;
    updates.verbal_pass_count = progress.verbal_pass_count + 1;
  }

  await progress.update(updates);

  return {
    score,
    speech_emerged: speechEmerged,
    mastery_path:   newMasteryPath,
  };
}

/**
 * TASK-12 — Non-Verbal Adaptive Wait-Time Escalation
 *
 * Derives today's trailing consecutive refusal count from dialogue_word_attempts
 * and returns the corresponding wait-time multiplier for the TASK-06 prompt-
 * hierarchy tiers. State is computed, not stored — no migration needed.
 *
 * Refusal = Phase 2 verbal attempt with speech_score = 0. Non-verbal activity
 * rows (match_type = 'non_verbal') are excluded — they are outcomes of refusals,
 * not refusals themselves.
 *
 * Day boundary uses UTC (mirrors todayString() / last_session_date pattern in
 * Rules 1–4 above — specifically the differentDay check in recordPhase3Result).
 *
 * Escalation ladder (DEC-03 planner defaults):
 *   0 refusals today → multiplier 1.0 (normal)
 *   1 refusal today  → multiplier 0.7 (shortened waits)
 *   2 refusals today → multiplier 0.5 (shortened further)
 *   ≥3 refusals today → auto_nonverbal_today = true (skip production entirely)
 *
 * A genuine speech attempt (speech_score > 0) at any point resets the streak.
 * Next calendar day starts fresh — the query is date-bounded to today UTC.
 *
 * Returns: { consecutive_refusals_today, wait_multiplier, auto_nonverbal_today }
 */
async function getDailySpeechState(studentId) {
  const today = todayString(); // 'YYYY-MM-DD' in UTC — same as last_session_date

  // Date range: today UTC midnight → tomorrow UTC midnight (exclusive upper bound).
  // Using explicit Date objects (not raw strings) for portable DATETIME comparisons.
  const todayStart    = new Date(`${today}T00:00:00.000Z`);
  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setUTCDate(tomorrowStart.getUTCDate() + 1);

  // Fetch today's Phase 2 verbal attempts in chronological order.
  // Excludes match_type = 'non_verbal' rows (image-selection activity results)
  // because those are the outcome of a refusal, not a refusal themselves.
  const todayAttempts = await DialogueWordAttempt.findAll({
    where: {
      student_id: studentId,
      phase:      2,
      match_type: { [Op.ne]: 'non_verbal' },
      attempted_at: {
        [Op.gte]: todayStart,
        [Op.lt]:  tomorrowStart,
      },
    },
    attributes: ['speech_score'],
    order:       [['attempted_at', 'ASC']],
  });

  // Count trailing consecutive rows with speech_score = 0.
  // Iterate in reverse: stop at the first row with speech_score > 0.
  let consecutive = 0;
  for (let i = todayAttempts.length - 1; i >= 0; i--) {
    if (todayAttempts[i].speech_score === 0) {
      consecutive++;
    } else {
      break; // any speech_score > 0 resets the streak
    }
  }

  let wait_multiplier;
  let auto_nonverbal_today;

  if (consecutive >= 3) {
    // ≥3 refusals: skip production entirely for the rest of today.
    wait_multiplier      = 1.0; // irrelevant — production is bypassed
    auto_nonverbal_today = true;
  } else if (consecutive === 2) {
    wait_multiplier      = 0.5;
    auto_nonverbal_today = false;
  } else if (consecutive === 1) {
    wait_multiplier      = 0.7;
    auto_nonverbal_today = false;
  } else {
    // streak 0 — behaviour byte-identical to before TASK-12 (multiplier 1.0 path)
    wait_multiplier      = 1.0;
    auto_nonverbal_today = false;
  }

  return { consecutive_refusals_today: consecutive, wait_multiplier, auto_nonverbal_today };
}

module.exports = {
  getLevel1Overview,
  getNextWord,
  getWordById,
  recordPhase1Exposure,
  recordPhase1Gate,
  assessPhase2Speech,
  recordNonVerbalResult,
  recordPhase3Scenario,
  recordPhase3Result,
  getProbeCandidate,
  recordProbeResult,
  getDailySpeechState,
};
