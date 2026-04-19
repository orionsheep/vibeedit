import { withDatabase } from '../core/database.service.js';
import { loadProjectEditSource } from './project-edit-state.service.js';
import { normalizeTimelineSettings, readTimelineKind, roundTime } from '../shared/timeline-utils.js';

const DEFAULT_SLICE_COLORS = [
  '#4cc2ff',
  '#ff8a4c',
  '#7fe27f',
  '#ffd166',
  '#ff6b9a',
  '#9b8cff',
  '#5eead4',
  '#f97316'
];

function sanitizeSliceTitle(value, fallback = '未命名切片') {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized || fallback;
}

function readSliceSettings(timeline = null) {
  const settings = normalizeTimelineSettings(timeline?.settings);
  return {
    kind: readTimelineKind(timeline),
    title: sanitizeSliceTitle(settings.title || timeline?.name || ''),
    color: String(settings.color || '').trim() || null,
    description: String(settings.description || '').trim(),
    summary: String(settings.summary || '').trim(),
    query: String(settings.query || '').trim(),
    generated_by: String(settings.generatedBy || settings.generated_by || '').trim() || null,
    source_timeline_id: String(settings.sourceTimelineId || settings.source_timeline_id || '').trim() || null,
    target_duration_seconds: Number(settings.targetDurationSeconds || settings.target_duration_seconds || 0) || 0
  };
}

function pickSliceColor(index = 0) {
  return DEFAULT_SLICE_COLORS[index % DEFAULT_SLICE_COLORS.length];
}

function mapSliceTimeline(timeline) {
  const settings = readSliceSettings(timeline);
  const clips = (timeline?.clips || []).map((clip) => ({
    id: clip.id,
    asset_id: clip.assetId,
    asset_title: clip.asset?.title || '',
    label: clip.label || clip.asset?.title || '',
    source_start: clip.sourceStartSeconds,
    source_end: clip.sourceEndSeconds,
    timeline_start: clip.timelineStartSeconds,
    timeline_end: clip.timelineEndSeconds,
    sort_order: clip.sortOrder,
    asset_source_url: clip.asset ? `/api/library/assets/${clip.assetId}/source` : null,
    original_project_start: Number(clip.metadata?.original_project_start ?? clip.metadata?.originalProjectStart ?? clip.timelineStartSeconds),
    original_project_end: Number(clip.metadata?.original_project_end ?? clip.metadata?.originalProjectEnd ?? clip.timelineEndSeconds),
    slice_group_index: Number(clip.metadata?.slice_group_index ?? clip.metadata?.sliceGroupIndex ?? 0)
  }));

  return {
    id: timeline.id,
    project_id: timeline.projectId,
    name: timeline.name,
    title: settings.title,
    kind: settings.kind,
    color: settings.color || pickSliceColor(0),
    description: settings.description,
    summary: settings.summary,
    query: settings.query,
    generated_by: settings.generated_by,
    source_timeline_id: settings.source_timeline_id,
    target_duration_seconds: settings.target_duration_seconds,
    created_at: timeline.createdAt,
    updated_at: timeline.updatedAt,
    clip_count: clips.length,
    total_duration: clips.length ? Number(clips[clips.length - 1].timeline_end || 0) : 0,
    clips
  };
}

async function ensureTimelineTracks(db, timelineId) {
  const timeline = await db.timeline.findUnique({
    where: { id: timelineId },
    include: {
      tracks: { orderBy: { sortOrder: 'asc' } }
    }
  });
  if (!timeline) {
    throw new Error('Timeline not found');
  }
  if (timeline.tracks.length) {
    return timeline;
  }
  await db.timelineTrack.createMany({
    data: [
      { timelineId, kind: 'video', name: 'V1', sortOrder: 0 },
      { timelineId, kind: 'subtitle', name: 'S1', sortOrder: 1 }
    ]
  });
  return db.timeline.findUnique({
    where: { id: timelineId },
    include: {
      tracks: { orderBy: { sortOrder: 'asc' } }
    }
  });
}

async function loadPrimaryTimeline(db, projectId) {
  return db.timeline.findFirst({
    where: { projectId, isPrimary: true },
    include: {
      tracks: { orderBy: { sortOrder: 'asc' } },
      clips: {
        orderBy: { sortOrder: 'asc' },
        include: {
          asset: {
            include: { files: true }
          }
        }
      }
    }
  });
}

async function loadBaselineProjectClips(db, projectId) {
  const rows = await db.projectAsset.findMany({
    where: { projectId },
    orderBy: { sortOrder: 'asc' },
    include: {
      asset: {
        include: {
          files: true
        }
      }
    }
  });

  let cursor = 0;
  return rows.map((row, index) => {
    const duration = Math.max(0.05, Number(row.asset?.durationSeconds || 0));
    const clip = {
      id: `baseline_${row.assetId}_${index + 1}`,
      assetId: row.assetId,
      label: row.asset?.title || '',
      asset: row.asset,
      sourceStartSeconds: 0,
      sourceEndSeconds: duration,
      timelineStartSeconds: roundTime(cursor),
      timelineEndSeconds: roundTime(cursor + duration)
    };
    cursor += duration;
    return clip;
  });
}

async function loadSliceTimeline(db, projectId, timelineId) {
  const timeline = await db.timeline.findFirst({
    where: {
      id: timelineId,
      projectId
    },
    include: {
      tracks: { orderBy: { sortOrder: 'asc' } },
      clips: {
        orderBy: { sortOrder: 'asc' },
        include: {
          asset: {
            include: { files: true }
          }
        }
      }
    }
  });
  if (!timeline) {
    throw new Error('Slice timeline not found');
  }
  if (readTimelineKind(timeline) !== 'slice') {
    throw new Error('Timeline is not a slice');
  }
  return timeline;
}

function normalizeRanges(ranges = []) {
  return (Array.isArray(ranges) ? ranges : [])
    .map((range) => ({
      start: roundTime(Number(range?.start ?? range?.timeline_start ?? range?.original_project_start ?? 0)),
      end: roundTime(Number(range?.end ?? range?.timeline_end ?? range?.original_project_end ?? 0))
    }))
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end - range.start > 0.05)
    .sort((left, right) => left.start - right.start);
}

function buildSliceClipSpecs(primaryTimeline, ranges = []) {
  const baseClips = Array.isArray(primaryTimeline?.clips) && primaryTimeline.clips.length
    ? primaryTimeline.clips
    : (Array.isArray(primaryTimeline) ? primaryTimeline : []);
  const specs = [];
  let cursor = 0;

  for (let rangeIndex = 0; rangeIndex < ranges.length; rangeIndex += 1) {
    const range = ranges[rangeIndex];
    for (const clip of baseClips) {
      const clipStart = Number(clip.timelineStartSeconds || 0);
      const clipEnd = Number(clip.timelineEndSeconds || clipStart);
      const overlapStart = Math.max(range.start, clipStart);
      const overlapEnd = Math.min(range.end, clipEnd);
      if (overlapEnd - overlapStart <= 0.001) continue;

      const sourceStart = Number(clip.sourceStartSeconds || 0) + (overlapStart - clipStart);
      const sourceEnd = Number(clip.sourceStartSeconds || 0) + (overlapEnd - clipStart);
      const duration = Math.max(0.05, sourceEnd - sourceStart);

      specs.push({
        assetId: clip.assetId,
        label: clip.label || clip.asset?.title || null,
        sourceStartSeconds: roundTime(sourceStart),
        sourceEndSeconds: roundTime(sourceEnd),
        timelineStartSeconds: roundTime(cursor),
        timelineEndSeconds: roundTime(cursor + duration),
        sortOrder: specs.length + 1,
        metadata: {
          original_project_start: roundTime(overlapStart),
          original_project_end: roundTime(overlapEnd),
          master_clip_id: clip.id,
          slice_group_index: rangeIndex
        }
      });
      cursor += duration;
    }
  }

  return specs;
}

async function replaceSliceTimelineClips(db, timelineId, clipSpecs = []) {
  const timeline = await ensureTimelineTracks(db, timelineId);
  const videoTrack = timeline.tracks.find((track) => track.kind === 'video') || timeline.tracks[0];
  const existing = await db.timelineClip.findMany({
    where: {
      timelineId,
      trackId: videoTrack.id
    },
    orderBy: { sortOrder: 'asc' }
  });

  const overlap = Math.min(existing.length, clipSpecs.length);
  for (let index = 0; index < overlap; index += 1) {
    const current = existing[index];
    const next = clipSpecs[index];
    const changed =
      current.assetId !== next.assetId ||
      String(current.label || '') !== String(next.label || '') ||
      Math.abs(Number(current.sourceStartSeconds || 0) - Number(next.sourceStartSeconds || 0)) > 0.001 ||
      Math.abs(Number(current.sourceEndSeconds || 0) - Number(next.sourceEndSeconds || 0)) > 0.001 ||
      Math.abs(Number(current.timelineStartSeconds || 0) - Number(next.timelineStartSeconds || 0)) > 0.001 ||
      Math.abs(Number(current.timelineEndSeconds || 0) - Number(next.timelineEndSeconds || 0)) > 0.001 ||
      Number(current.sortOrder || 0) !== Number(next.sortOrder || 0) ||
      JSON.stringify(current.metadata || {}) !== JSON.stringify(next.metadata || {});

    if (!changed) continue;
    await db.timelineClip.update({
      where: { id: current.id },
      data: next
    });
  }

  for (let index = overlap; index < clipSpecs.length; index += 1) {
    await db.timelineClip.create({
      data: {
        timelineId,
        trackId: videoTrack.id,
        ...clipSpecs[index]
      }
    });
  }

  for (let index = overlap; index < existing.length; index += 1) {
    await db.timelineClip.delete({
      where: { id: existing[index].id }
    });
  }
}

function groupWordsIntoBlocks(words = []) {
  const blocks = [];
  let current = null;

  const pushCurrent = () => {
    if (!current?.words?.length) return;
    const text = current.words.map((word) => String(word.text || '')).join('');
    blocks.push({
      start: roundTime(Number(current.words[0].start_time || 0)),
      end: roundTime(Number(current.words[current.words.length - 1].end_time || current.words[0].start_time || 0)),
      text,
      words: current.words
    });
    current = null;
  };

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const prev = current?.words?.[current.words.length - 1] || null;
    const gap = prev ? Number(word.start_time || 0) - Number(prev.end_time || 0) : 0;
    const shouldBreak =
      !current ||
      gap > 1.25 ||
      prev?.asset_id !== word.asset_id ||
      /[。！？!?]/.test(String(prev?.text || '')) ||
      String(current.words.map((item) => item.text || '').join('')).length >= 72;

    if (shouldBreak) {
      pushCurrent();
      current = { words: [] };
    }

    current.words.push(word);
  }

  pushCurrent();
  return blocks.filter((block) => block.end - block.start > 0.2 && String(block.text || '').trim());
}

function buildSliceTitle(text = '', index = 0, query = '') {
  const normalized = String(text || '').replace(/\s+/g, '').trim();
  const prefix = String(query || '').trim();
  const body = normalized.slice(0, 18) || `切片 ${index + 1}`;
  return prefix ? `${prefix} · ${body}` : `切片 ${index + 1} · ${body}`;
}

function buildSuggestionWindows(blocks = [], { query = '', count = 4, minDuration = 20, maxDuration = 75 } = {}) {
  const candidates = [];
  const queryText = String(query || '').trim();

  for (let startIndex = 0; startIndex < blocks.length; startIndex += 1) {
    let combinedText = '';
    for (let endIndex = startIndex; endIndex < blocks.length; endIndex += 1) {
      const start = Number(blocks[startIndex].start || 0);
      const end = Number(blocks[endIndex].end || start);
      const duration = end - start;
      combinedText += String(blocks[endIndex].text || '');

      if (duration < minDuration) continue;
      if (duration > maxDuration) break;

      const density = combinedText.length / Math.max(duration, 1);
      const queryHits = queryText ? (combinedText.split(queryText).length - 1) : 0;
      const punctuationBonus = /[？?！!]/.test(combinedText) ? 8 : 0;
      const idealDuration = 45;
      const durationScore = Math.max(0, 30 - Math.abs(duration - idealDuration));
      const score = roundTime(durationScore + Math.min(24, density * 1.6) + punctuationBonus + queryHits * 30);

      candidates.push({
        start: roundTime(start),
        end: roundTime(end),
        duration: roundTime(duration),
        text: combinedText,
        score
      });
    }
  }

  candidates.sort((left, right) => right.score - left.score);

  const selected = [];
  for (const candidate of candidates) {
    const overlapsExisting = selected.some((item) => (
      Math.max(item.start, candidate.start) < Math.min(item.end, candidate.end)
    ));
    if (overlapsExisting) continue;
    selected.push(candidate);
    if (selected.length >= Math.max(1, Number(count || 4))) break;
  }

  return selected.map((candidate, index) => ({
    title: buildSliceTitle(candidate.text, index, queryText),
    summary: candidate.text.slice(0, 160),
    ranges: [{ start: candidate.start, end: candidate.end }],
    duration_seconds: candidate.duration,
    score: candidate.score
  }));
}

function buildTranscriptForRanges(words = [], ranges = []) {
  const normalizedRanges = normalizeRanges(ranges);
  const pickedWords = words.filter((word) => normalizedRanges.some((range) => (
    Number(word.start_time || 0) < range.end && Number(word.end_time || word.start_time || 0) > range.start
  )));
  const blocks = groupWordsIntoBlocks(pickedWords).map((block, index) => ({
    id: `slice_block_${index + 1}`,
    start: block.start,
    end: block.end,
    text: block.text
  }));

  return {
    transcript_text: pickedWords.map((word) => String(word.text || '')).join(''),
    blocks
  };
}

async function buildSliceDetail(db, projectId, timeline) {
  const slice = mapSliceTimeline(timeline);
  const ranges = slice.clips.map((clip) => ({
    start: Number(clip.original_project_start || clip.timeline_start || 0),
    end: Number(clip.original_project_end || clip.timeline_end || 0)
  }));
  const sourceState = await loadProjectEditSource(projectId);
  const transcript = buildTranscriptForRanges(sourceState.words || [], ranges);
  return {
    ...slice,
    ranges,
    transcript_text: transcript.transcript_text,
    transcript_blocks: transcript.blocks
  };
}

export async function listProjectSlices(projectId) {
  return withDatabase(async (db) => {
    const timelines = await db.timeline.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
      include: {
        clips: {
          orderBy: { sortOrder: 'asc' },
          include: {
            asset: true
          }
        }
      }
    });

    return timelines
      .filter((timeline) => readTimelineKind(timeline) === 'slice')
      .map(mapSliceTimeline);
  });
}

export async function getProjectSlice(projectId, timelineId) {
  return withDatabase(async (db) => {
    const timeline = await loadSliceTimeline(db, projectId, timelineId);
    return buildSliceDetail(db, projectId, timeline);
  });
}

export async function createProjectSlice(projectId, payload = {}) {
  return withDatabase(async (db) => {
    const primaryTimeline = await loadPrimaryTimeline(db, projectId);
    if (!primaryTimeline) {
      throw new Error('Primary timeline not found');
    }

    const existingSlices = await db.timeline.count({
      where: {
        projectId,
        isPrimary: false
      }
    });

    const ranges = normalizeRanges(payload.ranges || []);
    if (!ranges.length) {
      throw new Error('Slice ranges are required');
    }

    const title = sanitizeSliceTitle(payload.title || '', `切片 ${existingSlices + 1}`);
    const color = String(payload.color || pickSliceColor(existingSlices)).trim() || pickSliceColor(existingSlices);
    const masterClipSource = await loadBaselineProjectClips(db, projectId);
    const timeline = await db.timeline.create({
      data: {
        projectId,
        name: title,
        isPrimary: false,
        settings: {
          kind: 'slice',
          title,
          color,
          description: String(payload.description || '').trim(),
          summary: String(payload.summary || '').trim(),
          query: String(payload.query || '').trim(),
          generatedBy: String(payload.generatedBy || payload.generated_by || 'manual').trim() || 'manual',
          sourceTimelineId: primaryTimeline.id,
          targetDurationSeconds: Number(payload.target_duration_seconds || payload.targetDurationSeconds || 0) || roundTime(ranges.reduce((sum, range) => sum + Math.max(0, range.end - range.start), 0))
        },
        tracks: {
          create: [
            { kind: 'video', name: 'V1', sortOrder: 0 },
            { kind: 'subtitle', name: 'S1', sortOrder: 1 }
          ]
        }
      },
      include: {
        tracks: { orderBy: { sortOrder: 'asc' } }
      }
    });

    const clipSpecs = buildSliceClipSpecs(masterClipSource, ranges);
    await replaceSliceTimelineClips(db, timeline.id, clipSpecs);
    const saved = await loadSliceTimeline(db, projectId, timeline.id);
    return buildSliceDetail(db, projectId, saved);
  });
}

export async function updateProjectSlice(projectId, timelineId, payload = {}) {
  return withDatabase(async (db) => {
    const sliceTimeline = await loadSliceTimeline(db, projectId, timelineId);
    const settings = normalizeTimelineSettings(sliceTimeline.settings);
    const primaryTimeline = await loadPrimaryTimeline(db, projectId);
    if (!primaryTimeline) {
      throw new Error('Primary timeline not found');
    }
    const masterClipSource = await loadBaselineProjectClips(db, projectId);

    const nextTitle = sanitizeSliceTitle(payload.title ?? settings.title ?? sliceTimeline.name, '未命名切片');
    const nextColor = String(payload.color ?? settings.color ?? '').trim() || pickSliceColor(0);
    const nextSettings = {
      ...settings,
      kind: 'slice',
      title: nextTitle,
      color: nextColor,
      description: payload.description !== undefined ? String(payload.description || '').trim() : String(settings.description || '').trim(),
      summary: payload.summary !== undefined ? String(payload.summary || '').trim() : String(settings.summary || '').trim(),
      query: payload.query !== undefined ? String(payload.query || '').trim() : String(settings.query || '').trim(),
      generatedBy: String(payload.generatedBy || payload.generated_by || settings.generatedBy || settings.generated_by || 'manual').trim() || 'manual',
      sourceTimelineId: String(settings.sourceTimelineId || settings.source_timeline_id || primaryTimeline.id).trim() || primaryTimeline.id,
      targetDurationSeconds: Number(payload.target_duration_seconds ?? payload.targetDurationSeconds ?? settings.targetDurationSeconds ?? settings.target_duration_seconds ?? 0) || 0
    };

    await db.timeline.update({
      where: { id: timelineId },
      data: {
        name: nextTitle,
        settings: nextSettings
      }
    });

    if (payload.ranges) {
      const clipSpecs = buildSliceClipSpecs(masterClipSource, normalizeRanges(payload.ranges));
      await replaceSliceTimelineClips(db, timelineId, clipSpecs);
    }

    const saved = await loadSliceTimeline(db, projectId, timelineId);
    return buildSliceDetail(db, projectId, saved);
  });
}

export async function deleteProjectSlice(projectId, timelineId) {
  return withDatabase(async (db) => {
    const timeline = await loadSliceTimeline(db, projectId, timelineId);
    await db.timeline.delete({
      where: { id: timeline.id }
    });
    return {
      id: timeline.id,
      title: readSliceSettings(timeline).title
    };
  });
}

export async function suggestProjectSlices(projectId, payload = {}) {
  const sourceState = await loadProjectEditSource(projectId);
  const deletedWordKeys = new Set(sourceState.deleted_word_keys || []);
  const words = (sourceState.words || []).filter((word) => !deletedWordKeys.has(String(word.word_key || '')));
  const blocks = groupWordsIntoBlocks(words);
  const suggestions = buildSuggestionWindows(blocks, {
    query: String(payload.query || '').trim(),
    count: Number(payload.count || 4),
    minDuration: Number(payload.min_duration || payload.minDuration || 20),
    maxDuration: Number(payload.max_duration || payload.maxDuration || 75)
  });

  if (!payload.create) {
    return {
      suggestions
    };
  }

  const created = [];
  for (let index = 0; index < suggestions.length; index += 1) {
    const item = suggestions[index];
    created.push(await createProjectSlice(projectId, {
      title: item.title,
      color: pickSliceColor(index),
      summary: item.summary,
      query: String(payload.query || '').trim(),
      generatedBy: 'heuristic_suggester',
      targetDurationSeconds: item.duration_seconds,
      ranges: item.ranges
    }));
  }

  return {
    suggestions,
    created
  };
}
