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

// TASK-19 describe_friend / describe_pet constants.
const FRIEND_PERSONALITIES = ['kind', 'funny', 'nice']; // closed set, R-16 discipline
const PET_TYPES = ['cat', 'dog', 'cow', 'fish', 'parrot', 'rabbit']; // closed six, R-16
const FRIEND_AGE_MIN = 5;  // same range as child_age (AgePicker.js, TASK-16)
const FRIEND_AGE_MAX = 12;
const FRIEND_GRADE_MIN = 1; // friend's own school grade — wider than the child's curriculum-anchor grade
const FRIEND_GRADE_MAX = 8;

const petSentenceData = require('../data/pet_sentences.json');

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
 * Build the describe_friend sentence set (§FRIEND-SENTENCES, TASK-19).
 * Assumes the paired-validation invariant (friend_gender set whenever
 * friend_name is set) already holds from saveQuestionnaire — throws
 * defensively if it somehow doesn't, rather than rendering a broken/
 * gender-less sentence. Sentences 3/4/5 are independently optional per
 * their own field; sentence 2 always renders whenever friend_gender is set.
 */
function buildFriendSentences(q) {
  if (!q.friend_name || !q.friend_gender) {
    throw new ApiError(422, 'describe_friend requires friend_name and friend_gender to be set on the questionnaire');
  }

  const subject = q.friend_gender === 'girl' ? 'She' : 'He';
  const ageDelta   = (Math.random() < 0.5 ? 1 : 2) * (Math.random() < 0.5 ? 1 : -1);
  const gradeDelta = (Math.random() < 0.5 ? 1 : 2) * (Math.random() < 0.5 ? 1 : -1);

  const defs = [
    {
      index: 1,
      text: `My friend's name is ${q.friend_name}.`,
      dynamic_value: q.friend_name,
      distractor: pickRandom(SL_NAMES, q.friend_name),
    },
    {
      index: 2,
      text: q.friend_gender === 'girl' ? 'My friend is a girl.' : 'My friend is a boy.',
      dynamic_value: q.friend_gender,
      distractor: q.friend_gender === 'boy' ? 'girl' : 'boy',
    },
  ];

  if (q.friend_age != null) {
    defs.push({
      index: 3,
      text: `${subject} is ${q.friend_age} years old.`,
      dynamic_value: q.friend_age,
      distractor: Math.min(FRIEND_AGE_MAX, Math.max(FRIEND_AGE_MIN, q.friend_age + ageDelta)),
    });
  }
  if (q.friend_grade != null) {
    defs.push({
      index: 4,
      text: `${subject} is in grade ${q.friend_grade}.`,
      dynamic_value: q.friend_grade,
      distractor: Math.min(FRIEND_GRADE_MAX, Math.max(FRIEND_GRADE_MIN, q.friend_grade + gradeDelta)),
    });
  }
  if (q.friend_personality) {
    defs.push({
      index: 5,
      text: `I like my friend because ${subject.toLowerCase()} is ${q.friend_personality}.`,
      dynamic_value: q.friend_personality,
      distractor: pickRandom(FRIEND_PERSONALITIES, q.friend_personality),
    });
  }

  return defs.map((d) => ({ ...d, words: d.text.split(' ') }));
}

/**
 * Build the describe_pet sentence set (§PET-SENTENCES, TASK-19). Sentence
 * content is fixed per-animal curriculum data from pet_sentences.json, NOT
 * derived from pet_type by any template rule. Sentence index 2 is omitted
 * entirely (not rendered with an empty/placeholder name) when pet_name is
 * null; sentences 1/3/4/5 always render.
 *
 * Distractors: sentence 1 (pet_type) and sentence 2 (pet_name, when
 * present) are the only per-student facts here, so they're the only
 * sentences that get one — sentences 3/4/5 are fixed curriculum content
 * with no per-student "true" value to discriminate against (see STATE.md).
 */
function buildPetSentences(q) {
  if (!q.pet_type || !petSentenceData[q.pet_type]) {
    throw new ApiError(422, 'describe_pet requires a valid pet_type to be set on the questionnaire');
  }

  const templates = petSentenceData[q.pet_type].sentences;
  const distractorAnimal = pickRandom(PET_TYPES, q.pet_type);

  const defs = [];
  templates.forEach((template, i) => {
    const index = i + 1;

    if (index === 2) {
      if (!q.pet_name) return;
      defs.push({
        index,
        text: template.replace('{pet_name}', q.pet_name),
        dynamic_value: q.pet_name,
        distractor: pickRandom(SL_NAMES, q.pet_name),
      });
      return;
    }

    if (index === 1) {
      defs.push({ index, text: template, dynamic_value: q.pet_type, distractor: distractorAnimal });
      return;
    }

    defs.push({ index, text: template });
  });

  return defs.map((d) => ({ ...d, words: d.text.split(' ') }));
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
 * TASK-32: shared trigger-derivation for describe_friend/describe_pet.
 * Given a per-index def object from buildFriendSentences/buildPetSentences
 * ({index, text, dynamic_value?}), derives the SAME 3-tier shape
 * buildTriggers uses (target/score3/score2/score1: full phrase -> partial
 * phrase + core word -> core word alone) — never re-authoring curriculum
 * text, only slicing/lowercasing what the sentence builders already
 * produced. The "core word" is `dynamic_value` when the def has one (a
 * per-student fact — friend's name/gender/age/grade/personality, or the
 * pet's type/name); when it doesn't (pet sentences 3-5, fixed curriculum
 * content with no per-student value — confirmed via pet_sentences.json:
 * every animal's sound/colour/adjective sentence ends on its own
 * distinguishing content word), the sentence's own last word is used
 * instead — verified against all 6 animals x 3 fixed sentences that this
 * always lands on the meaningful word (meow/orange/soft, woof/brown/fun,
 * etc., including the two irregular structures "swims"/"hops").
 */
function deriveTriggersFromDef(def) {
  const target   = def.text.toLowerCase().replace(/[.,!?]/g, '').trim();
  const words    = target.split(' ');
  const coreWord = def.dynamic_value !== undefined
    ? String(def.dynamic_value).toLowerCase()
    : words[words.length - 1];

  return {
    target,
    score3: [target, words.slice(1).join(' ')],
    score2: [words.slice(0, 2).join(' '), coreWord],
    score1: [coreWord],
  };
}

/**
 * TASK-32: Step 4 triggers for a describe_friend sentence, derived from
 * buildFriendSentences(q)'s own output (TASK-19) — never re-authored here.
 * Throws a clear 422 (not a silent fallback / crash) if sentenceIndex
 * doesn't correspond to an actual rendered sentence for this student (e.g.
 * index 3 when friend_age was never filled in — buildFriendSentences omits
 * that index entirely rather than renumbering).
 */
function buildFriendTriggers(sentenceIndex, q) {
  const def = buildFriendSentences(q).find((d) => d.index === sentenceIndex);
  if (!def) {
    throw new ApiError(422, `Sentence ${sentenceIndex} was not rendered for this student's describe_friend session (the matching questionnaire field isn't filled in).`);
  }
  return deriveTriggersFromDef(def);
}

/**
 * TASK-32: Step 4 triggers for a describe_pet sentence, derived from
 * buildPetSentences(q)'s own output (TASK-19) — never re-authored here.
 * Throws a clear 422 if sentenceIndex doesn't correspond to an actual
 * rendered sentence (e.g. index 2 when pet_name was never filled in).
 */
function buildPetTriggers(sentenceIndex, q) {
  const def = buildPetSentences(q).find((d) => d.index === sentenceIndex);
  if (!def) {
    throw new ApiError(422, `Sentence ${sentenceIndex} was not rendered for this student's describe_pet session (the matching questionnaire field isn't filled in).`);
  }
  return deriveTriggersFromDef(def);
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

/**
 * Reject invalid describe_friend/describe_pet fields (TASK-19). All nine
 * fields are independently nullable EXCEPT friend_gender, which becomes
 * required the instant friend_name is provided (§FRIEND-SENTENCES
 * paired-validation rule) — same validation step as pet_type's closed-set
 * rejection, not a separate new code path.
 */
function validateFriendPet(data) {
  if (data.pet_type !== undefined && data.pet_type !== null && !PET_TYPES.includes(data.pet_type)) {
    throw new ApiError(422, `pet_type must be one of: ${PET_TYPES.join(', ')}`);
  }

  if (data.friend_name && !data.friend_gender) {
    throw new ApiError(422, 'friend_gender is required once friend_name is provided');
  }

  if (data.friend_gender !== undefined && data.friend_gender !== null && !['boy', 'girl'].includes(data.friend_gender)) {
    throw new ApiError(422, "friend_gender must be 'boy' or 'girl'");
  }

  if (data.friend_personality !== undefined && data.friend_personality !== null && !FRIEND_PERSONALITIES.includes(data.friend_personality)) {
    throw new ApiError(422, `friend_personality must be one of: ${FRIEND_PERSONALITIES.join(', ')}`);
  }

  if (data.friend_age !== undefined && data.friend_age !== null) {
    if (!Number.isInteger(data.friend_age) || data.friend_age < FRIEND_AGE_MIN || data.friend_age > FRIEND_AGE_MAX) {
      throw new ApiError(422, `friend_age must be a whole number between ${FRIEND_AGE_MIN} and ${FRIEND_AGE_MAX}`);
    }
  }

  if (data.friend_grade !== undefined && data.friend_grade !== null) {
    if (!Number.isInteger(data.friend_grade) || data.friend_grade < FRIEND_GRADE_MIN || data.friend_grade > FRIEND_GRADE_MAX) {
      throw new ApiError(422, `friend_grade must be a whole number between ${FRIEND_GRADE_MIN} and ${FRIEND_GRADE_MAX}`);
    }
  }
}

async function saveQuestionnaire(teacherId, studentId, data) {
  await assertStudentBelongsToTeacher(teacherId, studentId);
  validatePortraitStrokes(data.portrait_strokes);
  validateFriendPet(data);

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
 * Return the describe_friend sentence patterns + words for a student
 * (TASK-19 AC3). Mirrors self_introduction's sentence-pattern shape
 * (index/text/dynamic_value/distractor/words) without the audio-generation
 * step — audio for these sentences is exercised directly via
 * ttsService.tokeniseSentence/generateSentenceAudioSSML (see startSession's
 * dynamicNames extension) rather than through a session-start flow, since
 * wiring describe_friend/describe_pet into Level2Session/completeSession's
 * mastery tracking is out of this task's scope (see STATE.md).
 */
async function getFriendSentences(teacherId, studentId) {
  await assertStudentBelongsToTeacher(teacherId, studentId);
  const q = await SentenceQuestionnaire.findOne({ where: { student_id: studentId } });
  if (!q) throw new ApiError(422, 'Questionnaire not found. Please complete the questionnaire first.');
  return { topic: 'describe_friend', sentences: buildFriendSentences(q) };
}

/** Return the describe_pet sentence patterns + words for a student (TASK-19 AC3). */
async function getPetSentences(teacherId, studentId) {
  await assertStudentBelongsToTeacher(teacherId, studentId);
  const q = await SentenceQuestionnaire.findOne({ where: { student_id: studentId } });
  if (!q) throw new ApiError(422, 'Questionnaire not found. Please complete the questionnaire first.');
  return { topic: 'describe_pet', sentences: buildPetSentences(q) };
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
 * TASK-31: describe_friend / describe_pet session start (RESOLVED Option A,
 * planner decision 2026-08-04, see STATE.md — no full-paragraph/Independent
 * Production phase for these two topics; sentence-by-sentence only).
 * Reuses the SAME tokeniseSentence/generateSentenceAudioSSML/dynamicNames
 * pipeline self_introduction's own path (below) already established
 * (TASK-19/29/30) — this function does not duplicate that pipeline's
 * internals, only its call pattern, since it must stay independent of
 * self_introduction's path to keep that path byte-for-byte untouched (AC2).
 */
async function startFriendPetSession(teacherId, studentId, topic, q, parentSessionId) {
  const sentenceDefs = topic === 'describe_friend' ? buildFriendSentences(q) : buildPetSentences(q);

  // Same dynamic-proper-noun construction as self_introduction's own path
  // below (TASK-30, extended by TASK-19) — duplicated here rather than
  // extracted into a shared helper, to keep that path's own lines untouched.
  const dynamicNames = {
    ...(q.child_first_name_sinhala ? { [q.child_first_name]: q.child_first_name_sinhala } : {}),
    ...(q.friend_name_sinhala ? { [q.friend_name]: q.friend_name_sinhala } : {}),
    ...(q.pet_name_sinhala ? { [q.pet_name]: q.pet_name_sinhala } : {}),
  };

  let sentenceAudios;
  try {
    const buffers = await Promise.all(
      sentenceDefs.map((d) =>
        ttsService.generateSentenceAudioSSML(ttsService.tokeniseSentence(d.text, undefined, dynamicNames), q.child_gender, dynamicNames)
      )
    );
    sentenceAudios = buffers.map((b) => b.toString('base64'));
  } catch (err) {
    throw new ApiError(502, 'Could not prepare the lesson audio. Please check your connection and try again.');
  }

  const level2Session = await Level2Session.create({
    teacher_id:  teacherId,
    student_id:  studentId,
    session_id:  parentSessionId,
    topic,
    started_at:  new Date(),
  });

  return {
    session_id: level2Session.id,
    topic,
    sentences: sentenceDefs.map((d, i) => ({
      index:         d.index,
      text:          d.text,
      dynamic_value: d.dynamic_value,
      distractor:    d.distractor,
      words:         d.words,
      audio_base64:  sentenceAudios[i],
    })),
    gender: q.child_gender,
  };
}

/**
 * Start a Level 2 session. topic defaults to 'self_introduction' so every
 * existing caller that omits it keeps its exact prior behavior (TASK-31).
 * Validates the questionnaire, generates TTS audio, and returns all session data
 * needed by the frontend to run the full session flow.
 * BR-01: questionnaire must exist. BR-02: all TTS clips must succeed.
 */
async function startSession(teacherId, studentId, topic = 'self_introduction', parentSessionId = null) {
  await assertStudentBelongsToTeacher(teacherId, studentId);

  const q = await SentenceQuestionnaire.findOne({ where: { student_id: studentId } });
  if (!q) {
    throw new ApiError(422, 'Questionnaire is incomplete. Please fill in the child\'s details before starting a Level 2 session.');
  }

  // TASK-31: describe_friend/describe_pet use a separate, sentence-by-
  // sentence-only path above — self_introduction's own path below is
  // completely unchanged from before this task.
  if (topic === 'describe_friend' || topic === 'describe_pet') {
    return startFriendPetSession(teacherId, studentId, topic, q, parentSessionId);
  }

  const sentences  = buildSentences(q);
  const paragraph  = buildParagraph(q);
  const distractors = buildDistractors(q);

  // Per-request dynamic proper nouns (TASK-30, extended by TASK-19): the
  // child's own name, friend's name, and pet's name, each only when a
  // teacher-confirmed Sinhala spelling exists. Omit any key entirely when
  // null/empty — the existing unmatched-proper-noun fallback (plain English
  // + console.warn) already handles that case, no separate degradation path.
  const dynamicNames = {
    ...(q.child_first_name_sinhala ? { [q.child_first_name]: q.child_first_name_sinhala } : {}),
    ...(q.friend_name_sinhala ? { [q.friend_name]: q.friend_name_sinhala } : {}),
    ...(q.pet_name_sinhala ? { [q.pet_name]: q.pet_name_sinhala } : {}),
  };

  // BR-02: TTS must complete before session is created.
  // SSML + district/dynamic-name voice routing (TASK-21/29/30): each
  // sentence/paragraph is tokenised so Sinhala proper nouns (name/hometown)
  // render via a native si-LK voice segment instead of plain-text synthesis.
  let sentenceAudios;
  let paragraphAudio;
  try {
    const buffers = await Promise.all([
      ...sentences.map((s) => ttsService.generateSentenceAudioSSML(ttsService.tokeniseSentence(s, undefined, dynamicNames), q.child_gender, dynamicNames)),
      ttsService.generateSentenceAudioSSML(ttsService.tokeniseSentence(paragraph, undefined, dynamicNames), q.child_gender, dynamicNames),
    ]);
    sentenceAudios = buffers.slice(0, 5).map((b) => b.toString('base64'));
    paragraphAudio = buffers[5].toString('base64');
  } catch (err) {
    throw new ApiError(502, 'Could not prepare the lesson audio. Please check your connection and try again.');
  }

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
  const session = await assertSessionOwnership(teacherId, studentId, level2SessionId);

  const q = await SentenceQuestionnaire.findOne({ where: { student_id: studentId } });
  if (!q) throw new ApiError(422, 'Questionnaire not found');

  // TASK-32: triggers depend on the session's own topic. self_introduction
  // calls the EXISTING buildTriggers completely unchanged. Built OUTSIDE
  // the try/catch below (unlike before) so a genuine "sentence wasn't
  // rendered for this student" 422 from buildFriendTriggers/buildPetTriggers
  // propagates to the caller, instead of being silently swallowed into a
  // soft "no match" result the way a real STT/speech-API failure is meant
  // to be — buildTriggers itself never throws for a valid 1-5 index, so
  // this is not a behavior change for self_introduction (AC3).
  const triggers = session.topic === 'describe_friend'
    ? buildFriendTriggers(sentenceIndex, q)
    : session.topic === 'describe_pet'
      ? buildPetTriggers(sentenceIndex, q)
      : buildTriggers(sentenceIndex, q);

  let assessment;
  let transcriptionError = false;

  try {
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

  // TASK-31 AC6: describe_friend/describe_pet sessions skip the full-
  // paragraph phase entirely (RESOLVED Option A, see STATE.md) —
  // detectParagraphElements below is hardcoded to self_introduction's own
  // fields (child_first_name/child_age/etc.) and would silently score
  // against the wrong data if run against another topic's session, since
  // every topic shares the same SentenceQuestionnaire row. Guard as defense
  // in depth even though the frontend flow shouldn't reach this endpoint
  // for these topics.
  if (session.topic !== 'self_introduction') {
    throw new ApiError(409, 'The full-paragraph phase is not applicable for this session\'s topic.');
  }

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
  // TASK-31: looked up by the session's OWN topic (session.topic, captured
  // via the widened enum_level2_sessions_topic), not implicitly
  // self_introduction — same mastery rules/thresholds below, applied
  // per-topic rather than changed.
  const [progress] = await Level2TopicProgress.findOrCreate({
    where:    { student_id: studentId, topic: session.topic },
    defaults: {
      student_id:             studentId,
      topic:                  session.topic,
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
    topic:              session.topic,
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

// TASK-32: topic defaults to 'self_introduction' so every existing caller
// that omits it keeps its exact prior behavior (AC1), same discipline as
// TASK-31's startSession change.
async function getProgress(teacherId, studentId, topic = 'self_introduction') {
  await assertStudentBelongsToTeacher(teacherId, studentId);

  const [progress] = await Level2TopicProgress.findOrCreate({
    where:    { student_id: studentId, topic },
    defaults: {
      student_id: studentId,
      topic,
      status:     'not_started',
    },
  });

  const questionnaire = await SentenceQuestionnaire.findOne({ where: { student_id: studentId } });

  // TASK-32: scoped to THIS topic — without this filter, sessions from
  // different topics would show up interleaved in one list (AC2).
  const recentSessions = await Level2Session.findAll({
    where:   { student_id: studentId, topic, is_complete: true },
    order:   [['ended_at', 'DESC']],
    limit:   5,
    attributes: ['id', 'ended_at', 'sxs_element_score', 'full_paragraph_total_score', 'pathway'],
  });

  return {
    topic,
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
  getFriendSentences,
  getPetSentences,
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
