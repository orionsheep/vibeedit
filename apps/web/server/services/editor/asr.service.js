/**
 * AutoEdit ASR service
 * Handles ASR (Automatic Speech Recognition) via the AutoEdit Python CLI
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { ensureWorkspaceDirs, loadConfig } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UV_CMD = 'uv';
const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, '../../../../../');
const PROJECT_ROOT = resolveProjectRoot();
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.avi', '.webm', '.ts', '.mts']);
const SILICONFLOW_PROVIDER = 'siliconflow';
const SILICONFLOW_DEFAULT_MODEL = 'FunAudioLLM/SenseVoiceSmall';
const SILICONFLOW_CHUNK_SECONDS = 30;
const SILICONFLOW_CONTEXT_SECONDS = 5;

function resolveProjectRoot() {
  const candidates = [
    process.env.AUTOEDIT_PY_ROOT ? path.resolve(process.env.AUTOEDIT_PY_ROOT) : null,
    DEFAULT_PROJECT_ROOT,
    process.cwd()
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'scripts', 'cli.py'))) {
      return candidate;
    }
  }

  return DEFAULT_PROJECT_ROOT;
}

/**
 * Run ASR pipeline on audio file
 * @param {string} audioPath - Path to audio/video file
 * @param {string} language - Language code (e.g., 'Chinese', 'English')
 * @returns {Promise<Object>} ASR result with language, text, duration, words
 */
export async function runAsrPipeline(audioPath, language = 'Chinese') {
  const config = loadConfig();
  if (String(config.asr_provider || '').trim().toLowerCase() === SILICONFLOW_PROVIDER) {
    return runSiliconFlowAsrPipeline(audioPath, language, config);
  }

  return runLocalAsrPipeline(audioPath, language);
}

async function runLocalAsrPipeline(audioPath, language = 'Chinese') {
  const { outputsDir } = ensureWorkspaceDirs();
  const tempFile = path.join(outputsDir, `temp_${uuidv4().substring(0, 8)}.json`);
  const prepared = await prepareAsrInput(audioPath, outputsDir);

  const args = ['run', 'python', 'scripts/cli.py', 'asr', prepared.inputPath, '--format', 'json', '-o', tempFile];

  if (language) {
    args.push('--language', language);
  }

  console.log(`[ASR Service] Running: uv run python scripts/cli.py asr "${prepared.inputPath}"`);

  try {
    const result = await spawnProcess(UV_CMD, args, PROJECT_ROOT);

    // Read output JSON
    if (fs.existsSync(tempFile)) {
      const content = fs.readFileSync(tempFile, 'utf-8');
      const data = JSON.parse(content);

      // Clean up temp file
      fs.unlinkSync(tempFile);

      return {
        language: data.language || language,
        text: data.text || '',
        duration: data.duration || 0,
        words: data.words || []
      };
    }

    throw new Error('ASR output file not created');

  } catch (error) {
    // Clean up temp file if exists
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
    throw error;
  } finally {
    await prepared.cleanup();
  }
}

async function runSiliconFlowAsrPipeline(audioPath, language = 'Chinese', config = loadConfig()) {
  const { outputsDir } = ensureWorkspaceDirs();
  const prepared = await prepareAsrInput(audioPath, outputsDir);

  try {
    const duration = await probeAudioDuration(prepared.inputPath);
    const useChunking = duration > 300;
    const allWords = [];
    let finalLanguage = language || 'Chinese';

    for (let keepStart = 0; keepStart < Math.max(duration, 0.001); keepStart += useChunking ? SILICONFLOW_CHUNK_SECONDS : duration || 1) {
      const keepEnd = useChunking ? Math.min(duration, keepStart + SILICONFLOW_CHUNK_SECONDS) : duration;
      const contextStart = useChunking ? Math.max(0, keepStart - SILICONFLOW_CONTEXT_SECONDS) : 0;
      const contextEnd = useChunking ? Math.min(duration, keepEnd + SILICONFLOW_CONTEXT_SECONDS) : duration;
      const chunkPath = path.join(outputsDir, `asr_chunk_${uuidv4().substring(0, 8)}.wav`);

      try {
        await extractAudioSegmentToWav(prepared.inputPath, chunkPath, contextStart, Math.max(contextEnd - contextStart, 0.01));
        const chunkText = await transcribeWithSiliconFlow(chunkPath, language, config);
        if (!chunkText.trim()) {
          continue;
        }

        const aligned = await runAlignmentPipeline(chunkPath, chunkText, language, outputsDir);
        finalLanguage = aligned.language || finalLanguage;

        const chunkWords = (aligned.words || []).map((word) => ({
          text: word.text || '',
          start_time: Number(word.start_time || 0) + contextStart,
          end_time: Number(word.end_time || 0) + contextStart
        }));

        const retainedWords = useChunking
          ? chunkWords.filter((word) => {
              const midpoint = (word.start_time + word.end_time) / 2;
              return keepStart <= midpoint && (midpoint < keepEnd || (keepEnd >= duration && midpoint <= keepEnd));
            })
          : chunkWords;

        allWords.push(...retainedWords);
      } finally {
        if (fs.existsSync(chunkPath)) {
          await fs.promises.unlink(chunkPath).catch(() => {});
        }
      }

      if (!useChunking) break;
    }

    allWords.sort((a, b) => {
      if (a.start_time !== b.start_time) return a.start_time - b.start_time;
      if (a.end_time !== b.end_time) return a.end_time - b.end_time;
      return String(a.text || '').localeCompare(String(b.text || ''));
    });

    return {
      language: finalLanguage,
      text: allWords.map((word) => word.text || '').join(''),
      duration,
      words: allWords
    };
  } finally {
    await prepared.cleanup();
  }
}

function isLikelyVideo(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return VIDEO_EXTENSIONS.has(ext);
}

async function prepareAsrInput(inputPath, outputsDir) {
  if (!isLikelyVideo(inputPath)) {
    return {
      inputPath,
      cleanup: async () => {}
    };
  }

  const tempWav = path.join(outputsDir, `asr_input_${uuidv4().substring(0, 8)}.wav`);
  console.log(`[ASR Service] Extracting audio from video: ${inputPath}`);
  await extractAudioToWav(inputPath, tempWav);

  return {
    inputPath: tempWav,
    cleanup: async () => {
      if (fs.existsSync(tempWav)) {
        await fs.promises.unlink(tempWav).catch(() => {});
      }
    }
  };
}

function extractAudioToWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', inputPath,
      '-vn',
      '-acodec', 'pcm_s16le',
      '-ar', '16000',
      '-ac', '1',
      outputPath
    ];

    const proc = spawn('ffmpeg', args, {
      cwd: PROJECT_ROOT,
      shell: false
    });

    let stderr = '';
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `ffmpeg exited with code ${code}`));
      }
    });

    proc.on('error', (error) => {
      reject(new Error(`Failed to extract audio: ${error.message}`));
    });
  });
}

function extractAudioSegmentToWav(inputPath, outputPath, startSeconds, durationSeconds) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-ss', String(Math.max(0, startSeconds)),
      '-t', String(Math.max(0.01, durationSeconds)),
      '-i', inputPath,
      '-vn',
      '-acodec', 'pcm_s16le',
      '-ar', '16000',
      '-ac', '1',
      outputPath
    ];

    const proc = spawn('ffmpeg', args, {
      cwd: PROJECT_ROOT,
      shell: false
    });

    let stderr = '';
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `ffmpeg exited with code ${code}`));
      }
    });

    proc.on('error', (error) => {
      reject(new Error(`Failed to extract audio segment: ${error.message}`));
    });
  });
}

async function probeAudioDuration(inputPath) {
  const stdout = await spawnProcess('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    inputPath
  ], PROJECT_ROOT);

  const duration = Number(String(stdout || '').trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Unable to determine audio duration for ${inputPath}`);
  }
  return duration;
}

async function transcribeWithSiliconFlow(audioPath, language, config) {
  const apiKey = String(config.siliconflow_api_key || process.env.SILICONFLOW_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('SiliconFlow API key is not configured');
  }

  const baseUrl = String(config.siliconflow_base_url || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '');
  const model = String(config.siliconflow_asr_model || SILICONFLOW_DEFAULT_MODEL).trim() || SILICONFLOW_DEFAULT_MODEL;
  const form = new FormData();
  const buffer = await fs.promises.readFile(audioPath);
  const languageCode = normalizeSiliconFlowLanguage(language);

  form.append('model', model);
  form.append('file', new Blob([buffer], { type: 'audio/wav' }), path.basename(audioPath));
  if (languageCode) {
    form.append('language', languageCode);
  }

  const response = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: form
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`SiliconFlow ASR failed (${response.status}): ${raw}`);
  }

  let payload = raw;
  try {
    payload = JSON.parse(raw);
  } catch {
    // keep raw text
  }

  if (typeof payload === 'string') {
    return payload.trim();
  }

  if (payload && typeof payload.text === 'string') {
    return payload.text.trim();
  }

  throw new Error(`Unexpected SiliconFlow ASR response: ${raw}`);
}

function normalizeSiliconFlowLanguage(language) {
  const normalized = String(language || '').trim().toLowerCase();
  if (!normalized) return '';
  if (['chinese', 'zh', 'zh-cn', 'mandarin'].includes(normalized)) return 'zh';
  if (['english', 'en', 'en-us', 'en-gb'].includes(normalized)) return 'en';
  return '';
}

async function runAlignmentPipeline(audioPath, transcriptText, language, outputsDir) {
  const tempText = path.join(outputsDir, `align_text_${uuidv4().substring(0, 8)}.txt`);
  const tempJson = path.join(outputsDir, `align_${uuidv4().substring(0, 8)}.json`);

  try {
    await fs.promises.writeFile(tempText, transcriptText, 'utf-8');
    const args = ['run', 'python', 'scripts/cli.py', 'align', audioPath, '--text-file', tempText, '-o', tempJson];

    if (language) {
      args.push('--language', language);
    }

    await spawnProcess(UV_CMD, args, PROJECT_ROOT);
    const content = await fs.promises.readFile(tempJson, 'utf-8');
    return JSON.parse(content);
  } finally {
    if (fs.existsSync(tempText)) {
      await fs.promises.unlink(tempText).catch(() => {});
    }
    if (fs.existsSync(tempJson)) {
      await fs.promises.unlink(tempJson).catch(() => {});
    }
  }
}

/**
 * Parse ASR result from JSON file
 * @param {string} jsonPath - Path to ASR JSON file
 * @returns {Object} Parsed ASR result
 */
export async function parseAsrResult(jsonPath) {
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`ASR JSON file not found: ${jsonPath}`);
  }

  const content = await fs.promises.readFile(jsonPath, 'utf-8');
  return JSON.parse(content);
}

/**
 * Wrap ASR result for frontend compatibility
 * Converts word-level ASR to segment format expected by frontend
 * @param {Object} asrResult - Raw ASR result
 * @returns {Object} Frontend-compatible ASR result
 */
export function wrapAsrForFrontend(asrResult) {
  if (asrResult.words && !asrResult.segments) {
    return {
      language: asrResult.language || 'Chinese',
      text: asrResult.text || '',
      duration: asrResult.duration || 0,
      segments: [{ words: asrResult.words }]
    };
  }

  return asrResult;
}

/**
 * Spawn a child process and collect output
 * @param {string} command - Command to run
 * @param {Array<string>} args - Arguments
 * @param {string} cwd - Working directory
 * @returns {Promise<string>} stdout output
 */
function spawnProcess(command, args, cwd) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn(command, args, {
      cwd,
      shell: false
    });

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      console.log(`[ASR stdout] ${text.trim()}`);
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      console.error(`[ASR stderr] ${text.trim()}`);
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || `ASR process exited with code ${code}`));
      }
    });

    proc.on('error', (error) => {
      reject(new Error(`Failed to spawn ASR process: ${error.message}`));
    });
  });
}

/**
 * Run ASR with progress callback
 * @param {string} audioPath - Path to audio file
 * @param {string} language - Language code
 * @param {Function} onProgress - Progress callback (progress: number, message: string)
 * @returns {Promise<Object>} ASR result
 */
export async function runAsrWithProgress(audioPath, language, onProgress) {
  onProgress(10, 'Starting ASR processing...');

  try {
    const result = await runAsrPipeline(audioPath, language);
    onProgress(100, 'ASR processing complete');
    return result;
  } catch (error) {
    onProgress(0, `ASR failed: ${error.message}`);
    throw error;
  }
}
