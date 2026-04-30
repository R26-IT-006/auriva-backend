'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const { sequelize, DialogueWord } = require('../models');

const WORDS = [
  // ── Greetings ────────────────────────────────────────────────────────────
  {
    word: 'Hello',
    category: 'greetings',
    difficulty: 1,
    teaching_order: 1,
    asset_key: 'hello',
    keyword_triggers: {
      target: 'Hello',
      score3: ['hello', 'helo', 'hallo'],
      score2: ['hi', 'hey', 'ello'],
      score1: ['lo', 'ol'],
    },
  },
  {
    word: 'Goodbye',
    category: 'greetings',
    difficulty: 1,
    teaching_order: 2,
    asset_key: 'goodbye',
    keyword_triggers: {
      target: 'Goodbye',
      score3: ['goodbye', 'good bye', 'goodby'],
      score2: ['bye', 'good by', 'goodbay'],
      score1: ['by', 'bay', 'bi'],
    },
  },
  {
    word: 'Good morning',
    category: 'greetings',
    difficulty: 2,
    teaching_order: 3,
    asset_key: 'good_morning',
    keyword_triggers: {
      target: 'Good morning',
      score3: ['good morning', 'good mornin'],
      score2: ['morning', 'good morin', 'gud morning'],
      score1: ['mornin', 'morin', 'good'],
    },
  },
  {
    word: 'Good afternoon',
    category: 'greetings',
    difficulty: 2,
    teaching_order: 4,
    asset_key: 'good_afternoon',
    keyword_triggers: {
      target: 'Good afternoon',
      score3: ['good afternoon', 'good aftenoon'],
      score2: ['afternoon', 'good after noon', 'gud afternoon'],
      score1: ['after', 'noon', 'aftenoon'],
    },
  },
  {
    word: 'Good night',
    category: 'greetings',
    difficulty: 2,
    teaching_order: 5,
    asset_key: 'good_night',
    keyword_triggers: {
      target: 'Good night',
      score3: ['good night', 'good nite', 'gud night'],
      score2: ['night', 'nite', 'good nigh'],
      score1: ['nigh', 'nit', 'good'],
    },
  },
  {
    word: 'Happy Birthday',
    category: 'greetings',
    difficulty: 2,
    teaching_order: 6,
    asset_key: 'happy_birthday',
    keyword_triggers: {
      target: 'Happy Birthday',
      score3: ['happy birthday', 'happy birtday', 'happy bithday'],
      score2: ['birthday', 'happy birday', 'happy bday'],
      score1: ['birth', 'birday', 'bday'],
    },
  },
  {
    word: 'How are you?',
    category: 'greetings',
    difficulty: 3,
    teaching_order: 7,
    asset_key: 'how_are_you',
    keyword_triggers: {
      target: 'How are you',
      score3: ['how are you', 'how r you', 'how are u'],
      score2: ['how are', 'are you', 'how you'],
      score1: ['how', 'are', 'you'],
    },
  },
  {
    word: "I'm fine",
    category: 'greetings',
    difficulty: 3,
    teaching_order: 8,
    asset_key: 'im_fine',
    keyword_triggers: {
      target: "I'm fine",
      score3: ["i'm fine", 'im fine', "i am fine"],
      score2: ['fine', "i'm good", 'am fine'],
      score1: ['fin', 'fyne', 'i'],
    },
  },
  {
    word: 'Happy New Year',
    category: 'greetings',
    difficulty: 3,
    teaching_order: 9,
    asset_key: 'happy_new_year',
    keyword_triggers: {
      target: 'Happy New Year',
      score3: ['happy new year', 'happy new yeer', 'happy nu year'],
      score2: ['new year', 'happy year', 'happy new'],
      score1: ['year', 'yeer', 'new'],
    },
  },

  // ── Magic Words ──────────────────────────────────────────────────────────
  {
    word: 'Please',
    category: 'magic_words',
    difficulty: 1,
    teaching_order: 2,
    asset_key: 'please',
    keyword_triggers: {
      target: 'Please',
      score3: ['please', 'plese', 'pleese'],
      score2: ['plz', 'pls', 'pleas'],
      score1: ['plee', 'ple', 'pliz'],
    },
  },
  {
    word: 'Thank you',
    category: 'magic_words',
    difficulty: 1,
    teaching_order: 1,
    asset_key: 'thank_you',
    keyword_triggers: {
      target: 'Thank you',
      score3: ['thank you', 'thank you very much', 'thankyou'],
      score2: ['thank', 'thanks', 'thank u'],
      score1: ['tank', 'tanks', 'thenk'],
    },
  },
  {
    word: "I'm Sorry",
    category: 'magic_words',
    difficulty: 2,
    teaching_order: 3,
    asset_key: 'im_sorry',
    keyword_triggers: {
      target: "I'm Sorry",
      score3: ["i'm sorry", 'im sorry', 'i am sorry'],
      score2: ['sorry', 'sory', 'so sorry'],
      score1: ['sor', 'sory', 'soree'],
    },
  },
  {
    word: "You're welcome",
    category: 'magic_words',
    difficulty: 2,
    teaching_order: 4,
    asset_key: 'youre_welcome',
    keyword_triggers: {
      target: "You're welcome",
      score3: ["you're welcome", 'you are welcome', 'your welcome'],
      score2: ['welcome', "youre welcome", 'ur welcome'],
      score1: ['welcom', 'wellcome', 'welkum'],
    },
  },
  {
    word: 'Please excuse me',
    category: 'magic_words',
    difficulty: 3,
    teaching_order: 5,
    asset_key: 'please_excuse_me',
    keyword_triggers: {
      target: 'Please excuse me',
      score3: ['please excuse me', 'please excus me', 'please xcuse me'],
      score2: ['excuse me', 'please excuse', 'scuse me'],
      score1: ['excuse', 'excus', 'cuse'],
    },
  },

  // ── Abilities ────────────────────────────────────────────────────────────
  {
    word: 'Clap',
    category: 'abilities',
    difficulty: 1,
    teaching_order: 1,
    asset_key: 'clap',
    keyword_triggers: {
      target: 'Clap',
      score3: ['clap', 'claps', 'clapping'],
      score2: ['klap', 'clp', 'cap'],
      score1: ['lap', 'cla', 'kap'],
    },
  },
  {
    word: 'Run',
    category: 'abilities',
    difficulty: 1,
    teaching_order: 2,
    asset_key: 'run',
    keyword_triggers: {
      target: 'Run',
      score3: ['run', 'running', 'runs'],
      score2: ['ran', 'ron', 'rn'],
      score1: ['un', 'ru', 'rin'],
    },
  },
  {
    word: 'Walk',
    category: 'abilities',
    difficulty: 1,
    teaching_order: 3,
    asset_key: 'walk',
    keyword_triggers: {
      target: 'Walk',
      score3: ['walk', 'walking', 'walks'],
      score2: ['wak', 'wolk', 'wlk'],
      score1: ['wal', 'wak', 'lok'],
    },
  },
  {
    word: 'Jump',
    category: 'abilities',
    difficulty: 1,
    teaching_order: 4,
    asset_key: 'jump',
    keyword_triggers: {
      target: 'Jump',
      score3: ['jump', 'jumping', 'jumps'],
      score2: ['jamp', 'jmp', 'jomp'],
      score1: ['jum', 'ump', 'jup'],
    },
  },
  {
    word: 'Talk',
    category: 'abilities',
    difficulty: 1,
    teaching_order: 5,
    asset_key: 'talk',
    keyword_triggers: {
      target: 'Talk',
      score3: ['talk', 'talking', 'talks'],
      score2: ['tak', 'tolk', 'tlk'],
      score1: ['tal', 'alk', 'tok'],
    },
  },
  {
    word: 'Dance',
    category: 'abilities',
    difficulty: 1,
    teaching_order: 6,
    asset_key: 'dance',
    keyword_triggers: {
      target: 'Dance',
      score3: ['dance', 'dancing', 'dances'],
      score2: ['dans', 'danse', 'dence'],
      score1: ['dan', 'ans', 'danz'],
    },
  },
  {
    word: 'Sing',
    category: 'abilities',
    difficulty: 1,
    teaching_order: 7,
    asset_key: 'sing',
    keyword_triggers: {
      target: 'Sing',
      score3: ['sing', 'singing', 'sings'],
      score2: ['syng', 'sing', 'sng'],
      score1: ['sin', 'ing', 'syn'],
    },
  },
  {
    word: 'Can you...?',
    category: 'abilities',
    difficulty: 2,
    teaching_order: 8,
    asset_key: 'can_you',
    keyword_triggers: {
      target: 'Can you',
      score3: ['can you', 'can u', 'ken you'],
      score2: ['you can', 'can', 'can yo'],
      score1: ['can', 'you', 'u'],
    },
  },
  {
    word: 'Yes, I can',
    category: 'abilities',
    difficulty: 2,
    teaching_order: 9,
    asset_key: 'yes_i_can',
    keyword_triggers: {
      target: 'Yes I can',
      score3: ['yes i can', 'yes i ken', 'yes i kan'],
      score2: ['yes can', 'i can', 'yes i'],
      score1: ['yes', 'can', 'i can'],
    },
  },
  {
    word: "No, I can't",
    category: 'abilities',
    difficulty: 2,
    teaching_order: 10,
    asset_key: 'no_i_cant',
    keyword_triggers: {
      target: "No I can't",
      score3: ["no i can't", "no i cant", 'no i cannot'],
      score2: ["can't", 'i cannot', 'no cant'],
      score1: ['no', 'cant', 'cannot'],
    },
  },
  {
    word: 'I can.......',
    category: 'abilities',
    difficulty: 3,
    teaching_order: 11,
    asset_key: 'i_can',
    keyword_triggers: {
      target: 'I can',
      score3: ['i can', 'i ken', 'i kan'],
      score2: ['can', 'ican', 'i cen'],
      score1: ['i', 'ca', 'kn'],
    },
  },

  // ── Days of the Week ─────────────────────────────────────────────────────
  {
    word: 'Monday',
    category: 'days_of_week',
    difficulty: 1,
    teaching_order: 1,
    asset_key: 'monday',
    keyword_triggers: {
      target: 'Monday',
      score3: ['monday', 'munday', 'mondy'],
      score2: ['mon', 'monda', 'mondey'],
      score1: ['mon', 'mun', 'day'],
    },
  },
  {
    word: 'Tuesday',
    category: 'days_of_week',
    difficulty: 1,
    teaching_order: 2,
    asset_key: 'tuesday',
    keyword_triggers: {
      target: 'Tuesday',
      score3: ['tuesday', 'tyoosdai', 'tueday'],
      score2: ['tues', 'tuesdai', 'tuesdy'],
      score1: ['tue', 'tus', 'day'],
    },
  },
  {
    word: 'Wednesday',
    category: 'days_of_week',
    difficulty: 1,
    teaching_order: 3,
    asset_key: 'wednesday',
    keyword_triggers: {
      target: 'Wednesday',
      score3: ['wednesday', 'wensday', 'wendsday'],
      score2: ['wed', 'wednesdai', 'wednesdy'],
      score1: ['wed', 'wen', 'day'],
    },
  },
  {
    word: 'Thursday',
    category: 'days_of_week',
    difficulty: 1,
    teaching_order: 4,
    asset_key: 'thursday',
    keyword_triggers: {
      target: 'Thursday',
      score3: ['thursday', 'thursdai', 'thursdy'],
      score2: ['thur', 'thurday', 'thersday'],
      score1: ['thu', 'thur', 'day'],
    },
  },
  {
    word: 'Friday',
    category: 'days_of_week',
    difficulty: 1,
    teaching_order: 5,
    asset_key: 'friday',
    keyword_triggers: {
      target: 'Friday',
      score3: ['friday', 'fryday', 'fridai'],
      score2: ['fri', 'friady', 'fryda'],
      score1: ['fri', 'fry', 'day'],
    },
  },
  {
    word: 'Saturday',
    category: 'days_of_week',
    difficulty: 1,
    teaching_order: 6,
    asset_key: 'saturday',
    keyword_triggers: {
      target: 'Saturday',
      score3: ['saturday', 'saturdai', 'saturdy'],
      score2: ['sat', 'saturay', 'saterday'],
      score1: ['sat', 'satur', 'day'],
    },
  },
  {
    word: 'Sunday',
    category: 'days_of_week',
    difficulty: 1,
    teaching_order: 7,
    asset_key: 'sunday',
    keyword_triggers: {
      target: 'Sunday',
      score3: ['sunday', 'sundai', 'sundy'],
      score2: ['sun', 'sunady', 'sunda'],
      score1: ['sun', 'sn', 'day'],
    },
  },
  {
    word: "What's the day today?",
    category: 'days_of_week',
    difficulty: 2,
    teaching_order: 8,
    asset_key: 'whats_the_day_today',
    keyword_triggers: {
      target: "What's the day today",
      score3: ["what's the day today", 'whats the day today', "what is the day today"],
      score2: ['what day today', 'the day today', "what's the day"],
      score1: ['what', 'day', 'today'],
    },
  },
  {
    word: 'Today is.....',
    category: 'days_of_week',
    difficulty: 2,
    teaching_order: 9,
    asset_key: 'today_is',
    keyword_triggers: {
      target: 'Today is',
      score3: ['today is', 'today iz', 'today it is'],
      score2: ['today', 'todays', 'today its'],
      score1: ['today', 'tday', 'is'],
    },
  },
];

async function seed() {
  await sequelize.authenticate();
  console.log('Connected to database');

  await sequelize.sync({ alter: true });
  console.log('Schema synced');

  let created = 0;
  let updated = 0;

  for (const wordData of WORDS) {
    const [, wasCreated] = await DialogueWord.upsert(wordData, {
      conflictFields: ['asset_key'],
    });
    if (wasCreated) {
      created++;
      console.log(`  Created: "${wordData.word}" (${wordData.category})`);
    } else {
      updated++;
      console.log(`  Updated: "${wordData.word}" (${wordData.category})`);
    }
  }

  console.log(`\nDone — ${created} created, ${updated} updated`);
  console.log(`Total words in DB: ${await DialogueWord.count()}`);

  await sequelize.close();
}

seed().catch((err) => {
  console.error('Dialogue seed failed:', err.message);
  process.exit(1);
});
