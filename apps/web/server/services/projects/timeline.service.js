import path from 'path';
import { withDatabase } from '../core/database.service.js';
import { getOrCreatePrimaryTimeline } from './project.service.js';
import {
  applyProjectTextReplacements,
  ensureProjectEditStateConsistency,
  flattenCaptionWords as flattenProjectCaptionWords
} from './project-edit-state.service.js';
import { roundTime } from '../shared/timeline-utils.js';
import { tokenizeSegmentText } from '../shared/text-utils.js';

function flattenWords(asrResult = {}) {
  if (Array.isArray(asrResult.words)) return asrResult.words;
  if (Array.isArray(asrResult.segments)) {
    const nestedWords = asrResult.segments.flatMap((segment) => segment?.words || []);
    if (nestedWords.length) {
      return nestedWords;
    }

    return asrResult.segments.flatMap((segment, segmentIndex) => {
      const tokens = tokenizeSegmentText(segment?.text || segment?.transcript || '');
      if (!tokens.length) return [];

      const start = Number(segment?.start ?? segment?.start_time ?? 0);
      const end = Number(segment?.end ?? segment?.end_time ?? start + Math.max(tokens.length * 0.12, 0.4));
      const safeEnd = Math.max(start + 0.04, end);
      const unit = Math.max(0.04, (safeEnd - start) / tokens.length);

      return tokens.map((token, tokenIndex) => ({
        id: `${segment?.id || segmentIndex}:synthetic:${tokenIndex}`,
        text: token,
        start_time: roundTime(start + unit * tokenIndex),
        end_time: roundTime(tokenIndex === tokens.length - 1 ? safeEnd : start + unit * (tokenIndex + 1))
      }));
    });
  }
  return [];
}

function sanitizeProjectCaptionOverridePayload(payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {};
  }

  const sanitized = { ...payload };

  // Project overrides should not persist timing-bearing word streams as source of truth.
  delete sanitized.words;
  delete sanitized.segments;

  return sanitized;
}

function buildCaptionSegments(asset, maxChars = 48) {
  const caption = asset.captions?.[0];
  const payload = caption?.payload || {};
  const words = flattenWords(payload);
  if (!words.length) {
    if (asset.durationSeconds) {
      return [{
        id: `${asset.id}:0`,
        asset_id: asset.id,
        start: 0,
        end: roundTime(asset.durationSeconds),
        text: asset.transcriptText || asset.title,
        duration: roundTime(asset.durationSeconds)
      }];
    }
    return [];
  }

  const segments = [];
  let current = [];
  let segmentIndex = 0;

  const flush = () => {
    if (!current.length) return;
    const start = Number(current[0].start_time || 0);
    const end = Number(current[current.length - 1].end_time || start);
    const text = current.map((word) => word.text || '').join('');
    segments.push({
      id: `${asset.id}:${segmentIndex}`,
      asset_id: asset.id,
      start: roundTime(start),
      end: roundTime(end),
      text,
      duration: roundTime(end - start)
    });
    current = [];
    segmentIndex += 1;
  };

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const prev = words[index - 1];
    const gap = prev ? Number(word.start_time || 0) - Number(prev.end_time || 0) : 0;
    const nextText = `${current.map((item) => item.text || '').join('')}${word.text || ''}`;

    if (current.length && (gap > 0.85 || nextText.length > maxChars || /[。！？!?]/.test(prev?.text || ''))) {
      flush();
    }

    current.push(word);
  }

  flush();

  return segments;
}

function serializeOtioTimeline(project, timeline, clips) {
  return {
    OTIO_SCHEMA: 'Timeline.1',
    name: project.name,
    metadata: {
      project_id: project.id,
      exported_at: new Date().toISOString()
    },
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      name: 'tracks',
      children: [
        {
          OTIO_SCHEMA: 'Track.1',
          name: 'V1',
          kind: 'Video',
          children: clips.map((clip) => ({
            OTIO_SCHEMA: 'Clip.2',
            name: clip.label || clip.asset.title,
            media_references: {
              DEFAULT_MEDIA: {
                OTIO_SCHEMA: 'ExternalReference.1',
                target_url: clip.asset.files?.[0]?.uri || '',
                available_range: {
                  OTIO_SCHEMA: 'TimeRange.1',
                  start_time: {
                    OTIO_SCHEMA: 'RationalTime.1',
                    value: 0,
                    rate: 1
                  },
                  duration: {
                    OTIO_SCHEMA: 'RationalTime.1',
                    value: Number(clip.asset.durationSeconds || 0),
                    rate: 1
                  }
                }
              }
            },
            source_range: {
              OTIO_SCHEMA: 'TimeRange.1',
              start_time: {
                OTIO_SCHEMA: 'RationalTime.1',
                value: Number(clip.sourceStartSeconds || 0),
                rate: 1
              },
              duration: {
                OTIO_SCHEMA: 'RationalTime.1',
                value: Number((clip.sourceEndSeconds || 0) - (clip.sourceStartSeconds || 0)),
                rate: 1
              }
            },
            metadata: {
              clip_id: clip.id,
              asset_id: clip.assetId,
              timeline_start: clip.timelineStartSeconds,
              timeline_end: clip.timelineEndSeconds
            }
          }))
        }
      ]
    }
  };
}

export async function getProjectTimeline(projectId) {
  await ensureProjectEditStateConsistency(projectId);
  return withDatabase(async (db) => {
    const timeline = await db.timeline.findFirst({
      where: {
        projectId,
        isPrimary: true
      },
      include: {
        tracks: { orderBy: { sortOrder: 'asc' } },
        clips: {
          orderBy: { sortOrder: 'asc' },
          include: {
            asset: {
              include: {
                files: true
              }
            }
          }
        }
      }
    });

    if (!timeline) {
      return null;
    }

    const clips = timeline.clips.map((clip) => ({
      id: clip.id,
      asset_id: clip.assetId,
      asset_title: clip.asset.title,
      asset_source_url: `/api/library/assets/${clip.assetId}/source`,
      label: clip.label || clip.asset.title,
      source_start: clip.sourceStartSeconds,
      source_end: clip.sourceEndSeconds,
      timeline_start: clip.timelineStartSeconds,
      timeline_end: clip.timelineEndSeconds,
      duration: roundTime(clip.timelineEndSeconds - clip.timelineStartSeconds),
      sort_order: clip.sortOrder
    }));

    return {
      id: timeline.id,
      project_id: projectId,
      name: timeline.name,
      total_duration: clips.length ? clips[clips.length - 1].timeline_end : 0,
      clips
    };
  });
}

export async function appendAssetToTimeline(projectId, assetId, { start = 0, end = null, label = '' } = {}) {
  return withDatabase(async (db) => {
    const timeline = await getOrCreatePrimaryTimeline(projectId);
    const videoTrack = timeline.tracks.find((track) => track.kind === 'video') || timeline.tracks[0];
    const asset = await db.asset.findUnique({
      where: { id: assetId }
    });

    if (!asset) {
      throw new Error('Asset not found');
    }

    const existingLastClip = await db.timelineClip.findFirst({
      where: { timelineId: timeline.id, trackId: videoTrack.id },
      orderBy: { sortOrder: 'desc' }
    });

    const safeStart = Number(start || 0);
    const safeEnd = end == null ? Number(asset.durationSeconds || safeStart) : Number(end);
    const duration = Math.max(0.1, safeEnd - safeStart);
    const timelineStart = Number(existingLastClip?.timelineEndSeconds || 0);

    const clip = await db.timelineClip.create({
      data: {
        timelineId: timeline.id,
        trackId: videoTrack.id,
        assetId,
        label: label || asset.title,
        sourceStartSeconds: roundTime(safeStart),
        sourceEndSeconds: roundTime(safeEnd),
        timelineStartSeconds: roundTime(timelineStart),
        timelineEndSeconds: roundTime(timelineStart + duration),
        sortOrder: (existingLastClip?.sortOrder || 0) + 1
      }
    });

    return clip;
  });
}

export async function replaceTimelineClips(projectId, clipSpecs = []) {
  return withDatabase(async (db) => {
    const timeline = await getOrCreatePrimaryTimeline(projectId);
    const videoTrack = timeline.tracks.find((track) => track.kind === 'video') || timeline.tracks[0];
    const existing = await db.timelineClip.findMany({
      where: {
        timelineId: timeline.id,
        trackId: videoTrack.id
      },
      orderBy: { sortOrder: 'asc' }
    });

    let cursor = 0;
    const desired = clipSpecs.map((clip, index) => {
      const safeStart = Number(clip.source_start ?? clip.start ?? 0);
      const safeEnd = Number(clip.source_end ?? clip.end ?? safeStart);
      const duration = Math.max(0.1, safeEnd - safeStart);
      const value = {
        assetId: clip.asset_id,
        label: clip.label || null,
        sourceStartSeconds: roundTime(safeStart),
        sourceEndSeconds: roundTime(safeEnd),
        timelineStartSeconds: roundTime(cursor),
        timelineEndSeconds: roundTime(cursor + duration),
        sortOrder: index + 1
      };
      cursor += duration;
      return value;
    });

    const overlap = Math.min(existing.length, desired.length);
    for (let index = 0; index < overlap; index += 1) {
      const current = existing[index];
      const next = desired[index];
      const needsUpdate =
        current.assetId !== next.assetId ||
        String(current.label || '') !== String(next.label || '') ||
        Math.abs(Number(current.sourceStartSeconds || 0) - Number(next.sourceStartSeconds || 0)) > 0.001 ||
        Math.abs(Number(current.sourceEndSeconds || 0) - Number(next.sourceEndSeconds || 0)) > 0.001 ||
        Math.abs(Number(current.timelineStartSeconds || 0) - Number(next.timelineStartSeconds || 0)) > 0.001 ||
        Math.abs(Number(current.timelineEndSeconds || 0) - Number(next.timelineEndSeconds || 0)) > 0.001 ||
        Number(current.sortOrder || 0) !== Number(next.sortOrder || 0);

      if (!needsUpdate) continue;

      await db.timelineClip.update({
        where: { id: current.id },
        data: next
      });
    }

    for (let index = overlap; index < desired.length; index += 1) {
      await db.timelineClip.create({
        data: {
          timelineId: timeline.id,
          trackId: videoTrack.id,
          ...desired[index]
        }
      });
    }

    for (let index = overlap; index < existing.length; index += 1) {
      await db.timelineClip.delete({
        where: { id: existing[index].id }
      });
    }

    return getProjectTimeline(projectId);
  });
}

export async function removeTimelineClip(projectId, clipId) {
  return withDatabase(async (db) => {
    const clip = await db.timelineClip.findUnique({ where: { id: clipId } });
    if (!clip) return getProjectTimeline(projectId);

    await db.timelineClip.delete({ where: { id: clipId } });

    const remaining = await db.timelineClip.findMany({
      where: { timelineId: clip.timelineId, trackId: clip.trackId },
      orderBy: { sortOrder: 'asc' }
    });

    let cursor = 0;
    for (let index = 0; index < remaining.length; index += 1) {
      const item = remaining[index];
      const duration = Number(item.sourceEndSeconds) - Number(item.sourceStartSeconds);
      await db.timelineClip.update({
        where: { id: item.id },
        data: {
          sortOrder: index + 1,
          timelineStartSeconds: roundTime(cursor),
          timelineEndSeconds: roundTime(cursor + duration)
        }
      });
      cursor += duration;
    }

    return getProjectTimeline(projectId);
  });
}

export async function listAssetSegments(assetId) {
  return withDatabase(async (db) => {
    const asset = await db.asset.findUnique({
      where: { id: assetId },
      include: {
        captions: {
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      }
    });

    if (!asset) {
      throw new Error('Asset not found');
    }

    return buildCaptionSegments(asset);
  });
}

async function getProjectCaptionSource(db, assetId, projectId = '') {
  const override = projectId
    ? await db.projectCaptionOverride.findUnique({
        where: {
          projectId_assetId: {
            projectId,
            assetId
          }
        }
      })
    : null;
  const asset = await db.asset.findUnique({
    where: { id: assetId },
    include: {
      captions: {
        orderBy: { createdAt: 'desc' },
        take: 1
      }
    }
  });

  if (!asset) return null;

  return {
    asset,
    text: override?.transcriptText || asset.captions?.[0]?.text || asset.transcriptText || '',
    payload: asset.captions?.[0]?.payload || {},
    override_payload: sanitizeProjectCaptionOverridePayload(override?.payload || {})
  };
}

export async function listAssetWords(assetId, { projectId = '' } = {}) {
  if (projectId) {
    await ensureProjectEditStateConsistency(projectId);
  }
  return withDatabase(async (db) => {
    const source = await getProjectCaptionSource(db, assetId, projectId);
    if (!source?.asset) {
      throw new Error('Asset not found');
    }

    const payload = source.payload || {};
    const baseWords = flattenProjectCaptionWords(payload, assetId, Number(source.asset.durationSeconds || 0));
    const replacementSource = projectId
      ? await db.projectEditState.findUnique({
          where: { projectId },
          select: { textReplacements: true }
        })
      : null;
    const words = applyProjectTextReplacements(
      baseWords,
      replacementSource?.textReplacements || [],
      assetId
    ).map((word, index) => ({
      id: `${assetId}:word:${index}`,
      asset_id: assetId,
      asset_word_index: index,
      text: String(word?.text || ''),
      start_time: roundTime(Number(word?.start_time || 0)),
      end_time: roundTime(Number(word?.end_time || word?.start_time || 0))
    }));

    return words;
  });
}

export async function saveProjectCaptionOverride(projectId, assetId, { transcriptText = '', payload = {} } = {}) {
  return withDatabase(async (db) => {
    const sanitizedPayload = sanitizeProjectCaptionOverridePayload(payload);
    return db.projectCaptionOverride.upsert({
      where: {
        projectId_assetId: {
          projectId,
          assetId
        }
      },
      update: {
        transcriptText: String(transcriptText || ''),
        payload: sanitizedPayload
      },
      create: {
        projectId,
        assetId,
        transcriptText: String(transcriptText || ''),
        payload: sanitizedPayload
      }
    });
  });
}

export async function createTimelineSnapshot(projectId, { source = 'system', note = null, timelineId = '' } = {}) {
  return withDatabase(async (db) => {
    const project = await db.project.findUnique({ where: { id: projectId } });
    const timeline = await db.timeline.findFirst({
      where: timelineId
        ? { projectId, id: timelineId }
        : { projectId, isPrimary: true },
      include: {
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

    if (!project || !timeline) {
      throw new Error('Project timeline not found');
    }

    const otio = serializeOtioTimeline(project, timeline, timeline.clips);

    return db.timelineSnapshot.create({
      data: {
        projectId,
        timelineId: timeline.id,
        source,
        note,
        otio
      }
    });
  });
}

export async function listTimelineSnapshots(projectId) {
  return withDatabase((db) => db.timelineSnapshot.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    take: 30,
    select: {
      id: true,
      source: true,
      note: true,
      createdAt: true,
      timelineId: true
    }
  }));
}
