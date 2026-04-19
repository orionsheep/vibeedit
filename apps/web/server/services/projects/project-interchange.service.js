import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { execFileSync } from 'child_process';
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
const DEFAULT_START_TIMECODE_SECONDS = 3600;

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

function normalizePathUrl(sourcePath, overridePathOrUrl = '') {
  const value = String(overridePathOrUrl || '').trim();
  if (!value) {
    return buildPathUrl(sourcePath);
  }
  if (/^[a-z]+:\/\//i.test(value)) {
    return value;
  }
  return buildPathUrl(value);
}

function normalizeSequenceName(value) {
  return String(value || '').trim() || 'AutoEdit Timeline';
}

async function probeMediaInfo(sourcePath, { pathurl = '' } = {}) {
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
        pathurl: normalizePathUrl(sourcePath, pathurl),
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

function readTimelineKind(timeline = null) {
  if (timeline?.isPrimary) return 'master';
  const settings = timeline?.settings;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return 'aux';
  return String(settings.kind || 'aux').trim() || 'aux';
}

function selectTimelineForInterchange(project, timelineId = '') {
  const requestedTimelineId = String(timelineId || '').trim();
  const timelines = Array.isArray(project?.timelines) ? project.timelines : [];
  if (requestedTimelineId) {
    const requested = timelines.find((timeline) => timeline.id === requestedTimelineId);
    if (!requested) {
      throw new Error('Requested timeline not found');
    }
    return requested;
  }
  return timelines.find((timeline) => timeline.isPrimary) || timelines[0] || null;
}

async function loadProjectInterchangeData(projectId, timelineId = '') {
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
          where: timelineId
            ? { id: String(timelineId || '').trim() }
            : undefined,
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

    const timeline = selectTimelineForInterchange(project, timelineId);
    if (!timeline) {
      throw new Error('Project timeline is empty');
    }

    return project;
  });
}

export async function collectSourceInfoByAssetId(clips = [], { pathurlResolver = null } = {}) {
  const sourceInfoByAssetId = new Map();

  for (const clip of clips) {
    if (sourceInfoByAssetId.has(clip.assetId)) continue;
    const sourcePath = clip.asset.files?.find((file) => file.role === 'original')?.uri;
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      throw new Error(`Original file missing for asset ${clip.assetId}`);
    }
    const pathurl = typeof pathurlResolver === 'function'
      ? pathurlResolver({ assetId: clip.assetId, sourcePath, clip })
      : '';
    sourceInfoByAssetId.set(clip.assetId, await probeMediaInfo(sourcePath, { pathurl }));
  }

  return sourceInfoByAssetId;
}

function determineSequenceInfo(clips = [], sourceInfoByAssetId = new Map()) {
  const firstInfo = clips
    .map((clip) => sourceInfoByAssetId.get(clip.assetId))
    .find(Boolean);

  if (!firstInfo) {
    return {
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
      audioRate: DEFAULT_AUDIO_RATE,
      audioChannels: DEFAULT_AUDIO_CHANNELS,
      rate: normalizeRate(DEFAULT_FPS)
    };
  }

  const durationByRateKey = new Map();
  for (const clip of clips) {
    const info = sourceInfoByAssetId.get(clip.assetId);
    if (!info?.rate?.timebase) continue;
    const key = `${info.rate.timebase}:${info.rate.ntsc ? 'TRUE' : 'FALSE'}`;
    const durationSeconds = Math.max(0.001, Number(clip.sourceEndSeconds || 0) - Number(clip.sourceStartSeconds || 0));
    const bucket = durationByRateKey.get(key) || { duration: 0, rate: info.rate };
    bucket.duration += durationSeconds;
    durationByRateKey.set(key, bucket);
  }

  const dominantRate = [...durationByRateKey.values()]
    .sort((left, right) => right.duration - left.duration)[0]?.rate || firstInfo.rate;

  const firstAudioInfo = clips
    .map((clip) => sourceInfoByAssetId.get(clip.assetId))
    .find((info) => info?.hasAudio) || firstInfo;

  return {
    width: firstInfo.width || DEFAULT_WIDTH,
    height: firstInfo.height || DEFAULT_HEIGHT,
    audioRate: firstAudioInfo.audioRate || DEFAULT_AUDIO_RATE,
    audioChannels: firstAudioInfo.audioChannels || DEFAULT_AUDIO_CHANNELS,
    rate: dominantRate || normalizeRate(DEFAULT_FPS)
  };
}

function buildProjectTimelineSegments(
  clips = [],
  sourceInfoByAssetId = new Map(),
  { sequenceRate = normalizeRate(DEFAULT_FPS), recordStartFrames = 0 } = {}
) {
  let recordCursor = Math.max(0, Math.round(recordStartFrames || 0));

  return clips.map((clip, index) => {
    const info = sourceInfoByAssetId.get(clip.assetId);
    const sourceRate = info?.rate || normalizeRate(DEFAULT_FPS);
    const sourceInFrames = secondsToFrames(clip.sourceStartSeconds, sourceRate.timebase);
    const sourceOutFrames = secondsToFrames(clip.sourceEndSeconds, sourceRate.timebase);
    const clipDurationSeconds = Math.max(0.001, Number(clip.sourceEndSeconds || 0) - Number(clip.sourceStartSeconds || 0));
    const recordDurationFrames = Math.max(1, secondsToFrames(clipDurationSeconds, sequenceRate.timebase));
    const recordInFrames = recordCursor;
    const recordOutFrames = recordInFrames + recordDurationFrames;
    recordCursor = recordOutFrames;

    return {
      index,
      clipIndex: index + 1,
      recordInFrames,
      recordOutFrames,
      sourceInFrames,
      sourceOutFrames,
      recordDurationFrames,
      sourceDurationFrames: info?.durationFrames || Math.max(1, sourceOutFrames),
      clip,
      info
    };
  });
}

export function buildPremiereXml({ project, clips, sourceInfoByAssetId }) {
  const sequenceInfo = determineSequenceInfo(clips, sourceInfoByAssetId);
  const sequenceRate = sequenceInfo.rate;
  const segments = buildProjectTimelineSegments(clips, sourceInfoByAssetId, {
    sequenceRate,
    recordStartFrames: 0
  });
  const safeName = normalizeSequenceName(project.name);
  const sequenceDurationFrames = segments.length
    ? segments[segments.length - 1].recordOutFrames
    : 0;
  const timecodeStartFrames = DEFAULT_START_TIMECODE_SECONDS * sequenceRate.timebase;
  const fileIds = new Map();
  const emittedFileDefinitions = new Set();

  const buildFileReferenceXml = (assetId, info) => {
    const fileId = fileIds.get(assetId) || `file-${assetId}`;
    fileIds.set(assetId, fileId);
    if (emittedFileDefinitions.has(assetId)) {
      return `<file id="${fileId}"/>`;
    }
    emittedFileDefinitions.add(assetId);
    return `<file id="${fileId}">
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
            </file>`;
  };

  const videoClipItems = segments.map((segment) => {
    const assetId = segment.clip.assetId;
    const info = segment.info;
    const videoClipItemId = `clipitem-v-${segment.clipIndex}`;
    const audioClipItemId = `clipitem-a-${segment.clipIndex}`;
    return `
          <clipitem id="${videoClipItemId}">
            <name>${xmlEscape(segment.clip.label || segment.clip.asset.title)}</name>
            <duration>${segment.sourceDurationFrames}</duration>
            <rate>
              <timebase>${info.rate.timebase}</timebase>
              <ntsc>${info.rate.ntsc ? 'TRUE' : 'FALSE'}</ntsc>
            </rate>
            <start>${segment.recordInFrames}</start>
            <end>${segment.recordOutFrames}</end>
            <in>${segment.sourceInFrames}</in>
            <out>${segment.sourceOutFrames}</out>
            <enabled>TRUE</enabled>
            ${buildFileReferenceXml(assetId, info)}
            <sourcetrack>
              <mediatype>video</mediatype>
              <trackindex>1</trackindex>
            </sourcetrack>
            <link>
              <linkclipref>${videoClipItemId}</linkclipref>
              <mediatype>video</mediatype>
              <trackindex>1</trackindex>
              <clipindex>${segment.clipIndex}</clipindex>
            </link>${info.hasAudio ? `
            <link>
              <linkclipref>${audioClipItemId}</linkclipref>
              <mediatype>audio</mediatype>
              <trackindex>1</trackindex>
              <clipindex>${segment.clipIndex}</clipindex>
            </link>` : ''}
          </clipitem>`;
  }).join('');

  const audioClipItems = segments
    .filter((segment) => segment.info?.hasAudio)
    .map((segment) => {
      const assetId = segment.clip.assetId;
      const info = segment.info;
      const fileId = fileIds.get(assetId) || `file-${assetId}`;
      const videoClipItemId = `clipitem-v-${segment.clipIndex}`;
      const audioClipItemId = `clipitem-a-${segment.clipIndex}`;
      return `
          <clipitem id="${audioClipItemId}">
            <name>${xmlEscape(segment.clip.label || segment.clip.asset.title)}</name>
            <duration>${segment.sourceDurationFrames}</duration>
            <rate>
              <timebase>${info.rate.timebase}</timebase>
              <ntsc>${info.rate.ntsc ? 'TRUE' : 'FALSE'}</ntsc>
            </rate>
            <start>${segment.recordInFrames}</start>
            <end>${segment.recordOutFrames}</end>
            <in>${segment.sourceInFrames}</in>
            <out>${segment.sourceOutFrames}</out>
            <enabled>TRUE</enabled>
            <file id="${fileId}"/>
            <sourcetrack>
              <mediatype>audio</mediatype>
              <trackindex>1</trackindex>
            </sourcetrack>
            <link>
              <linkclipref>${videoClipItemId}</linkclipref>
              <mediatype>video</mediatype>
              <trackindex>1</trackindex>
              <clipindex>${segment.clipIndex}</clipindex>
            </link>
            <link>
              <linkclipref>${audioClipItemId}</linkclipref>
              <mediatype>audio</mediatype>
              <trackindex>1</trackindex>
              <clipindex>${segment.clipIndex}</clipindex>
            </link>
          </clipitem>`;
    }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="5">
  <sequence id="sequence-1">
    <name>${xmlEscape(safeName)}</name>
    <duration>${sequenceDurationFrames}</duration>
    <rate>
      <timebase>${sequenceRate.timebase}</timebase>
      <ntsc>${sequenceRate.ntsc ? 'TRUE' : 'FALSE'}</ntsc>
    </rate>
    <timecode>
      <rate>
        <timebase>${sequenceRate.timebase}</timebase>
        <ntsc>${sequenceRate.ntsc ? 'TRUE' : 'FALSE'}</ntsc>
      </rate>
      <string>${formatTimecodeFromFrames(timecodeStartFrames, sequenceRate.timebase)}</string>
      <frame>${timecodeStartFrames}</frame>
      <displayformat>${sequenceRate.ntsc ? 'DF' : 'NDF'}</displayformat>
    </timecode>
    <media>
      <video>
        <format>
          <samplecharacteristics>
            <width>${sequenceInfo.width}</width>
            <height>${sequenceInfo.height}</height>
            <anamorphic>FALSE</anamorphic>
            <pixelaspectratio>square</pixelaspectratio>
            <fielddominance>none</fielddominance>
          </samplecharacteristics>
        </format>
        <track>${videoClipItems}
        </track>
      </video>${audioClipItems ? `
      <audio>
        <numOutputChannels>${sequenceInfo.audioChannels}</numOutputChannels>
        <format>
          <samplecharacteristics>
            <depth>16</depth>
            <samplerate>${sequenceInfo.audioRate}</samplerate>
          </samplecharacteristics>
        </format>
        <track>${audioClipItems}
        </track>
      </audio>` : ''}
    </media>
  </sequence>
</xmeml>`;
}

export function buildEdl({ project, clips, sourceInfoByAssetId }) {
  const sequenceInfo = determineSequenceInfo(clips, sourceInfoByAssetId);
  const sequenceRate = sequenceInfo.rate;
  const programStartFrames = DEFAULT_START_TIMECODE_SECONDS * sequenceRate.timebase;
  const segments = buildProjectTimelineSegments(clips, sourceInfoByAssetId, {
    sequenceRate,
    recordStartFrames: programStartFrames
  });
  const title = sanitizeFilename(project.name, 'autoedit').slice(0, 32).toUpperCase();
  const lines = [
    `TITLE: ${title}`,
    `FCM: ${sequenceRate.ntsc ? 'DROP FRAME' : 'NON-DROP FRAME'}`
  ];

  for (const segment of segments) {
    const clip = segment.clip;
    const info = segment.info;
    const reel = sanitizeFilename(path.basename(info.basename, path.extname(info.basename)), 'AX').slice(0, 8).toUpperCase();
    lines.push(
      `${String(segment.clipIndex).padStart(3, '0')}  ${reel.padEnd(8, ' ')} V     C        ${formatTimecodeFromFrames(segment.sourceInFrames, info.rate.timebase)} ${formatTimecodeFromFrames(segment.sourceOutFrames, info.rate.timebase)} ${formatTimecodeFromFrames(segment.recordInFrames, sequenceRate.timebase)} ${formatTimecodeFromFrames(segment.recordOutFrames, sequenceRate.timebase)}`,
      `* FROM CLIP NAME: ${clip.label || clip.asset.title}`
    );
  }

  return `${lines.join('\n')}\n`;
}

function buildEditedWords(sourceState = {}) {
  return buildEditedWordsForRanges(sourceState);
}

function normalizeProjectRanges(ranges = []) {
  return (Array.isArray(ranges) ? ranges : [])
    .map((range) => ({
      start: roundTime(Number(range?.start ?? range?.timeline_start ?? range?.original_project_start ?? 0)),
      end: roundTime(Number(range?.end ?? range?.timeline_end ?? range?.original_project_end ?? 0))
    }))
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end - range.start > 0.05)
    .sort((left, right) => left.start - right.start);
}

export function buildTimelineProjectRanges(clips = []) {
  return normalizeProjectRanges((Array.isArray(clips) ? clips : []).map((clip) => ({
    start: Number(clip.metadata?.original_project_start ?? clip.metadata?.originalProjectStart ?? clip.timelineStartSeconds ?? clip.timeline_start ?? 0),
    end: Number(clip.metadata?.original_project_end ?? clip.metadata?.originalProjectEnd ?? clip.timelineEndSeconds ?? clip.timeline_end ?? 0)
  })));
}

function buildEditedWordsForRanges(sourceState = {}, ranges = null) {
  const deletedWordKeys = new Set(sourceState.deleted_word_keys || []);
  const deletedGapKeys = new Set(sourceState.deleted_gap_keys || []);
  const words = Array.isArray(sourceState.words) ? sourceState.words : [];
  const selectedRanges = normalizeProjectRanges(ranges);
  const hasRangeFilter = selectedRanges.length > 0;
  const kept = [];
  let cursor = 0;

  const getRangeIndexForWord = (word) => {
    if (!hasRangeFilter) return 0;
    return selectedRanges.findIndex((range) => (
      Number(word.start_time || 0) < range.end &&
      Number(word.end_time || word.start_time || 0) > range.start
    ));
  };

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (deletedWordKeys.has(word.word_key)) continue;
    const currentRangeIndex = getRangeIndexForWord(word);
    if (hasRangeFilter && currentRangeIndex === -1) continue;

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
    const nextRangeIndex = getRangeIndexForWord(nextWord);
    if (hasRangeFilter && nextRangeIndex === -1) {
      continue;
    }
    if (hasRangeFilter && nextRangeIndex !== currentRangeIndex) {
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

export function buildCapCutSrt(sourceState = {}, ranges = null) {
  const words = buildEditedWordsForRanges(sourceState, ranges);
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

export function buildProjectInterchangeArtifacts({
  project,
  clips,
  sourceInfoByAssetId,
  sourceState = null
}) {
  const ranges = buildTimelineProjectRanges(clips);
  return {
    premiereXml: buildPremiereXml({ project, clips, sourceInfoByAssetId }),
    edl: buildEdl({ project, clips, sourceInfoByAssetId }),
    capcutSrt: sourceState ? buildCapCutSrt(sourceState, ranges) : ''
  };
}

export async function exportProjectInterchangeFile(projectId, format = 'premiere_xml', { timelineId = '' } = {}) {
  const config = PROJECT_INTERCHANGE_FORMATS[format];
  if (!config) {
    throw new Error(`Unsupported project export format: ${format}`);
  }

  const job = await createJob({
    type: 'export.interchange',
    payload: { projectId, format, timelineId },
    projectId,
    message: `Queued ${config.label} export`
  });

  try {
    await markJobRunning(job.id, `Preparing ${config.label}`);
    const project = await loadProjectInterchangeData(projectId, timelineId);
    const timeline = selectTimelineForInterchange(project, timelineId);
    if (!timeline || !timeline.clips.length) {
      throw new Error('Project timeline is empty');
    }

    const { exportsDir } = ensureStorageDirs();
    const outputId = uuidv4().substring(0, 8);
    const baseName = readTimelineKind(timeline) === 'slice'
      ? `${project.name}_${timeline.settings?.title || timeline.name}`
      : project.name;
    const filename = `${sanitizeFilename(baseName)}_${outputId}.${config.extension}`;
    const outputPath = path.join(exportsDir, filename);

    let content = '';
    if (format === 'capcut_srt') {
      const sourceState = await loadProjectEditSource(projectId);
      content = buildCapCutSrt(sourceState, buildTimelineProjectRanges(timeline.clips));
    } else {
      const sourceInfoByAssetId = await collectSourceInfoByAssetId(timeline.clips);
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

export async function exportProjectSliceXmlBundle(projectId) {
  const job = await createJob({
    type: 'export.interchange_bundle',
    payload: { projectId, format: 'premiere_xml', scope: 'all_slices' },
    projectId,
    message: 'Queued live slice XML bundle export'
  });

  try {
    await markJobRunning(job.id, 'Preparing live slice XML bundle');
    const project = await loadProjectInterchangeData(projectId);
    const sliceTimelines = (project.timelines || [])
      .filter((timeline) => readTimelineKind(timeline) === 'slice' && Array.isArray(timeline.clips) && timeline.clips.length);

    if (!sliceTimelines.length) {
      throw new Error('No slice timelines available for XML bundle export');
    }

    const { packagesDir } = ensureStorageDirs();
    const bundleId = uuidv4().substring(0, 8);
    const bundleBaseName = `${sanitizeFilename(project.name)}_slice_xml_bundle_${bundleId}`;
    const bundleDir = path.join(packagesDir, bundleBaseName);
    await fs.promises.mkdir(bundleDir, { recursive: true });

    const manifest = {
      project_id: project.id,
      project_name: project.name,
      exported_at: new Date().toISOString(),
      format: 'premiere_xml',
      slice_count: sliceTimelines.length,
      files: []
    };

    for (let index = 0; index < sliceTimelines.length; index += 1) {
      const timeline = sliceTimelines[index];
      const sliceTitle = String(timeline.settings?.title || timeline.name || `切片 ${index + 1}`).trim() || `切片 ${index + 1}`;
      const ordinal = String(index + 1).padStart(2, '0');
      const filename = `${ordinal}_${sanitizeFilename(sliceTitle, `slice_${ordinal}`)}.xml`;
      const outputPath = path.join(bundleDir, filename);
      const sourceInfoByAssetId = await collectSourceInfoByAssetId(timeline.clips);
      const content = buildPremiereXml({
        project: {
          ...project,
          name: `${project.name} · ${sliceTitle}`
        },
        clips: timeline.clips,
        sourceInfoByAssetId
      });

      await fs.promises.writeFile(outputPath, content, 'utf-8');

      const durationSeconds = timeline.clips.reduce((sum, clip) => (
        sum + Math.max(0, Number(clip.sourceEndSeconds || 0) - Number(clip.sourceStartSeconds || 0))
      ), 0);

      manifest.files.push({
        timeline_id: timeline.id,
        title: sliceTitle,
        filename,
        duration_seconds: roundTime(durationSeconds)
      });

      await markJobRunning(job.id, `Bundled ${index + 1}/${sliceTimelines.length} slice XML files`);
    }

    await fs.promises.writeFile(
      path.join(bundleDir, '_manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8'
    );

    const zipPath = `${bundleDir}.zip`;
    execFileSync('zip', ['-r', zipPath, '.'], { cwd: bundleDir });

    await completeJob(job.id, {
      bundleDir,
      zipPath,
      fileCount: manifest.files.length
    }, 'Live slice XML bundle export completed');

    return {
      success: true,
      bundleDir,
      zipPath,
      fileCount: manifest.files.length
    };
  } catch (error) {
    await failJob(job.id, error);
    throw error;
  }
}
