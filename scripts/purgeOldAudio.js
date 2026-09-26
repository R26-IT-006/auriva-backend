'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const { Op } = require('sequelize');
const { sequelize, PronunciationSessionResult } = require('../src/models');

// Retention window in days. Only raw_audio_data (the BLOB('long') column) is
// cleared — teacher_reviewed_score and every other score field on the row
// stay forever, since adaptiveCalibrationService fits Layer 3 on those.
const RETENTION_DAYS = Number(process.env.AUDIO_RETENTION_DAYS) || 60;

async function purgeOldAudio() {
  await sequelize.authenticate();

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const [affectedCount] = await PronunciationSessionResult.update(
    { raw_audio_data: null, raw_audio_mime_type: null },
    {
      where: {
        raw_audio_data: { [Op.ne]: null },
        created_at: { [Op.lt]: cutoff },
      },
    }
  );

  console.log(`Purged raw_audio_data on ${affectedCount} row(s) older than ${RETENTION_DAYS} days (before ${cutoff.toISOString()}). raw_audio_size left intact as a historical record that audio once existed.`);
  await sequelize.close();
}

purgeOldAudio().catch((err) => {
  console.error('purgeOldAudio failed:', err);
  process.exit(1);
});
