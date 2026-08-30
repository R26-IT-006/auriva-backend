'use strict';

const { spawn, execFile } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { promisify } = require('util');

const logger = require('../utils/logger');

const execFileAsync = promisify(execFile);

const PHONEME_GOP_ENABLED = process.env.PHONEME_GOP_ENABLED !== 'false';
const PYTHON_PATH = process.env.PHONEME_GOP_PYTHON ||
  path.resolve(__dirname, '../../ml/venv/bin/python');
const WORKER_SCRIPT = path.resolve(__dirname, '../../ml/phoneme_gop_worker.py');
const HF_CACHE_DIR = process.env.HF_HOME ||
  path.resolve(__dirname, '../../models/hf-cache');
const REQUEST_TIMEOUT_MS = Number(process.env.PHONEME_GOP_TIMEOUT_MS || 30000);
const STARTUP_TIMEOUT_MS = Number(process.env.PHONEME_GOP_STARTUP_TIMEOUT_MS || 120000);
const FFMPEG_TIMEOUT_MS = Number(process.env.FFMPEG_TIMEOUT_MS || 20000);
const FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

let worker = null;
let workerReady = null;
let unavailableUntil = 0;
let requestCounter = 0;
const pending = new Map();

function rejectAllPending(reason) {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
  pending.clear();
}

function stopWorker() {
  if (worker) {
    worker.kill();
    worker = null;
  }
  workerReady = null;
}

let rewarmTimer = null;

function markUnavailable(reason) {
  logger.warn(`Phoneme GOP worker unavailable: ${reason}`);
  unavailableUntil = Date.now() + FAILURE_COOLDOWN_MS;
  rejectAllPending(reason);
  stopWorker();

  // Re-warm in the background once the cooldown lapses. Without this, the
  // first escalated attempt after a crash pays the full ~120s model load
  // inside a live request — the boot-time warmup only covers server start.
  if (rewarmTimer) clearTimeout(rewarmTimer);
  rewarmTimer = setTimeout(() => {
    rewarmTimer = null;
    warmup().then((ready) => {
      if (ready) logger.info('Phoneme GOP worker re-warmed after cooldown');
    });
  }, FAILURE_COOLDOWN_MS + 1000); // +1s so the cooldown gate is already open
  if (rewarmTimer.unref) rewarmTimer.unref();
}

function startWorker() {
  const child = spawn(PYTHON_PATH, [WORKER_SCRIPT], {
    env: { ...process.env, HF_HOME: HF_CACHE_DIR, HF_HUB_OFFLINE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  worker = child;

  const lines = readline.createInterface({ input: child.stdout });

  workerReady = new Promise((resolve, reject) => {
    const startupTimer = setTimeout(() => {
      reject(new Error('worker startup timed out'));
      markUnavailable('startup timeout');
    }, STARTUP_TIMEOUT_MS);

    lines.on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }

      if (message.ready) {
        clearTimeout(startupTimer);
        logger.info('Phoneme GOP worker ready');
        resolve();
        return;
      }

      const entry = pending.get(message.id);
      if (entry) {
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.ok) entry.resolve(message.result);
        else entry.reject(new Error(message.error || 'gop worker error'));
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) logger.debug(`gop worker: ${text}`);
    });

    child.on('error', (error) => {
      clearTimeout(startupTimer);
      reject(error);
      markUnavailable(error.message);
    });

    child.on('exit', (code) => {
      clearTimeout(startupTimer);
      reject(new Error(`worker exited (${code})`));
      if (worker === child) markUnavailable(`worker exited with code ${code}`);
    });
  });
  workerReady.catch(() => {});

  return workerReady;
}

async function sendRequest(payload) {
  if (!worker) await startWorker();
  await workerReady;

  requestCounter += 1;
  const id = requestCounter;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('gop request timed out'));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    worker.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
  });
}

function getInputExtension(mimeType = '') {
  const lower = String(mimeType).toLowerCase();
  if (lower.includes('webm')) return '.webm';
  if (lower.includes('wav')) return '.wav';
  if (lower.includes('mpeg') || lower.includes('mp3')) return '.mp3';
  if (lower.includes('3gpp')) return '.3gp';
  return '.m4a';
}

/**
 * Runs wav2vec2 phoneme recognition + GOP scoring on an attempt.
 *
 * Returns the assessment object, or null when the GOP engine is disabled or
 * unavailable — callers must treat null as "no GOP evidence" and fall back to
 * acoustic-only scoring, never fail the attempt because of this layer.
 */
async function assessPhonemeGop({ rawAudioBase64, mimeType, targetSounds }) {
  if (!PHONEME_GOP_ENABLED) return null;
  if (Date.now() < unavailableUntil) return null;
  if (!Array.isArray(targetSounds) || !targetSounds.length) return null;

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auriva-gop-'));
  const inputPath = path.join(tmpDir, `attempt${getInputExtension(mimeType)}`);
  const wavPath = path.join(tmpDir, 'attempt.wav');

  try {
    await fs.writeFile(inputPath, Buffer.from(rawAudioBase64, 'base64'));
    await execFileAsync('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', inputPath,
      '-ac', '1',
      '-ar', '16000',
      wavPath,
    ], { timeout: FFMPEG_TIMEOUT_MS });

    return await sendRequest({ wav_path: wavPath, target_sounds: targetSounds });
  } catch (error) {
    logger.warn(`Phoneme GOP assessment skipped: ${error.message}`);
    return null;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Starts the worker at server boot instead of on first request. With the
 * layer-1 DTW cascade gating layer 2, the first GOP call can land on any live
 * escalated attempt rather than predictably on request one — an unwarmed
 * worker would then make a real child's attempt eat the ~120s model-load
 * cold start. Fire-and-forget: never throws, never blocks server startup.
 */
function warmup() {
  if (!PHONEME_GOP_ENABLED) return Promise.resolve(false);
  if (Date.now() < unavailableUntil) return Promise.resolve(false);
  if (!worker) startWorker();
  return workerReady.then(() => true, () => false);
}

module.exports = {
  assessPhonemeGop,
  warmup,
};
