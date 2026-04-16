import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { pathToFileURL } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { ensureStorageDirs } from '../editor/config.js';
import { withDatabase } from '../core/database.service.js';
import { completeJob, createJob, failJob, markJobRunning } from '../core/job.service.js';
import { ensureProjectEditStateConsistency, loadProjectEditSource } from './project-edit-state.service.js';

const DEFAULT_FPS = 30;
const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const DEFAULT_AUDIO_RATE = 48000;
const DEFAULT_AUDIO_CHANNELS = 2;
const DEFAULT_START_TIMECODE_FRAMES = 3600;

export const PROJECT_INTERCHANGE_FORMATS = {
  premiere_xml: {
    extension: 'xml',
    label: 'Premiere / Resolve XML',
    mimeType: 'application/xml',
    note: 'Premiere Pro / DaVinci Resolve 可直接导入。After Effects 建议先导入 Premiere，再从 AE 导入 Premiere 项目。'
  },
  edl: {
    extension: 'edl',
    label: '通用 EDL',
    mimeType: 'text/plain',
    note: 'EDL 适合做通用粗剪交换，结构最稳，但比 XML 丢失更多轨道和细节信息。'
  },
  capcut_srt: {
    extension: 'srt',
    label: '剪映 / CapCut SRT',
    mimeType: 'application/x-subrip',
    note: '剪映 / CapCut 当前更稳的是字幕导入链路；请将导出的最终视频与该 SRT 一起导入。'
  }
};

function roundTime(value, digits = 3) {
  return Number(Number(value || 0).toFixed(digits));
}

function sanitizeFilename(value, fallback = 'autoedit-project') {
  const safe = String(value || '')
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return safe || fallback;
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function parseFrameRate(rawValue) {
  if (!rawValue) {
    return DEFAULT_FPS;
  }

  if (typeof rawValue === 'number') {
    return rawValue > 0 ? rawValue : DEFAULT_FPS;
  }

  if (typeof rawValue === 'string' && rawValue.includes('/')) {
    const [num, den] = rawValue.split('/').map(Number);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
      return num / den;
    }
  }

  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_FPS;
}

function normalizeRate(rawFps) {
  const ntsc =
    Math.abs(rawFps - 23.976) < 0.02 ||
    Math.abs(rawFps - 29.97) < 0.02 ||
    Math.abs(rawFps - 59.94) < 0.05;

  let timebase = Math.round(rawFps);
  if (!Number.isFinite(timebase) || timebase <= 0) {
    timebase = DEFAULT_FPS;
  }

  return {
    fps: rawFps || DEFAULT_FPS,
    timebase,
    ntsc
  };
}

function secondsToFrames(seconds, fps) {
  return Math.max(0, Math.round(Number(seconds || 0) * fps));
}

function formatTimecodeFromFrames(totalFrames, fps) {
  const safeFps = Math.max(1, Math.round(fps || DEFAULT_FPS));
  let frames = Math.max(0, Math.round(totalFrames || 0));

  const frame = frames % safeFps;
  frames = Math.floor(frames / safeFps);
  const seconds = frames % 60;
  frames = Math.floor(frames / 60);
  const minutes = frames % 60;
  const hours = Math.floor(frames / 60);

  return [hours, minutes, seconds, frame]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

function formatSrtTime(seconds) {
  const totalMs = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);

  return `${[h, m, s].map((value) => String(value).padStart(2, '0')).join(':')},${String(ms).padStart(3, '0')}`;
}

function buildPathUrl(sourcePath) {
  const url = pathToFileURL(sourcePath).href;
  if (url.startsWith('file:///')) {
    return url.replace('file:///', 'file://localhost/');
  }
  return url;
}

function normalizeSequenceName(value) {
  return String(value || '').trim() || 'AutoEdit Timeline';
}

async function probeMediaInfo(sourcePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(sourcePath, (error, metadata) => {
      if (error) {
        reject(error);
        return;
      }

      const videoStream = metadata?.streams?.find((stream) => stream.codec_type === 'video') || {};
      const audioStream = metadata?.streams?.find((stream) => stream.codec_type === 'audio') || {};
      const rate = normalizeRate(parseFrameRate(videoStream.avg_frame_rate || videoStream.r_frame_rate));
      const duration =
        Number(videoStream.duration) ||
        Number(audioStream.duration) ||
        Number(metadata?.format?.duration) ||
        0;

      resolve({
        basename: path.basename(sourcePath),
        pathurl: buildPathUrl(sourcePath),
        width: Number(videoStream.width) || DEFAULT_WIDTH,
        height: Number(videoStream.height) || DEFAULT_HEIGHT,
        hasAudio: Boolean(audioStream.codec_type === 'audio'),
        audioRate: Number(audioStream.sample_rate) || DEFAULT_AUDIO_RATE,
        audioChannels: Number(audioStream.channels) || DEFAULT_AUDIO_CHANNELS,
        durationSeconds: duration,
        durationFrames: Math.max(1, secondsToFrames(duration, rate.timebase)),
        rate
      });
    });
  });
}

async function loadProjectInterchangeData(projectId) {
  await ensureProjectEditStateConsistency(projectId);
  return withDatabase(async (db) => {
    const project = await db.project.findUnique({
      where: { id: projectId },
      include: {
        category: true,
        projectAssets: {
          orderBy: { sortOrder: 'asc' },
          include: {
            asset: {
              include: {
                files: true,
                captions: {
                  orderBy: { createdAt: 'desc' },
                  take: 1
                }
              }
            }
          }
        },
        timelines: {
          where: { isPrimary: true },
          include: {
            clips: {
              orderBy: { sortOrder: 'asc' },
              include: {
                asset: {
                  include: {
                    files: true,
                    captions: {
                      orderBy: { createdAt: 'desc' },
                      take: 1
                    }
                  }
                }
              }
            }
          }
        }
      }
    });

    if (!project) {
      throw new Error('Project not found');
    }

    return project;
  });
}

function buildProjectTimelineSegments(clips = [], sourceInfoByAssetId = new Map()) {
  let recordCursor = DEFAULT_START_TIMECODE_FRAMES * DEFAULT_FPS;

  return clips.map((clip, index) => {
    const info = sourceInfoByAssetId.get(clip.assetId);
    const fps = info?.rate?.timebase || DEFAULT_FPS;
    const sourceInFrames = secondsToFrames(clip.sourceStartSeconds, fps);
    const sourceOutFrames = secondsToFrames(clip.sourceEndSeconds, fps);
    const durationFrames = Math.max(1, sourceOutFrames - sourceInFrames);
    const recordInFrames = recordCursor;
    const recordOutFrames = recordInFrames + durationFrames;
    recordCursor = recordOutFrames;

    return {
      index,
      clipIndex: index + 1,
      recordInFrames,
      recordOutFrames,
      sourceInFrames,
      sourceOutFrames,
      durationFrames,
      clip,
      info
    };
  });
}

function buildPremiereXml({ project, clips, sourceInfoByAssetId }) {
  const segments = buildProjectTimelineSegments(clips, sourceInfoByAssetId);
  const safeName = normalizeSequenceName(project.name);
  const sequenceDurationFrames = segments.length
    ? segments[segments.length - 1].recordOutFrames - segments[0].recordInFrames
    : 0;

  const fileDefinitions = [];
  const fileIds = new Map();

  for (const relation of project.projectAssets || []) {
    const assetId = relation.assetId;
    const originalPath = relation.asset.files?.find((file) => file.role === 'original')?.uri;
    if (!originalPath) continue;
    const info = sourceInfoByAssetId.get(assetId);
    if (!info) continue;
    const fileId = `file-${assetId}`;
    fileIds.set(assetId, fileId);
    fileDefinitions.push(`
            <file id="${fileId}">
              <name>${xmlEscape(info.basename)}</name>
              <pathurl>${xmlEscape(info.pathurl)}</pathurl>
              <rate>
                <timebase>${info.rate.timebase}</timebase>
                <ntsc>${info.rate.ntsc ? 'TRUE' : 'FALSE'}</ntsc>
              </rate>
              <duration>${info.durationFrames}</duration>
              <media>
                <video>
                  <samplecharacteristics>
                    <width>${info.width}</width>
                    <height>${info.height}</height>
                    <anamorphic>FALSE</anamorphic>
                    <pixelaspectratio>square</pixelaspectratio>
                    <fielddominance>none</fielddominance>
                  </samplecharacteristics>
                </video>${info.hasAudio ? `
                <audio>
                  <samplecharacteristics>
                    <depth>16</depth>
                    <samplerate>${info.audioRate}</samplerate>
                  </samplecharacteristics>
                  <channelcount>${info.audioChannels}</channelcount>
                </audio>` : ''}
              </media>
            </file>`);
  }

  const clipItems = segments.map((segment) => {
    const assetId = segment.clip.assetId;
    const info = segment.info;
    const fileId = fileIds.get(assetId);
    return `
            <clipitem id="clipitem-${segment.clip.id}">
              <name>${xmlEscape(segment.clip.label || segment.clip.asset.title)}</name>
              <start>${segment.recordInFrames}</start>
              <end>${segment.recordOutFrames}</end>
              <in>${segment.sourceInFrames}</in>
              <out>${segment.sourceOutFrames}</out>
              <enabled>TRUE</enabled>
              <rate>
                <timebase>${info.rate.timebase}</timebase>
                <ntsc>${info.rate.ntsc ? 'TRUE' : 'FALSE'}</ntsc>
              </rate>
              <file id="${fileId}"/>
            </clipitem>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<xmeml version="5">
  <sequence id="sequence-1">
    <name>${xmlEscape(safeName)}</name>
    <duration>${sequenceDurationFrames}</duration>
    <rate>
      <timebase>${DEFAULT_FPS}</timebase>
      <ntsc>FALSE</ntsc>
    </rate>
    <media>
      <video>
        <track>${clipItems}
        </track>
      </video>
    </media>
    <resources>${fileDefinitions.join('')}
    </resources>
  </sequence>
</xmeml>`;
}

function buildEdl({ project, clips, sourceInfoByAssetId }) {
  const segments = buildProjectTimelineSegments(clips, sourceInfoByAssetId);
  const title = sanitizeFilename(project.name, 'autoedit').slice(0, 32).toUpperCase();
  const lines = [
    `TITLE: ${title}`,
    'FCM: NON-DROP FRAME'
  ];

  for (const segment of segments) {
    const clip = segment.clip;
    const info = segment.info;
    const reel = sanitizeFilename(path.basename(info.basename, path.extname(info.basename)), 'AX').slice(0, 8).toUpperCase();
    const fps = info.rate.timebase || DEFAULT_FPS;
    lines.push(
      `${String(segment.clipIndex).padStart(3, '0')}  ${reel.padEnd(8, ' ')} V     C        ${formatTimecodeFromFrames(segment.sourceInFrames, fps)} ${formatTimecodeFromFrames(segment.sourceOutFrames, fps)} ${formatTimecodeFromFrames(segment.recordInFrames, fps)} ${formatTimecodeFromFrames(segment.recordOutFrames, fps)}`,
      `* FROM CLIP NAME: ${clip.label || clip.asset.title}`
    );
  }

  return `${lines.join('\n')}\n`;
}

function buildEditedWords(sourceState = {}) {
  const deletedWordKeys = new Set(sourceState.deleted_word_keys || []);
  const deletedGapKeys = new Set(sourceState.deleted_gap_keys || []);
  const words = Array.isArray(sourceState.words) ? sourceState.words : [];
  const kept = [];
  let cursor = 0;

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (deletedWordKeys.has(word.word_key)) continue;

    const duration = Math.max(0.01, Number(word.source_end_time || 0) - Number(word.source_start_time || 0));
    const editedStart = roundTime(cursor);
    const editedEnd = roundTime(editedStart + duration);
    kept.push({
      ...word,
      edited_start: editedStart,
      edited_end: editedEnd
    });
    cursor = editedEnd;

    const nextWord = words[index + 1];
    if (!nextWord || nextWord.asset_id !== word.asset_id) {
      continue;
    }
    if (deletedWordKeys.has(nextWord.word_key)) {
      continue;
    }
    if (deletedGapKeys.has(word.gap_key_after)) {
      continue;
    }
    const naturalGap = Math.max(0, Number(nextWord.source_start_time || 0) - Number(word.source_end_time || 0));
    cursor = roundTime(cursor + naturalGap);
  }

  return kept;
}

function buildCapCutSrt(sourceState = {}) {
  const words = buildEditedWords(sourceState);
  if (!words.length) {
    throw new Error('No subtitle cues available for SRT export');
  }

  const cues = [];
  let current = null;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const prev = words[index - 1];
    const gap = prev ? Number(word.edited_start || 0) - Number(prev.edited_end || 0) : 0;
    if (!current) {
      current = {
        start: Number(word.edited_start || 0),
        end: Number(word.edited_end || 0),
        text: String(word.text || '')
      };
      continue;
    }

    if (gap > 0.75 || /[。！？!?]/.test(prev?.text || '')) {
      cues.push(current);
      current = {
        start: Number(word.edited_start || 0),
        end: Number(word.edited_end || 0),
        text: String(word.text || '')
      };
      continue;
    }

    current.end = Number(word.edited_end || current.end);
    current.text += String(word.text || '');
  }

  if (current) {
    cues.push(current);
  }

  return cues
    .filter((cue) => cue.text.trim())
    .map((cue, index) => `${index + 1}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(Math.max(cue.start + 0.2, cue.end))}\n${cue.text.trim()}\n`)
    .join('\n');
}

export async function exportProjectInterchangeFile(projectId, format = 'premiere_xml') {
  const config = PROJECT_INTERCHANGE_FORMATS[format];
  if (!config) {
    throw new Error(`Unsupported project export format: ${format}`);
  }

  const job = await createJob({
    type: 'export.interchange',
    payload: { projectId, format },
    projectId,
    message: `Queued ${config.label} export`
  });

  try {
    await markJobRunning(job.id, `Preparing ${config.label}`);
    const project = await loadProjectInterchangeData(projectId);
    const timeline = project.timelines[0];
    if (!timeline || !timeline.clips.length) {
      throw new Error('Project timeline is empty');
    }

    const { exportsDir } = ensureStorageDirs();
    const outputId = uuidv4().substring(0, 8);
    const filename = `${sanitizeFilename(project.name)}_${outputId}.${config.extension}`;
    const outputPath = path.join(exportsDir, filename);

    let content = '';
    if (format === 'capcut_srt') {
      const sourceState = await loadProjectEditSource(projectId);
      content = buildCapCutSrt(sourceState);
    } else {
      const sourceInfoByAssetId = new Map();
      for (const clip of timeline.clips) {
        if (sourceInfoByAssetId.has(clip.assetId)) continue;
        const sourcePath = clip.asset.files?.find((file) => file.role === 'original')?.uri;
        if (!sourcePath || !fs.existsSync(sourcePath)) {
          throw new Error(`Original file missing for asset ${clip.assetId}`);
        }
        sourceInfoByAssetId.set(clip.assetId, await probeMediaInfo(sourcePath));
      }

      content = format === 'edl'
        ? buildEdl({ project, clips: timeline.clips, sourceInfoByAssetId })
        : buildPremiereXml({ project, clips: timeline.clips, sourceInfoByAssetId });
    }

    await fs.promises.writeFile(outputPath, content, 'utf-8');
    await completeJob(job.id, { outputPath, format }, `${config.label} export completed`);
    return {
      success: true,
      outputPath,
      format,
      label: config.label,
      mimeType: config.mimeType,
      compatibilityNote: config.note
    };
  } catch (error) {
    await failJob(job.id, error);
    throw error;
  }
}
