'use strict';

const {
  Student,
  SentenceQuestionnaire,
  Level2TopicProgress,
  Level2Session,
  Level2SentenceAttempt,
  Level2GenderSelectionLog,
  Level2ActivitySelectionLog,
  Level2ProductionAttempt,
  Level2NonVerbalAttempt,
} = require('../models');
const ApiError          = require('../utils/ApiError');
const ttsService        = require('./ttsService');
const speechAssessment  = require('./speechAssessmentService');

// ── Constants ─────────────────────────────────────────────────────────────

const ALL_ACTIVITIES = ['Singing', 'Dancing', 'Art', 'Cricket', 'Games', 'Reading'];

const SL_NAMES = [
  'Aarav', 'Anika', 'Chamath', 'Dilshan', 'Dinusha', 'Hansika',
  'Ishara', 'Kavisha', 'Malika', 'Nethmi', 'Nimal', 'Pasan',
  'Ruvini', 'Sandali', 'Sathira', 'Senith', 'Tharindu', 'Yasith',
];

const SL_PLACES = [
  'Kandy', 'Galle', 'Matara', 'Jaffna', 'Negombo', 'Anuradhapura',
  'Polonnaruwa', 'Ratnapura', 'Kurunegala', 'Badulla', 'Trincomalee',
  'Batticaloa', 'Vavuniya', 'Puttalam', 'Kegalle', 'Hambantota',
];

// ── Helpers ───────────────────────────────────────────────────────────────

function todayString() {
  return new Date().toISOString().split('T')[0];
}

async function assertStudentBelongsToTeacher(teacherId, studentId) {
  const student = await Student.findOne({ where: { sid: studentId, teacher_id: teacherId } });
  if (!student) throw new ApiError(404, 'Student not found or not assigned to you');
  return student;
}

async function assertSessionOwnership(teacherId, studentId, level2SessionId) {
  const session = await Level2Session.findOne({
    where: { id: level2SessionId, teacher_id: teacherId, student_id: studentId },
  });
  if (!session) throw new ApiError(404, 'Level 2 session not found');
  if (session.is_complete) throw new ApiError(409, 'This session is already complete');
  return session;
}

function pickRandom(arr, exclude = null) {
  const filtered = exclude !== null
    ? arr.filter((v) => v.toLowerCase() !== exclude.toLowerCase())
    : arr;
  return filtered[Math.floor(Math.random() * filtered.length)];
}

/** Build the five target sentences from questionnaire data. */
function buildSentences(q) {
  const activity = q.favourite_activities[0];
  return [
    `My name is ${q.child_first_name}.`,
    `I am ${q.child_age} years old.`,
    `I live in ${q.child_hometown}.`,
    `I am a ${q.child_gender}.`,
    `I like ${activity}.`,
  ];
}

/** Build the full paragraph text. */
function buildParagraph(q) {
  const sentences = buildSentences(q);
  return `Hello! ${sentences.join(' ')}`;
}

/** Prompt questions matching each sentence (FSD §6). */
const PROMPTS = [
  "What's your name?",
  'How old are you?',
  'Where do you live?',
  'Are you a girl or a boy?',
  "What's your favourite activity?",
];

/**
 * Build distractors for each sentence.
 * Returns an array of 5 distractor values (strings).
 */
function buildDistractors(q) {
  // Sentence 1 – different Sri Lankan name
  const nameDistractor = pickRandom(SL_NAMES, q.child_first_name);

  // Sentence 2 – age ±1 or ±2, clamped 1–18
  const delta = (Math.random() < 0.5 ? 1 : 2) * (Math.random() < 0.5 ? 1 : -1);
  const ageDistractor = String(Math.min(18, Math.max(1, q.child_age + delta)));

  // Sentence 3 – different Sri Lankan place
  const placeDistractor = pickRandom(SL_PLACES, q.child_hometown);

  // Sentence 4 – opposite gender
  const genderDistractor = q.child_gender === 'boy' ? 'girl' : 'boy';

  // Sentence 5 – non-selected activity from full list
  const activityDistractor = pickRandom(
    ALL_ACTIVITIES.filter((a) => !q.favourite_activities.includes(a))
  );

  return [nameDistractor, ageDistractor, placeDistractor, genderDistractor, activityDistractor];
}

/**
 * Build keyword triggers for a single sentence (used by the speech assessment pipeline).
 * Returns a triggers object matching { target, score3[], score2[], score1[] }.
 */
function buildTriggers(sentenceIndex, q) {
  const name     = q.child_first_name.toLowerCase();
  const age      = String(q.child_age);
  const hometown = q.child_hometown.toLowerCase();
  const gender   = q.child_gender;
  const activity = q.favourite_activities[0].toLowerCase();

  const configs = [
    // 1 – "My name is [Name]."
    {
      target: `my name is ${name}`,
      score3: [`my name is ${name}`, `name is ${name}`],
      score2: ['my name', name],
      score1: ['name'],
    },
    // 2 – "I am [Age] years old."
    {
      target: `i am ${age} years old`,
      score3: [`i am ${age} years old`, `${age} years old`],
      score2: ['years old', age],
      score1: ['years', 'old'],
    },
    // 3 – "I live in [Hometown]."
    {
      target: `i live in ${hometown}`,
      score3: [`i live in ${hometown}`, `live in ${hometown}`],
      score2: ['i live', hometown],
      score1: ['live', 'in'],
    },
    // 4 – "I am a boy/girl."
    {
      target: `i am a ${gender}`,
      score3: [`i am a ${gender}`, `i'm a ${gender}`, `i am ${gender}`],
      score2: ['i am a', gender],
      score1: [gender],
    },
    // 5 – "I like [Activity]."
    {
      target: `i like ${activity}`,
      score3: [`i like ${activity}`, `i love ${activity}`],
      score2: ['i like', activity],
      score1: ['like', activity],
    },
  ];

  return configs[sentenceIndex - 1];
}

/**
 * Detect which of the five paragraph elements are present in a transcript.
 * Returns { name, age, hometown, gender, activity } each boolean.
 */
function detectParagraphElements(transcript, q) {
  const t        = transcript.toLowerCase().replace(/[^\w\s]/g, ' ');
  const name     = q.child_first_name.toLowerCase();
  const hometown = q.child_hometown.toLowerCase();
  const activity = q.favourite_activities[0].toLowerCase();

  return {
    name:     t.includes(name) || t.includes('my name'),
    age:      t.includes(String(q.child_age)) || (t.includes('year') && t.includes('old')),
    hometown: t.includes(hometown) || t.includes('i live'),
    gender:   t.includes(q.child_gender) || t.includes('i am a'),
    activity: t.includes(activity) || t.includes('i like'),
  };
}

// ── Questionnaire ─────────────────────────────────────────────────────────

const MAX_PORTRAIT_STROKES = 500;
const MAX_PORTRAIT_BYTES   = 1024 * 1024; // ~1 MB

/** Reject unbounded client data on the optional portrait_strokes field. */
function validatePortraitStrokes(portraitStrokes) {
  if (portraitStrokes === undefined || portraitStrokes === null) return;

  if (!Array.isArray(portraitStrokes.strokes) || portraitStrokes.strokes.length > MAX_PORTRAIT_STROKES) {
    throw new ApiError(422, `portrait_strokes.strokes must not exceed ${MAX_PORTRAIT_STROKES} strokes`);
  }

  const byteLength = Buffer.byteLength(JSON.stringify(portraitStrokes), 'utf8');
  if (byteLength > MAX_PORTRAIT_BYTES) {
    throw new ApiError(422, 'portrait_strokes payload exceeds the 1 MB limit');
  }
}

async function saveQuestionnaire(teacherId, studentId, data) {
  await assertStudentBelongsToTeacher(teacherId, studentId);
  validatePortraitStrokes(data.portrait_strokes);

  const [record, created] = await SentenceQuestionnaire.findOrCreate({
    where: { student_id: studentId },
    defaults: { ...data, teacher_id: teacherId, student_id: studentId },
  });

  if (!created) {
    await record.update({ ...data, teacher_id: teacherId, updated_at: new Date() });
  }

  return record;
}

async function getQuestionnaire(teacherId, studentId) {
  await assertStudentBelongsToTeacher(teacherId, studentId);

  const q = await SentenceQuestionnaire.findOne({ where: { student_id: studentId } });
  if (!q) throw new ApiError(404, 'Questionnaire not found. Please complete the questionnaire first.');
  return q;
}

/**
 * Persist ONLY the portrait_strokes column (TASK-17 Fix 2). Creates the
 * questionnaire row if none exists yet — a portrait must be savable before
 * the demographic questionnaire is filled in — leaving every other field at
 * its model default/null until that questionnaire is completed separately.
 */
async function savePortraitStrokes(teacherId, studentId, portraitStrokes) {
  await assertStudentBelongsToTeacher(teacherId, studentId);
  validatePortraitStrokes(portraitStrokes);

  const [record] = await SentenceQuestionnaire.findOrCreate({
    where:    { student_id: studentId },
    defaults: { student_id: studentId, teacher_id: teacherId, portrait_strokes: portraitStrokes },
  });

  await record.update({ portrait_strokes: portraitStrokes, updated_at: new Date() });
  return record;
}

// ── Session start ─────────────────────────────────────────────────────────

/**
 * Start a Level 2 Self-Introduction session.
 * Validates the questionnaire, generates TTS audio, and returns all session data
 * needed by the frontend to run the full session flow.
 * BR-01: questionnaire must exist. BR-02: all TTS clips must succeed.
 */
async function startSession(teacherId, studentId, parentSessionId = null) {
  await assertStudentBelongsToTeacher(teacherId, studentId);

  const q = await SentenceQuestionnaire.findOne({ where: { student_id: studentId } });
  if (!q) {
    throw new ApiError(422, 'Questionnaire is incomplete. Please fill in the child\'s details before starting a Level 2 session.');
  }

  const sentences  = buildSentences(q);
  const paragraph  = buildParagraph(q);
  const distractors = buildDistractors(q);

  // BR-02: TTS must complete before session is created
  const { sentenceAudios, paragraphAudio } = await ttsService.generateSessionAudio(
    sentences,
    paragraph,
    q.child_gender
  );

  const level2Session = await Level2Session.create({
    teacher_id:  teacherId,
    student_id:  studentId,
    session_id:  parentSessionId,
    topic:       'self_introduction',
    started_at:  new Date(),
  });

  return {
    session_id: level2Session.id,
    topic: 'self_introduction',
    sentences: sentences.map((text, i) => ({
      index:         i + 1,
      prompt:        PROMPTS[i],
      text,
      dynamic_value: [
        q.child_first_name,
        String(q.child_age),
        q.child_hometown,
        q.child_gender,
        q.favourite_activities[0],
      ][i],
      distractor:    distractors[i],
      audio_base64:  sentenceAudios[i],
    })),
    full_paragraph: {
      text:         paragraph,
      audio_base64: paragraphAudio,
    },
    gender:     q.child_gender,
    activities: q.favourite_activities,
  };
}

// ── Teaching flow recording ───────────────────────────────────────────────

/**
 * Record the Step 3 (drag-and-drop discrimination) result for a sentence.
 * result: 'first_attempt' | 'required_hint' | 'auto_advanced'
 */
async function recordStep3(teacherId, studentId, level2SessionId, sentenceIndex, result) {
  await assertStudentBelongsToTeacher(teacherId, studentId);
  await assertSessionOwnership(teacherId, studentId, level2SessionId);

  const [attempt] = await Level2SentenceAttempt.findOrCreate({
    where:    { level2_session_id: level2SessionId, sentence_index: sentenceIndex },
    defaults: { student_id: studentId, level2_session_id: level2SessionId, sentence_index: sentenceIndex },
  });

  await attempt.update({ step3_result: result });
  return { sentence_index: sentenceIndex, step3_result: result };
}

/**
 * Assess Step 4 (spoken repetition) for a sentence during the teaching flow.
 * Uses the existing speech assessment pipeline with dynamically built triggers.
 */
async function assessStep4(teacherId, studentId, level2SessionId, sentenceIndex, audioBase64, mimeType) {
  await assertStudentBelongsToTeacher(teacherId, studentId);
  await assertSessionOwnership(teacherId, studentId, level2SessionId);

  const q = await SentenceQuestionnaire.findOne({ where: { student_id: studentId } });
  if (!q) throw new ApiError(422, 'Questionnaire not found');

  let assessment;
  let transcriptionError = false;

  try {
    const triggers = buildTriggers(sentenceIndex, q);
    assessment = await speechAssessment.assessSpeech(audioBase64, mimeType, triggers);
  } catch {
    assessment = { score: 0, transcript: '', match_type: 'no_match' };
    transcriptionError = true;
  }

  const [attempt] = await Level2SentenceAttempt.findOrCreate({
    where:    { level2_session_id: level2SessionId, sentence_index: sentenceIndex },
    defaults: { student_id: studentId, level2_session_id: level2SessionId, sentence_index: sentenceIndex },
  });

  await attempt.update({
    step4_score:      assessment.score,
    step4_transcript: assessment.transcript,
    step4_match_type: assessment.match_type === 'none' ? 'no_match' : assessment.match_type,
    transcription_error: transcriptionError,
  });

  return {
    sentence_index:  sentenceIndex,
    score:           assessment.score,
    transcript:      assessment.transcript,
    match_type:      assessment.match_type,
    transcription_error: transcriptionError,
  };
}

/**
 * Record that the non-verbal fallback was triggered for a sentence during Step 4.
 */
async function recordNonVerbalTeaching(teacherId, studentId, level2SessionId, sentenceIndex, data) {
  await assertStudentBelongsToTeacher(teacherId, studentId);
  await assertSessionOwnership(teacherId, studentId, level2SessionId);

  const [attempt] = await Level2SentenceAttempt.findOrCreate({
    where:    { level2_session_id: level2SessionId, sentence_index: sentenceIndex },
    defaults: { student_id: studentId, level2_session_id: level2SessionId, sentence_index: sentenceIndex },
  });
  await attempt.update({ non_verbal_triggered: true });

  const nv = await Level2NonVerbalAttempt.create({
    level2_session_id:      level2SessionId,
    student_id:             studentId,
    sentence_index:         sentenceIndex,
    context:                'teaching_fallback',
    correct_on_first_attempt: data.correct_on_first_attempt,
    required_second_attempt:  data.required_second_attempt ?? false,
    auto_shown:               data.auto_shown ?? false,
  });

  return { id: nv.id, sentence_index: sentenceIndex, context: 'teaching_fallback' };
}

// ── Special sentence activities ───────────────────────────────────────────

/**
 * Record the child's gender image tap (Sentence 4 combined Step 2+3, Section 6).
 */
async function recordGenderSelection(teacherId, studentId, level2SessionId, data) {
  await assertStudentBelongsToTeacher(teacherId, studentId);
  await assertSessionOwnership(teacherId, studentId, level2SessionId);

  const q = await SentenceQuestionnaire.findOne({ where: { student_id: studentId } });
  if (!q) throw new ApiError(422, 'Questionnaire not found');

  const correctOnFirst = data.first_tap === q.child_gender;

  const log = await Level2GenderSelectionLog.create({
    level2_session_id:   level2SessionId,
    student_id:          studentId,
    first_tap:           data.first_tap,
    correct_on_first_tap: correctOnFirst,
    required_prompt:     data.required_prompt ?? false,
    auto_advanced:       data.auto_advanced ?? false,
  });

  return {
    id:                  log.id,
    correct_on_first_tap: correctOnFirst,
    expected:            q.child_gender,
  };
}

/**
 * Record the child's activity pre-selection (Sentence 5 pre-step, Section 6).
 * If the child picks the non-favourite activity, the session continues with their choice (BR-05).
 */
async function recordActivitySelection(teacherId, studentId, level2SessionId, data) {
  await assertStudentBelongsToTeacher(teacherId, studentId);
  await assertSessionOwnership(teacherId, studentId, level2SessionId);

  const q = await SentenceQuestionnaire.findOne({ where: { student_id: studentId } });
  if (!q) throw new ApiError(422, 'Questionnaire not found');

  const expected = q.favourite_activities[0];
  const matched  = data.child_selected_activity.toLowerCase() === expected.toLowerCase();

  const log = await Level2ActivitySelectionLog.create({
    level2_session_id:      level2SessionId,
    student_id:             studentId,
    expected_activity:      expected,
    child_selected_activity: data.child_selected_activity,
    matched_expected:        matched,
  });

  return {
    id:              log.id,
    expected_activity: expected,
    child_selected:  data.child_selected_activity,
    matched_expected: matched,
    confirmed_activity: data.child_selected_activity, // BR-05: use what child picked
  };
}

// ── Independent Production Phase ──────────────────────────────────────────

/**
 * Assess the full paragraph attempt (Section 8.1).
 * Checks for presence of each element across the full transcript.
 */
async function assessParagraph(teacherId, studentId, level2SessionId, audioBase64, mimeType, silenceTimeout = false) {
  await assertStudentBelongsToTeacher(teacherId, studentId);
  const session = await assertSessionOwnership(teacherId, studentId, level2SessionId);

  const q = await SentenceQuestionnaire.findOne({ where: { student_id: studentId } });
  if (!q) throw new ApiError(422, 'Questionnaire not found');

  let transcript        = '';
  let elementsDetected  = { name: false, age: false, hometown: false, gender: false, activity: false };
  let totalScore        = 0;
  let transcriptionError = false;

  if (!silenceTimeout && audioBase64) {
    try {
      // Use a full-sentence trigger to get a raw STT transcript
      const triggers = buildTriggers(1, q); // dummy triggers; we just need the raw transcript
      const result   = await speechAssessment.assessSpeech(audioBase64, mimeType, triggers);
      transcript = result.transcript;
    } catch {
      transcriptionError = true;
    }
  }

  if (!transcriptionError && transcript) {
    elementsDetected = detectParagraphElements(transcript, q);
    totalScore = Object.values(elementsDetected).filter(Boolean).length;
  }

  await Level2ProductionAttempt.create({
    level2_session_id:       level2SessionId,
    student_id:              studentId,
    phase:                   'full_paragraph',
    transcript,
    elements_detected:       elementsDetected,
    silence_timeout_triggered: silenceTimeout,
    transcription_error:     transcriptionError,
  });

  // Persist paragraph data to the session record
  await session.update({
    full_paragraph_transcript:        transcript,
    full_paragraph_elements_detected: elementsDetected,
    full_paragraph_total_score:       totalScore,
    silence_timeout_triggered:        silenceTimeout,
  });

  return {
    transcript,
    elements_detected: elementsDetected,
    total_score:       totalScore,
    silence_timeout:   silenceTimeout,
    transcription_error: transcriptionError,
    // BR-06: route to non-verbal if no speech at all
    is_non_verbal: !transcript && !transcriptionError,
  };
}

/**
 * Assess a single sentence in the Sentence-by-Sentence Prompted Attempt (Section 8.2).
 */
async function assessSentenceBySentence(teacherId, studentId, level2SessionId, sentenceIndex, audioBase64, mimeType, silenceTimeout = false) {
  await assertStudentBelongsToTeacher(teacherId, studentId);
  await assertSessionOwnership(teacherId, studentId, level2SessionId);

  const q = await SentenceQuestionnaire.findOne({ where: { student_id: studentId } });
  if (!q) throw new ApiError(422, 'Questionnaire not found');

  let assessment       = { score: 0, transcript: '', match_type: 'no_match' };
  let transcriptionError = false;

  if (!silenceTimeout && audioBase64) {
    try {
      const triggers = buildTriggers(sentenceIndex, q);
      assessment = await speechAssessment.assessSpeech(audioBase64, mimeType, triggers);
    } catch {
      transcriptionError = true;
    }
  }

  const matchType = (assessment.match_type === 'none' || !assessment.match_type)
    ? 'no_match'
    : assessment.match_type;

  await Level2ProductionAttempt.create({
    level2_session_id:        level2SessionId,
    student_id:               studentId,
    phase:                    'sentence_by_sentence',
    sentence_index:           sentenceIndex,
    score:                    assessment.score,
    transcript:               assessment.transcript,
    match_type:               matchType,
    silence_timeout_triggered: silenceTimeout,
    transcription_error:      transcriptionError,
  });

  return {
    sentence_index:      sentenceIndex,
    score:               assessment.score,
    transcript:          assessment.transcript,
    match_type:          matchType,
    silence_timeout:     silenceTimeout,
    transcription_error: transcriptionError,
  };
}

/**
 * Record the result of the non-verbal word-match activity (Section 8.3).
 */
async function recordNonVerbalWordMatch(teacherId, studentId, level2SessionId, sentenceIndex, data) {
  await assertStudentBelongsToTeacher(teacherId, studentId);
  await assertSessionOwnership(teacherId, studentId, level2SessionId);

  const nv = await Level2NonVerbalAttempt.create({
    level2_session_id:        level2SessionId,
    student_id:               studentId,
    sentence_index:           sentenceIndex,
    context:                  'production_fallback',
    correct_on_first_attempt: data.correct_on_first_attempt,
    required_second_attempt:  data.required_second_attempt ?? false,
    auto_shown:               data.auto_shown ?? false,
  });

  return { id: nv.id, sentence_index: sentenceIndex, context: 'production_fallback' };
}

// ── Session completion and mastery logic ──────────────────────────────────

/**
 * Complete the session, compute the SxS element score, and apply the
 * mastery algorithm from Section 11.
 *
 * Topic Mastery:  SxS element score >= 4 in 2 separate sessions on different calendar days.
 * Struggling Flag: SxS element score <= 1 in 3 consecutive sessions.
 */
async function completeSession(teacherId, studentId, level2SessionId) {
  await assertStudentBelongsToTeacher(teacherId, studentId);
  const session = await assertSessionOwnership(teacherId, studentId, level2SessionId);

  // Aggregate SxS scores: count sentences where score >= 1 (element detected)
  const sxsAttempts = await Level2ProductionAttempt.findAll({
    where: {
      level2_session_id: level2SessionId,
      phase: 'sentence_by_sentence',
    },
  });

  const sxsScore = sxsAttempts.reduce((sum, a) => sum + (a.score >= 1 ? 1 : 0), 0);

  // Determine pathway (non-verbal if no SxS verbal attempts recorded)
  const pathway = sxsAttempts.length === 0 ? 'non_verbal' : 'verbal';

  await session.update({
    sxs_element_score: sxsScore,
    pathway,
    is_complete: true,
    ended_at:    new Date(),
    updated_at:  new Date(),
  });

  // ── Mastery algorithm (Section 11) ────────────────────────────────────
  const [progress] = await Level2TopicProgress.findOrCreate({
    where:    { student_id: studentId, topic: 'self_introduction' },
    defaults: {
      student_id:             studentId,
      topic:                  'self_introduction',
      status:                 'not_started',
      session_pass_count:     0,
      last_pass_date:         null,
      consecutive_fail_count: 0,
      total_sessions:         0,
    },
  });

  const today     = todayString();
  const isPass    = sxsScore >= 4;
  const isFail    = sxsScore <= 1;
  const newTotal  = progress.total_sessions + 1;

  let newStatus               = progress.status === 'mastered' ? 'mastered' : 'in_progress';
  let newPassCount            = progress.session_pass_count;
  let newLastPassDate         = progress.last_pass_date;
  let newConsecutiveFailCount = isFail ? progress.consecutive_fail_count + 1 : 0;

  if (progress.status !== 'mastered') {
    if (isPass) {
      const differentDay = progress.last_pass_date && progress.last_pass_date !== today;
      newPassCount    = progress.session_pass_count + 1;
      newLastPassDate = today;
      newConsecutiveFailCount = 0;

      // Mastery: >= 4 score in 2 sessions on different calendar days
      if (newPassCount >= 2 && differentDay) {
        newStatus = 'mastered';
      }
    }

    // Struggling: score <= 1 for 3 consecutive sessions
    if (newConsecutiveFailCount >= 3) {
      newStatus = 'struggling';
    }
  }

  await progress.update({
    status:                 newStatus,
    session_pass_count:     newPassCount,
    last_pass_date:         newLastPassDate,
    consecutive_fail_count: newConsecutiveFailCount,
    total_sessions:         newTotal,
    updated_at:             new Date(),
  });

  return {
    session_id:         level2SessionId,
    sxs_element_score:  sxsScore,
    pathway,
    topic_status:       newStatus,
    mastered:           newStatus === 'mastered',
    struggling:         newStatus === 'struggling',
    total_sessions:     newTotal,
    session_pass_count: newPassCount,
  };
}

// ── Progress retrieval ────────────────────────────────────────────────────

async function getProgress(teacherId, studentId) {
  await assertStudentBelongsToTeacher(teacherId, studentId);

  const [progress] = await Level2TopicProgress.findOrCreate({
    where:    { student_id: studentId, topic: 'self_introduction' },
    defaults: {
      student_id: studentId,
      topic:      'self_introduction',
      status:     'not_started',
    },
  });

  const questionnaire = await SentenceQuestionnaire.findOne({ where: { student_id: studentId } });

  const recentSessions = await Level2Session.findAll({
    where:   { student_id: studentId, is_complete: true },
    order:   [['ended_at', 'DESC']],
    limit:   5,
    attributes: ['id', 'ended_at', 'sxs_element_score', 'full_paragraph_total_score', 'pathway'],
  });

  return {
    topic:                  'self_introduction',
    status:                 progress.status,
    session_pass_count:     progress.session_pass_count,
    consecutive_fail_count: progress.consecutive_fail_count,
    total_sessions:         progress.total_sessions,
    last_pass_date:         progress.last_pass_date,
    questionnaire_complete: !!questionnaire,
    recent_sessions:        recentSessions,
  };
}

module.exports = {
  saveQuestionnaire,
  getQuestionnaire,
  savePortraitStrokes,
  startSession,
  recordStep3,
  assessStep4,
  recordNonVerbalTeaching,
  recordGenderSelection,
  recordActivitySelection,
  assessParagraph,
  assessSentenceBySentence,
  recordNonVerbalWordMatch,
  completeSession,
  getProgress,
};
