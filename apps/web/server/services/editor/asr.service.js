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
const QWEN_FILETRANS_PROVIDER = 'qwen_filetrans';
const QWEN_FILETRANS_DEFAULT_MODEL = 'qwen3-asr-flash-filetrans-2025-11-17';
const QWEN_FILETRANS_DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1';
const QWEN_FILETRANS_POLL_INTERVAL_MS = 2000;
const QWEN_FILETRANS_TIMEOUT_MS = 10 * 60 * 1000;
const DEEPGRAM_PROVIDER = 'deepgram';
const DEEPGRAM_DEFAULT_MODEL = 'nova-3';
const SILICONFLOW_PROVIDER = 'siliconflow';
const SILICONFLOW_DEFAULT_MODEL = 'FunAudioLLM/SenseVoiceSmall';
const SILICONFLOW_CHUNK_SECONDS = 30;
const SILICONFLOW_CONTEXT_SECONDS = 5;
const PUNCTUATION_CHARS = new Set('，。、！？；：""\'\'《》【】（）,.!?;:\'"()[]{}·…—~ '.split(''));

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
  if (String(config.asr_provider || '').trim().toLowerCase() === QWEN_FILETRANS_PROVIDER) {
    return runQwenFiletransAsrPipeline(audioPath, language, config);
  }
  if (String(config.asr_provider || '').trim().toLowerCase() === DEEPGRAM_PROVIDER) {
    return runDeepgramAsrPipeline(audioPath, language, config);
  }
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

async function runDeepgramAsrPipeline(audioPath, language = 'Chinese', config = loadConfig()) {
  const { outputsDir } = ensureWorkspaceDirs();
  const prepared = await prepareAsrInput(audioPath, outputsDir);

  try {
    const [duration, result] = await Promise.all([
      probeAudioDuration(prepared.inputPath),
      transcribeWithDeepgram(prepared.inputPath, language, config)
    ]);

    return {
      language: result.language || language || 'Chinese',
      text: result.text || '',
      duration,
      words: result.words || []
    };
  } finally {
    await prepared.cleanup();
  }
}

async function runQwenFiletransAsrPipeline(audioPath, language = 'Chinese', config = loadConfig()) {
  const apiKey = String(
    config.dashscope_api_key
      || process.env.DASHSCOPE_API_KEY
      || process.env.BAILIAN_API_KEY
      || process.env.MODEL_STUDIO_API_KEY
      || ''
  ).trim();

  if (!apiKey) {
    throw new Error('DashScope API key is not configured');
  }

  const fileUrl = resolveQwenFiletransFileUrl(audioPath);
  const baseUrl = String(config.dashscope_base_url || QWEN_FILETRANS_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = String(config.dashscope_asr_model || QWEN_FILETRANS_DEFAULT_MODEL).trim() || QWEN_FILETRANS_DEFAULT_MODEL;
  const timeoutMs = Number(config.dashscope_task_timeout_ms || QWEN_FILETRANS_TIMEOUT_MS);
  const normalizedLanguage = normalizeQwenFiletransLanguage(language);
  const taskId = await submitQwenFiletransTask({
    apiKey,
    baseUrl,
    model,
    fileUrl,
    language: normalizedLanguage
  });
  const transcriptionUrl = await waitForQwenFiletransTask({
    apiKey,
    baseUrl,
    taskId,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : QWEN_FILETRANS_TIMEOUT_MS
  });
  const rawResult = await fetchQwenFiletransResult(transcriptionUrl);
  return parseQwenFiletransResult(rawResult, normalizedLanguage || language);
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

async function transcribeWithDeepgram(audioPath, language, config) {
  const apiKey = String(config.deepgram_api_key || process.env.DEEPGRAM_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('Deepgram API key is not configured');
  }

  const baseUrl = String(config.deepgram_base_url || 'https://api.deepgram.com/v1').replace(/\/+$/, '');
  const model = String(config.deepgram_asr_model || DEEPGRAM_DEFAULT_MODEL).trim() || DEEPGRAM_DEFAULT_MODEL;
  const languageCode = normalizeDeepgramLanguage(language);
  const params = new URLSearchParams({
    model,
    punctuate: 'true',
    smart_format: 'true'
  });

  if (languageCode) {
    params.set('language', languageCode);
  }

  const response = await fetch(`${baseUrl}/listen?${params.toString()}`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': inferAudioMimeType(audioPath)
    },
    body: await fs.promises.readFile(audioPath)
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Deepgram ASR failed (${response.status}): ${raw}`);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(`Unexpected Deepgram ASR response: ${raw}`);
  }

  return parseDeepgramAsrResponse(payload, languageCode || language);
}

function normalizeSiliconFlowLanguage(language) {
  const normalized = String(language || '').trim().toLowerCase();
  if (!normalized) return '';
  if (['chinese', 'zh', 'zh-cn', 'mandarin'].includes(normalized)) return 'zh';
  if (['english', 'en', 'en-us', 'en-gb'].includes(normalized)) return 'en';
  return '';
}

function normalizeQwenFiletransLanguage(language) {
  const normalized = String(language || '').trim();
  if (!normalized) return '';

  const lower = normalized.toLowerCase();
  const aliasMap = new Map([
    ['chinese', 'zh'],
    ['mandarin', 'zh'],
    ['zh', 'zh'],
    ['zh-cn', 'zh'],
    ['zh-hans', 'zh'],
    ['cantonese', 'yue'],
    ['yue', 'yue'],
    ['zh-hk', 'yue'],
    ['english', 'en'],
    ['en', 'en'],
    ['japanese', 'ja'],
    ['ja', 'ja'],
    ['german', 'de'],
    ['de', 'de'],
    ['korean', 'ko'],
    ['ko', 'ko'],
    ['russian', 'ru'],
    ['ru', 'ru'],
    ['french', 'fr'],
    ['fr', 'fr'],
    ['portuguese', 'pt'],
    ['pt', 'pt'],
    ['arabic', 'ar'],
    ['ar', 'ar'],
    ['italian', 'it'],
    ['it', 'it'],
    ['spanish', 'es'],
    ['es', 'es'],
    ['hindi', 'hi'],
    ['hi', 'hi'],
    ['indonesian', 'id'],
    ['id', 'id'],
    ['thai', 'th'],
    ['th', 'th'],
    ['turkish', 'tr'],
    ['tr', 'tr'],
    ['ukrainian', 'uk'],
    ['uk', 'uk'],
    ['vietnamese', 'vi'],
    ['vi', 'vi'],
    ['czech', 'cs'],
    ['cs', 'cs'],
    ['danish', 'da'],
    ['da', 'da'],
    ['filipino', 'fil'],
    ['fil', 'fil'],
    ['finnish', 'fi'],
    ['fi', 'fi'],
    ['icelandic', 'is'],
    ['is', 'is'],
    ['malay', 'ms'],
    ['ms', 'ms'],
    ['norwegian', 'no'],
    ['no', 'no'],
    ['polish', 'pl'],
    ['pl', 'pl'],
    ['swedish', 'sv'],
    ['sv', 'sv']
  ]);

  if (aliasMap.has(lower)) {
    return aliasMap.get(lower);
  }

  return '';
}

function resolveQwenFiletransFileUrl(audioPath) {
  if (isHttpUrl(audioPath)) {
    return String(audioPath).trim();
  }

  throw new Error('Qwen Filetrans requires a publicly accessible file URL; local file paths cannot be sent directly');
}

async function submitQwenFiletransTask({ apiKey, baseUrl, model, fileUrl, language }) {
  const payload = {
    model,
    input: {
      file_url: fileUrl
    },
    parameters: {
      channel_id: [0],
      enable_itn: false,
      enable_words: true
    }
  };

  if (language) {
    payload.parameters.language = language;
  }

  const response = await fetch(`${baseUrl}/services/audio/asr/transcription`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable'
    },
    body: JSON.stringify(payload)
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Qwen Filetrans submit failed (${response.status}): ${raw}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Unexpected Qwen Filetrans submit response: ${raw}`);
  }

  const taskId = data?.output?.task_id || data?.output?.taskId;
  if (!taskId) {
    throw new Error(`Qwen Filetrans submit returned no task_id: ${raw}`);
  }

  return String(taskId);
}

async function waitForQwenFiletransTask({ apiKey, baseUrl, taskId, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/tasks/${encodeURIComponent(taskId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-DashScope-Async': 'enable'
      }
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`Qwen Filetrans task polling failed (${response.status}): ${raw}`);
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`Unexpected Qwen Filetrans task polling response: ${raw}`);
    }

    const output = data?.output || {};
    const status = String(output.task_status || output.taskStatus || '').trim().toUpperCase();

    if (status === 'SUCCEEDED') {
      const transcriptionUrl = output?.result?.transcription_url || output?.result?.transcriptionUrl;
      if (!transcriptionUrl) {
        throw new Error(`Qwen Filetrans task succeeded without transcription_url: ${raw}`);
      }
      return String(transcriptionUrl);
    }

    if (status === 'FAILED') {
      const code = output?.code ? `${output.code}: ` : '';
      throw new Error(`Qwen Filetrans task failed: ${code}${output?.message || raw}`);
    }

    if (!['PENDING', 'RUNNING', ''].includes(status)) {
      throw new Error(`Qwen Filetrans task returned unexpected status "${status}": ${raw}`);
    }

    await sleep(QWEN_FILETRANS_POLL_INTERVAL_MS);
  }

  throw new Error(`Qwen Filetrans task timed out after ${Math.round(timeoutMs / 1000)}s`);
}

async function fetchQwenFiletransResult(transcriptionUrl) {
  const response = await fetch(transcriptionUrl, {
    method: 'GET',
    headers: {
      Accept: 'application/json'
    }
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Qwen Filetrans result download failed (${response.status}): ${raw}`);
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Unexpected Qwen Filetrans result payload: ${raw}`);
  }
}

function parseQwenFiletransResult(payload, fallbackLanguage) {
  const transcripts = Array.isArray(payload?.transcripts) ? payload.transcripts : [];
  const text = transcripts
    .map((transcript) => String(transcript?.text || '').trim())
    .filter(Boolean)
    .join('\n');

  const words = [];
  let duration = 0;
  let detectedLanguage = '';

  for (const transcript of transcripts) {
    const sentences = Array.isArray(transcript?.sentences) ? transcript.sentences : [];
    for (const sentence of sentences) {
      const beginTime = Number(sentence?.begin_time || 0) / 1000;
      const endTime = Number(sentence?.end_time || sentence?.begin_time || 0) / 1000;
      duration = Math.max(duration, endTime);
      if (!detectedLanguage && sentence?.language) {
        detectedLanguage = String(sentence.language);
      }

      const sentenceWords = Array.isArray(sentence?.words) ? sentence.words : [];
      if (sentenceWords.length) {
        for (const word of sentenceWords) {
          const token = `${String(word?.text || '')}${String(word?.punctuation || '')}`;
          if (!token) continue;
          const start = Number(word?.begin_time || 0) / 1000;
          const end = Number(word?.end_time || word?.begin_time || 0) / 1000;
          duration = Math.max(duration, end);
          words.push({
            text: token,
            start_time: start,
            end_time: Math.max(start, end)
          });
        }
        continue;
      }

      if (sentence?.text) {
        words.push({
          text: String(sentence.text),
          start_time: beginTime,
          end_time: Math.max(beginTime, endTime)
        });
      }
    }
  }

  words.sort((left, right) => {
    if (left.start_time !== right.start_time) return left.start_time - right.start_time;
    if (left.end_time !== right.end_time) return left.end_time - right.end_time;
    return String(left.text || '').localeCompare(String(right.text || ''));
  });

  return {
    language: detectedLanguage || fallbackLanguage || 'Chinese',
    text,
    duration,
    words
  };
}

function isHttpUrl(value) {
  const normalized = String(value || '').trim();
  return /^https?:\/\//i.test(normalized);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeDeepgramLanguage(language) {
  const normalized = String(language || '').trim();
  if (!normalized) return '';

  const lower = normalized.toLowerCase();
  const aliasMap = new Map([
    ['chinese', 'zh'],
    ['mandarin', 'zh'],
    ['zh', 'zh'],
    ['zh-cn', 'zh'],
    ['zh-hans', 'zh'],
    ['english', 'en'],
    ['en', 'en'],
    ['en-us', 'en-US'],
    ['en-gb', 'en-GB'],
    ['japanese', 'ja'],
    ['ja', 'ja'],
    ['korean', 'ko'],
    ['ko', 'ko'],
    ['french', 'fr'],
    ['fr', 'fr'],
    ['german', 'de'],
    ['de', 'de'],
    ['spanish', 'es'],
    ['es', 'es'],
    ['portuguese', 'pt'],
    ['pt', 'pt'],
    ['russian', 'ru'],
    ['ru', 'ru'],
    ['arabic', 'ar'],
    ['ar', 'ar'],
    ['hindi', 'hi'],
    ['hi', 'hi'],
    ['indonesian', 'id'],
    ['id', 'id'],
    ['italian', 'it'],
    ['it', 'it'],
    ['thai', 'th'],
    ['th', 'th'],
    ['turkish', 'tr'],
    ['tr', 'tr'],
    ['vietnamese', 'vi'],
    ['vi', 'vi'],
    ['cantonese', 'zh-HK'],
    ['zh-hk', 'zh-HK']
  ]);

  if (aliasMap.has(lower)) {
    return aliasMap.get(lower);
  }

  if (/^[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(normalized)) {
    return normalized;
  }

  return '';
}

function inferAudioMimeType(filePath) {
  const extension = path.extname(String(filePath || '')).toLowerCase();
  const mimeTypes = {
    '.aac': 'audio/aac',
    '.aiff': 'audio/aiff',
    '.amr': 'audio/amr',
    '.avi': 'video/x-msvideo',
    '.flac': 'audio/flac',
    '.flv': 'video/x-flv',
    '.m4a': 'audio/mp4',
    '.m4v': 'video/x-m4v',
    '.mkv': 'video/x-matroska',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.mpeg': 'video/mpeg',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/opus',
    '.ts': 'video/mp2t',
    '.wav': 'audio/wav',
    '.webm': 'video/webm',
    '.wma': 'audio/x-ms-wma',
    '.wmv': 'video/x-ms-wmv'
  };

  return mimeTypes[extension] || 'application/octet-stream';
}

function parseDeepgramAsrResponse(payload, fallbackLanguage) {
  const alternatives = payload?.results?.channels?.[0]?.alternatives;
  const bestAlternative = Array.isArray(alternatives) ? alternatives[0] : null;
  const transcript = String(bestAlternative?.transcript || '').trim();
  const words = Array.isArray(bestAlternative?.words) ? bestAlternative.words : [];
  const restoredWords = restoreTranscriptPunctuation(words, transcript);
  const detectedLanguage =
    payload?.results?.channels?.[0]?.detected_language
    || payload?.results?.channels?.[0]?.language
    || fallbackLanguage
    || '';

  return {
    language: detectedLanguage,
    text: transcript,
    words: restoredWords.map((word) => ({
      text: word.text,
      start_time: Number(word.start || 0),
      end_time: Number(word.end || 0)
    }))
  };
}

function restoreTranscriptPunctuation(words, transcript) {
  if (!Array.isArray(words) || !words.length || !transcript) {
    return Array.isArray(words)
      ? words.map((word) => ({
          text: String(word.word || word.punctuated_word || ''),
          start: Number(word.start || 0),
          end: Number(word.end || 0)
        }))
      : [];
  }

  const restored = words.map((word) => ({
    text: String(word.word || word.punctuated_word || ''),
    start: Number(word.start || 0),
    end: Number(word.end || 0)
  }));

  let position = 0;
  for (let index = 0; index < restored.length; index += 1) {
    const expected = restored[index].text;
    const remaining = transcript.slice(position);
    const matchIndex = remaining.indexOf(expected);

    if (matchIndex < 0) {
      continue;
    }

    if (index > 0) {
      for (const char of remaining.slice(0, matchIndex)) {
        if (PUNCTUATION_CHARS.has(char)) {
          restored[index - 1].text += char;
        }
      }
    }

    position += matchIndex + expected.length;

    while (position < transcript.length && PUNCTUATION_CHARS.has(transcript[position])) {
      restored[index].text += transcript[position];
      position += 1;
    }
  }

  return restored;
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
