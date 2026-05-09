'use strict';

const { Op } = require('sequelize');
const {
  Teacher,
  Student,
  Session,
  StudentAvatar,
  PronunciationSessionResult,
} = require('../models');
const ApiError = require('../utils/ApiError');

const PHONEME_CUES = {
  'æ': 'Open the mouth wide for the short /a/ sound.',
  'ɒ': 'Round the lips gently for the short /o/ sound.',
  'ɪ': 'Use a small smile for the short /i/ sound.',
  'ɜː': 'Keep the mouth relaxed for the long middle vowel.',
  'iː': 'Smile and stretch the long /ee/ sound.',
  'eɪ': 'Start with /e/ and glide to /i/.',
  'ɔː': 'Round the lips for the long /or/ sound.',
  'uː': 'Round the lips and hold the long /oo/ sound.',
  'ʌ': 'Open the mouth slightly for the short /u/ sound.',
  b: 'Close both lips, then release with voice.',
  p: 'Close both lips, then release with a soft pop.',
  m: 'Close both lips and hum through the nose.',
  f: 'Touch teeth to lower lip and blow air.',
  v: 'Touch teeth to lower lip and add voice.',
  s: 'Keep teeth close and send air forward.',
  z: 'Keep teeth close and add a buzzing voice.',
  t: 'Tap the tongue behind the teeth.',
  d: 'Tap the tongue behind the teeth with voice.',
  k: 'Lift the back of the tongue for the back-mouth sound.',
  g: 'Lift the back of the tongue and add voice.',
  h: 'Use an open mouth with gentle breath.',
  l: 'Lift the tongue tip behind the teeth.',
  r: 'Curl or bunch the tongue without touching the teeth.',
  w: 'Round the lips first, then open.',
  'ʃ': 'Round the lips slightly and push quiet air.',
  'tʃ': 'Start with a tongue tap, then release air.',
  'dʒ': 'Start with a tongue tap, then release with voice.',
};

const WORD_PROFILES = {
  cat: { difficulty: 1, sounds: ['k', 'æ', 't'], easierWords: ['ant'], relatedWords: ['kangaroo', 'crab'] },
  dog: { difficulty: 1, sounds: ['d', 'ɒ', 'g'], easierWords: ['deer'], relatedWords: ['goose'] },
  fish: { difficulty: 2, sounds: ['f', 'ɪ', 'ʃ'], easierWords: ['fox'], relatedWords: ['chick', 'jellyfish'] },
  bird: { difficulty: 2, sounds: ['b', 'ɜː', 'd'], easierWords: ['book'], relatedWords: ['buffalo', 'butterfly'] },
  worm: { difficulty: 2, sounds: ['w', 'ɜː', 'm'], relatedWords: ['whale', 'walk'] },
  whale: { difficulty: 2, sounds: ['w', 'eɪ', 'l'], easierWords: ['worm'], relatedWords: ['walk'] },
  turtle: { difficulty: 3, sounds: ['t', 'ɜː', 't', 'əl'], easierWords: ['cat', 'ant'], relatedWords: ['tiger'] },
  tiger: { difficulty: 3, sounds: ['t', 'aɪ', 'gə'], easierWords: ['dog'], relatedWords: ['turtle'] },
  snail: { difficulty: 3, sounds: ['s', 'n', 'eɪ', 'l'], easierWords: ['goose'], relatedWords: ['desk'] },
  pigeon: { difficulty: 3, sounds: ['p', 'ɪ', 'dʒ', 'ən'], easierWords: ['hippo'], relatedWords: ['penguin'] },
  penguin: { difficulty: 4, sounds: ['p', 'e', 'ŋ', 'gwɪn'], easierWords: ['pigeon'], relatedWords: ['mango'] },
  mosquito: { difficulty: 5, sounds: ['m', 'ɒ', 'sk', 'iː', 'təʊ'], easierWords: ['worm'], relatedWords: ['desk'] },
  leopard: { difficulty: 3, sounds: ['l', 'e', 'p', 'əd'], easierWords: ['apple'], relatedWords: ['hippo'] },
  kangaroo: { difficulty: 5, sounds: ['k', 'æ', 'ŋg', 'ə', 'ruː'], easierWords: ['cat'], relatedWords: ['crab'] },
  jellyfish: { difficulty: 5, sounds: ['dʒ', 'e', 'l', 'i', 'f', 'ɪʃ'], easierWords: ['fish'], relatedWords: ['jump'] },
  horse: { difficulty: 2, sounds: ['h', 'ɔː', 's'], easierWords: ['goose'], relatedWords: ['hippo'] },
  hippo: { difficulty: 3, sounds: ['h', 'ɪ', 'p', 'əʊ'], easierWords: ['horse'], relatedWords: ['pigeon'] },
  goose: { difficulty: 2, sounds: ['g', 'uː', 's'], easierWords: ['dog'], relatedWords: ['horse'] },
  fox: { difficulty: 2, sounds: ['f', 'ɒ', 'ks'], easierWords: ['fish'], relatedWords: ['book'] },
  elephant: { difficulty: 5, sounds: ['e', 'l', 'ə', 'f', 'ənt'], easierWords: ['eagle', 'ant'], relatedWords: ['buffalo'] },
  eagle: { difficulty: 3, sounds: ['iː', 'g', 'əl'], easierWords: ['goose'], relatedWords: ['deer'] },
  deer: { difficulty: 1, sounds: ['d', 'ɪə'], easierWords: ['dog'], relatedWords: ['desk'] },
  crab: { difficulty: 3, sounds: ['k', 'r', 'æ', 'b'], easierWords: ['cat'], relatedWords: ['kangaroo'] },
  cow: { difficulty: 1, sounds: ['k', 'aʊ'], easierWords: ['cat'], relatedWords: ['crab'] },
  chick: { difficulty: 2, sounds: ['tʃ', 'ɪ', 'k'], easierWords: ['cat'], relatedWords: ['fish'] },
  butterfly: { difficulty: 5, sounds: ['b', 'ʌ', 't', 'ə', 'flaɪ'], easierWords: ['bird', 'buffalo'], relatedWords: ['buffalo'] },
  buffalo: { difficulty: 5, sounds: ['b', 'ʌ', 'f', 'ə', 'ləʊ'], easierWords: ['bird'], relatedWords: ['butterfly'] },
  ant: { difficulty: 1, sounds: ['æ', 'n', 't'], easierWords: ['cat'], relatedWords: ['elephant'] },
  book: { difficulty: 1, sounds: ['b', 'ʊ', 'k'], easierWords: ['bird'], relatedWords: ['desk'] },
  desk: { difficulty: 2, sounds: ['d', 'e', 'sk'], easierWords: ['deer'], relatedWords: ['snail'] },
  apple: { difficulty: 2, sounds: ['a', 'p', 'əl'], easierWords: ['ant'], relatedWords: ['leopard'] },
  mango: { difficulty: 3, sounds: ['m', 'æ', 'ŋgəʊ'], easierWords: ['worm'], relatedWords: ['penguin'] },
  walk: { difficulty: 2, sounds: ['w', 'ɔː', 'k'], easierWords: ['worm'], relatedWords: ['whale'] },
  jump: { difficulty: 3, sounds: ['dʒ', 'ʌ', 'mp'], easierWords: ['jellyfish'], relatedWords: ['butterfly'] },
};

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function getSoundPosition(index, total) {
  if (total <= 1) return 'single';
  if (index === 0) return 'initial';
  if (index === total - 1) return 'final';
  return 'medial';
}

function normalizeSounds(data) {
  const profile = WORD_PROFILES[data.word_id] || {};
  const sourceSounds = Array.isArray(data.target_phonemes) && data.target_phonemes.length
    ? data.target_phonemes
    : profile.sounds || [];

  return sourceSounds.map((sound, index) => {
    const text = typeof sound === 'string' ? sound : sound.text;
    const type = typeof sound === 'string' ? null : sound.type || null;
    const position = typeof sound === 'string'
      ? getSoundPosition(index, sourceSounds.length)
      : sound.position || getSoundPosition(index, sourceSounds.length);

    return {
      text,
      type,
      position,
      cue: PHONEME_CUES[text] || (typeof sound === 'string' ? null : sound.cue || null),
    };
  }).filter((sound) => sound.text);
}

function pickWeakSound({ sounds, baseScore, difficulty, attemptNumber, historyCounts }) {
  if (!sounds.length) return null;

  return sounds
    .map((sound, index) => {
      const positionPenalty = sound.position === 'medial' ? 7 : sound.position === 'final' ? 4 : 2;
      const historyPenalty = (historyCounts[sound.text] || 0) * 9;
      const attemptPenalty = Math.max(0, attemptNumber - 1) * 3;
      const longSoundPenalty = String(sound.text).length > 1 ? 4 : 0;

      return {
        ...sound,
        score: clampScore(baseScore - difficulty * 4 - positionPenalty - historyPenalty - attemptPenalty - longSoundPenalty + index * 2),
      };
    })
    .sort((a, b) => a.score - b.score)[0];
}

function buildHistoryCounts(results = []) {
  return results.reduce((counts, result) => {
    const phonemeScores = Array.isArray(result.phoneme_scores) ? result.phoneme_scores : [];
    phonemeScores
      .filter((entry) => entry?.text && Number(entry.score) < 65)
      .forEach((entry) => {
        counts[entry.text] = (counts[entry.text] || 0) + 1;
      });
    return counts;
  }, {});
}

function chooseNextWord({ wordId, weakSound, overallScore, historyCounts }) {
  const profile = WORD_PROFILES[wordId] || {};
  const candidateIds = overallScore < 60
    ? [...(profile.easierWords || []), ...(profile.relatedWords || [])]
    : [...(profile.relatedWords || []), ...(profile.easierWords || [])];

  const matchingCandidate = candidateIds.find((candidateId) => {
    const candidate = WORD_PROFILES[candidateId];
    return candidate?.sounds?.includes(weakSound?.text);
  });
  const fallbackCandidate = candidateIds.find((candidateId) => WORD_PROFILES[candidateId]);

  if (matchingCandidate) return matchingCandidate;
  if (fallbackCandidate) return fallbackCandidate;

  const repeatedWeakSound = Object.entries(historyCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (repeatedWeakSound) {
    return Object.entries(WORD_PROFILES).find(
      ([candidateId, candidate]) => candidateId !== wordId && candidate.sounds.includes(repeatedWeakSound)
    )?.[0] || null;
  }

  return null;
}

function buildRecommendation({ overallScore, weakSound, nextWordId, historyCounts }) {
  const repeatedCount = weakSound?.text ? historyCounts[weakSound.text] || 0 : 0;
  const positionText = weakSound?.position ? `${weakSound.position} ` : '';
  const soundText = weakSound?.text ? `/${weakSound.text}/` : 'the target sound';

  if (overallScore >= 80) {
    return {
      recommendation_type: 'continue',
      recommendation_message: nextWordId
        ? `Pronunciation is strong. Continue to the next related word: ${nextWordId}.`
        : 'Pronunciation is strong. Continue to the next planned word.',
    };
  }

  if (overallScore >= 60) {
    return {
      recommendation_type: 'reinforce',
      recommendation_message: repeatedCount > 0
        ? `Reinforce the ${positionText}${soundText} sound; it has appeared as a weak sound before.`
        : `Reinforce the ${positionText}${soundText} sound with another related word.`,
    };
  }

  return {
    recommendation_type: 'remediate',
    recommendation_message: `Use a simpler support word before moving ahead because the ${positionText}${soundText} sound needs support.`,
  };
}

function normalizeStudentId(studentId) {
  const numericId = Number(studentId);
  return Number.isInteger(numericId) && numericId > 0 ? numericId : studentId;
}

async function findTeacherStudent(teacherId, studentId) {
  return Student.findOne({
    where: { sid: normalizeStudentId(studentId), teacher_id: teacherId },
  });
}

async function getDashboardStats(teacherId) {
  const startOfWeek = new Date();
  startOfWeek.setHours(0, 0, 0, 0);
  startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay()); // Sunday

  const [profile, totalSessions, weeklySessions, lastSession] = await Promise.all([
    Teacher.findByPk(teacherId, { attributes: { exclude: ['password_hash'] } }),
    PronunciationSessionResult.count({ where: { teacher_id: teacherId } }),
    PronunciationSessionResult.count({
      where: { teacher_id: teacherId, created_at: { [Op.gte]: startOfWeek } },
    }),
    PronunciationSessionResult.findOne({
      where: { teacher_id: teacherId },
      order: [['created_at', 'DESC'], ['id', 'DESC']],
      include: [{ model: Student, as: 'student', attributes: ['sid', 'full_name', 'student_code'] }],
    }),
  ]);

  if (!profile) throw new ApiError(404, 'Teacher not found');

  return {
    profile,
    stats: {
      totalSessions,
      weeklySessions,
      lastSession: lastSession
        ? {
            studentName: lastSession.student?.full_name,
            studentCode: lastSession.student?.student_code,
            date: lastSession.created_at,
            score: lastSession.overall_score,
            wordLabel: lastSession.word_label,
          }
        : null,
    },
  };
}

async function getOwnStudents(teacherId) {
  const students = await Student.findAll({
    where: { teacher_id: teacherId },
    order: [['student_code', 'ASC']],
    include: [{ model: StudentAvatar, as: 'avatarRecord', attributes: ['avatar_key'] }],
  });
  return students.map(flattenAvatar);
}

async function getOwnStudentById(teacherId, studentId) {
  const student = await Student.findOne({
    where: { sid: normalizeStudentId(studentId), teacher_id: teacherId },
    include: [{ model: StudentAvatar, as: 'avatarRecord', attributes: ['avatar_key'] }],
  });
  if (!student) throw new ApiError(404, 'Student not found or not assigned to you');
  return flattenAvatar(student);
}

async function setAvatar(teacherId, studentId, avatarKey) {
  // Verify the student belongs to this teacher
  const student = await Student.findOne({ where: { sid: studentId, teacher_id: teacherId } });
  if (!student) throw new ApiError(404, 'Student not found or not assigned to you');

  const [record] = await StudentAvatar.upsert({
    student_id:  studentId,
    avatar_key:  avatarKey,
    selected_by: teacherId,
    selected_at: new Date(),
  });
  return record;
}

async function startSession(teacherId, studentId) {
  const student = await Student.findOne({ where: { sid: studentId, teacher_id: teacherId } });
  if (!student) throw new ApiError(404, 'Student not found or not assigned to you');

  const existing = await Session.findOne({
    where: { teacher_id: teacherId, student_id: studentId, is_active: true },
  });
  if (existing) throw new ApiError(409, 'A session is already active for this student');

  return Session.create({ teacher_id: teacherId, student_id: studentId });
}

async function endSession(teacherId, studentId) {
  const session = await Session.findOne({
    where: { teacher_id: teacherId, student_id: studentId, is_active: true },
  });
  if (!session) throw new ApiError(404, 'No active session found for this student');

  await session.update({ ended_at: new Date(), is_active: false });
  return session;
}

async function savePronunciationResult(teacherId, studentId, data) {
  const student = await findTeacherStudent(teacherId, studentId);
  if (!student) throw new ApiError(404, 'Student not found or not assigned to you');
  const rawAudioBuffer = data.raw_audio_base64
    ? Buffer.from(data.raw_audio_base64, 'base64')
    : null;

  return PronunciationSessionResult.create({
    teacher_id: teacherId,
    student_id: student.sid,
    mode: data.mode,
    category_id: data.category_id || null,
    word_id: data.word_id,
    word_label: data.word_label,
    overall_score: data.overall_score,
    phoneme_scores: data.phoneme_scores || [],
    listen_choose_data: data.listen_choose_data || null,
    response_duration: data.response_duration ?? null,
    hesitation_time: data.hesitation_time ?? null,
    recommendation_type: data.recommendation_type || null,
    recommendation_message: data.recommendation_message || null,
    next_word_id: data.next_word_id || null,
    attempt_number: data.attempt_number || 1,
    workflow_completed: data.workflow_completed ?? true,
    recording_uri: data.recording_uri || null,
    raw_audio_data: rawAudioBuffer,
    raw_audio_mime_type: data.raw_audio_mime_type || null,
    raw_audio_size: rawAudioBuffer?.length || data.raw_audio_size || null,
  });
}

async function scorePronunciationAttempt(teacherId, studentId, data) {
  const student = await findTeacherStudent(teacherId, studentId);
  if (!student) throw new ApiError(404, 'Student not found or not assigned to you');

  const profile = WORD_PROFILES[data.word_id] || {};
  const sounds = normalizeSounds(data);
  const previousResults = await PronunciationSessionResult.findAll({
    where: { teacher_id: teacherId, student_id: student.sid },
    order: [['created_at', 'DESC'], ['id', 'DESC']],
    limit: 12,
  });
  const historyCounts = buildHistoryCounts(
    previousResults.map((result) => result.get({ plain: true }))
  );

  const rawAudioSize = data.raw_audio_base64
    ? Buffer.byteLength(data.raw_audio_base64, 'base64')
    : data.raw_audio_size || 0;
  const responseDuration = Number(data.response_duration || 0);
  const attemptNumber = Math.max(1, Number(data.attempt_number || 1));
  const difficulty = Number(data.difficulty || profile.difficulty || 2);
  const durationPenalty = responseDuration > 0
    ? Math.min(18, Math.abs(responseDuration - Math.max(1.2, difficulty * 0.75)) * 4)
    : 8;
  const audioPresenceBonus = rawAudioSize > 0 ? 8 : -18;
  const audioLengthSignal = rawAudioSize > 0
    ? Math.min(10, Math.log10(rawAudioSize) * 2)
    : 0;
  const attemptPenalty = Math.max(0, attemptNumber - 1) * 4;
  const recurringPenalty = Object.values(historyCounts).reduce((total, count) => total + Math.min(count, 3), 0);
  const baseScore = clampScore(
    78 + audioPresenceBonus + audioLengthSignal - difficulty * 3 - durationPenalty - attemptPenalty - recurringPenalty
  );
  const weakSound = pickWeakSound({
    sounds,
    baseScore,
    difficulty,
    attemptNumber,
    historyCounts,
  });
  const phonemeScores = sounds.map((sound, index) => {
    const isWeakSound = weakSound?.text === sound.text && weakSound?.position === sound.position;
    const positionPenalty = sound.position === 'medial' ? 5 : sound.position === 'final' ? 3 : 1;
    const historyPenalty = (historyCounts[sound.text] || 0) * 6;
    const score = isWeakSound
      ? weakSound.score
      : baseScore - positionPenalty - historyPenalty + index * 3;

    return {
      text: sound.text,
      type: sound.type,
      position: sound.position,
      cue: sound.cue,
      score: clampScore(score),
    };
  });
  const averagePhonemeScore = phonemeScores.length
    ? phonemeScores.reduce((total, sound) => total + sound.score, 0) / phonemeScores.length
    : baseScore;
  const overallScore = clampScore((baseScore + averagePhonemeScore) / 2);
  const nextWordId = chooseNextWord({
    wordId: data.word_id,
    weakSound,
    overallScore,
    historyCounts,
  });
  const recommendation = buildRecommendation({
    overallScore,
    weakSound,
    nextWordId,
    historyCounts,
  });
  const hesitationTime = data.hesitation_time ?? Number(
    Math.max(0.2, Math.min(6, 0.4 + attemptNumber * 0.28 + (overallScore < 65 ? 0.8 : 0.15))).toFixed(1)
  );

  return {
    mode: data.mode || 'word',
    category_id: data.category_id || null,
    word_id: data.word_id,
    word_label: data.word_label || data.word_id,
    overall_score: overallScore,
    phoneme_scores: phonemeScores,
    response_duration: responseDuration || null,
    hesitation_time: hesitationTime,
    weak_phoneme: weakSound?.text || null,
    weak_position: weakSound?.position || null,
    recurring_weak_phoneme_count: weakSound?.text ? historyCounts[weakSound.text] || 0 : 0,
    next_word_id: nextWordId,
    attempt_number: attemptNumber,
    scoring_method: 'prototype_signal_rule_v1',
    ...recommendation,
  };
}

async function getPronunciationResults(teacherId, studentId) {
  const student = await findTeacherStudent(teacherId, studentId);
  if (!student) throw new ApiError(404, 'Student not found or not assigned to you');

  const results = await PronunciationSessionResult.findAll({
    where: { teacher_id: teacherId, student_id: student.sid },
    order: [['created_at', 'ASC'], ['id', 'ASC']],
  });

  return results
    .map((result, index) => {
      const plain = result.get({ plain: true });
      const hasRawAudio = Boolean(plain.raw_audio_data);
      delete plain.raw_audio_data;

      return {
        ...plain,
        has_raw_audio: hasRawAudio,
        session_number: index + 1,
      };
    })
    .reverse();
}

async function getPronunciationResultAudio(teacherId, resultId) {
  const result = await PronunciationSessionResult.findOne({
    where: { id: resultId, teacher_id: teacherId },
    attributes: [
      'id',
      'raw_audio_data',
      'raw_audio_mime_type',
      'raw_audio_size',
    ],
  });

  if (!result) throw new ApiError(404, 'Pronunciation result not found');
  if (!result.raw_audio_data) throw new ApiError(404, 'No audio saved for this session');

  return {
    id: result.id,
    raw_audio_base64: Buffer.from(result.raw_audio_data).toString('base64'),
    raw_audio_mime_type: result.raw_audio_mime_type || 'audio/mp4',
    raw_audio_size: result.raw_audio_size || result.raw_audio_data.length,
  };
}

// Flatten avatarRecord association into a plain avatar_key field
function flattenAvatar(student) {
  const plain = student.get({ plain: true });
  plain.avatar_key = plain.avatarRecord?.avatar_key ?? null;
  delete plain.avatarRecord;
  return plain;
}

module.exports = {
  getDashboardStats,
  getOwnStudents,
  getOwnStudentById,
  setAvatar,
  startSession,
  endSession,
  scorePronunciationAttempt,
  savePronunciationResult,
  getPronunciationResults,
  getPronunciationResultAudio,
};
