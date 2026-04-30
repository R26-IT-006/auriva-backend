'use strict';

const { Op }                    = require('sequelize');
const { DialogueWord, DialogueWordProgress, DialogueWordAttempt, Student, Session } = require('../models');
const ApiError                  = require('../utils/ApiError');
const speechAssessment          = require('./speechAssessmentService');

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
 * Priority:
 *   1. in_progress words (ordered by category / teaching_order)
 *   2. not_started words that are unlocked by difficulty gate
 *   3. struggling words that qualify for Rule 3 re-introduction
 *      (all lower-difficulty words in the same category are mastered)
 *
 * Rule 3: When a struggling word is re-introduced, its consecutive_fail_count
 * is reset to 0 and status is returned to in_progress.
 */
async function getNextWord(teacherId, studentId, category = null) {
  await assertStudentBelongsToTeacher(teacherId, studentId);

  const whereClause = category ? { category } : {};

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
    word:     w.get({ plain: true }),
    progress: w.get({ plain: true }).progress?.[0] ?? null,
  }));

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

  function isUnlocked(word) {
    return allLowerDifficultyMastered(word);
  }

  // 1. in_progress word
  const inProgress = entries.find(
    ({ word, progress }) => progress?.status === 'in_progress' && isUnlocked(word)
  );
  if (inProgress) return formatNextWord(inProgress.word, inProgress.progress);

  // 2. not_started word
  const notStarted = entries.find(
    ({ word, progress }) =>
      (!progress || progress.status === 'not_started') && isUnlocked(word)
  );
  if (notStarted) return formatNextWord(notStarted.word, notStarted.progress);

  // 3. Rule 3 — struggling word eligible for re-introduction
  const reintroEntry = entries.find(
    ({ word, progress }) =>
      progress?.status === 'struggling' && allLowerDifficultyMastered(word)
  );
  if (reintroEntry) {
    // Reset fail streak and status (Rule 3)
    await reintroEntry.progress.update({
      status:                 'in_progress',
      consecutive_fail_count: 0,
      current_phase:          1,
      phase1_gate_passed:     false,
      phase1_exposure_count:  0,
      updated_at:             new Date(),
    });
    const refreshed = await reintroEntry.progress.reload();
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
    keyword_triggers:          word.keyword_triggers,
    current_phase:             progress?.current_phase ?? 1,
    phase1_exposure_count:     progress?.phase1_exposure_count ?? 0,
    phase1_required_exposures: progress?.phase1_required_exposures ?? 4,
    phase1_gate_passed:        progress?.phase1_gate_passed ?? false,
    status:                    progress?.status ?? 'not_started',
  };
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
    await progress.update({
      phase1_gate_passed: true,
      current_phase: 2,
      status: 'in_progress',
      updated_at: new Date(),
    });
  }

  return { gate_passed: gatePassed, current_phase: gatePassed ? 2 : 1 };
}

async function assessPhase2Speech(teacherId, studentId, wordId, { audio_base64, mime_type, session_id }) {
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

  const { score, transcript, match_type } = await speechAssessment.assessSpeech(
    audio_base64,
    mime_type,
    word.keyword_triggers
  );

  const progress = await getOrCreateProgress(studentId, wordId);

  // Track consecutive score-0s to trigger non-verbal fallback at 3
  const newConsecutiveFails = score === 0
    ? progress.consecutive_fail_count + 1
    : 0;

  const updates = {
    consecutive_fail_count: newConsecutiveFails,
    status: 'in_progress',
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
  });

  return {
    score,
    transcript,
    match_type,
    session_id:             activeSessionId,
    advance_to_phase3:      score >= 2,
    trigger_nonverbal:      newConsecutiveFails >= 3,
    consecutive_fail_count: newConsecutiveFails,
  };
}

/**
 * POST /phase2-nonverbal
 * Records the result of the non-verbal fallback Word-to-Scene Matching activity.
 * Increments non_verbal_count on the progress record.
 * Child always proceeds to Phase 3 after this activity regardless of result.
 */
async function recordNonVerbalResult(teacherId, studentId, wordId, { image_selected_correct, session_id }) {
  await assertStudentBelongsToTeacher(teacherId, studentId);
  await assertWordExists(wordId);

  const progress = await getOrCreateProgress(studentId, wordId);

  await progress.update({
    non_verbal_count: progress.non_verbal_count + 1,
    current_phase:    3,
    status:           'in_progress',
    updated_at:       new Date(),
  });

  await DialogueWordAttempt.create({
    student_id:   studentId,
    word_id:      wordId,
    session_id:   session_id ?? null,
    phase:        2,
    speech_score: image_selected_correct ? 1 : 0,
    match_type:   'non_verbal',
    phase3_correct: null,
  });

  return {
    image_selected_correct,
    non_verbal_count: progress.non_verbal_count + 1,
    advance_to_phase3: true,
  };
}

/**
 * POST /phase3-scenario
 * Records a single Phase 3 scenario attempt (A, B, C, or checkpoint).
 * Does NOT trigger mastery computation — call phase3-complete for that.
 */
async function recordPhase3Scenario(teacherId, studentId, wordId, { scenario_label, selected_correct, session_id }) {
  await assertStudentBelongsToTeacher(teacherId, studentId);
  await assertWordExists(wordId);

  await DialogueWordAttempt.create({
    student_id:     studentId,
    word_id:        wordId,
    session_id:     session_id ?? null,
    phase:          3,
    scenario_label,
    phase3_correct: selected_correct,
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
  // and allows moving to Phase 3, but the speech_score determines mastery eligibility.
  const phase2Score = lastPhase2?.speech_score ?? 0;
  const phase2Passed = phase2Score >= 2;
  const sessionPassed = phase2Passed && phase3_passed;

  const today = todayString();
  let newStatus           = progress.status;
  let newSessionPassCount = progress.session_pass_count;
  let newLastPassDate     = progress.last_pass_date;
  let newConsecFails      = progress.consecutive_fail_count;
  let newTotalSessions    = progress.total_sessions + 1;
  let mastered            = false;

  if (sessionPassed) {
    const differentDay = progress.last_pass_date && progress.last_pass_date !== today;
    newSessionPassCount = progress.session_pass_count + 1;
    newLastPassDate     = today;
    newConsecFails      = 0;

    // Rule 1: mastery requires 2+ passes on different calendar days
    if (newSessionPassCount >= 2 && differentDay) {
      newStatus = 'mastered';
      mastered  = true;
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
    updated_at:                new Date(),
  });

  await DialogueWordAttempt.create({
    student_id:     studentId,
    word_id:        wordId,
    session_id:     session_id ?? null,
    phase:          3,
    phase3_correct: phase3_passed,
    session_passed: sessionPassed,
  });

  return {
    session_passed:     sessionPassed,
    mastered,
    status:             newStatus,
    session_pass_count: newSessionPassCount,
  };
}

module.exports = {
  getLevel1Overview,
  getNextWord,
  recordPhase1Exposure,
  recordPhase1Gate,
  assessPhase2Speech,
  recordNonVerbalResult,
  recordPhase3Scenario,
  recordPhase3Result,
};
