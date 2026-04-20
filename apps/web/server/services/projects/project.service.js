import { withDatabase } from '../core/database.service.js';
import { normalizeTimelineSettings, readTimelineKind } from '../shared/timeline-utils.js';

const DEFAULT_SLICE_COLOR = '#4cc2ff';

async function ensureCategory(db, categoryName) {
  const value = String(categoryName || '').trim();
  if (!value) return null;

  return db.projectCategory.upsert({
    where: { name: value },
    update: {},
    create: { name: value }
  });
}

async function ensurePrimaryTimeline(db, projectId) {
  const existing = await db.timeline.findFirst({
    where: { projectId, isPrimary: true },
    include: { tracks: { orderBy: { sortOrder: 'asc' } } }
  });

  if (existing) {
    if (existing.tracks.length) {
      return existing;
    }

    await db.timelineTrack.createMany({
      data: [
        { timelineId: existing.id, kind: 'video', name: 'V1', sortOrder: 0 },
        { timelineId: existing.id, kind: 'subtitle', name: 'S1', sortOrder: 1 }
      ]
    });

    return db.timeline.findUnique({
      where: { id: existing.id },
      include: { tracks: { orderBy: { sortOrder: 'asc' } } }
    });
  }

  const timeline = await db.timeline.create({
    data: {
      projectId,
      name: 'Main Timeline',
      isPrimary: true,
      tracks: {
        create: [
          { kind: 'video', name: 'V1', sortOrder: 0 },
          { kind: 'subtitle', name: 'S1', sortOrder: 1 }
        ]
      }
    },
    include: { tracks: { orderBy: { sortOrder: 'asc' } } }
  });

  return timeline;
}

function mapProjectSummary(project) {
  return {
    id: project.id,
    name: project.name,
    description: project.description || '',
    category: project.category?.name || '',
    status: project.status,
    created_at: project.createdAt,
    updated_at: project.updatedAt,
    last_opened_at: project.lastOpenedAt,
    asset_count: project._count?.projectAssets || 0,
    timeline_count: project._count?.timelines || 0
  };
}

function mapAssetCompact(asset) {
  const originalFile = asset.files?.find((file) => file.role === 'original') || asset.files?.[0] || null;

  return {
    id: asset.id,
    title: asset.title,
    original_filename: asset.originalFilename,
    kind: asset.kind,
    status: asset.status,
    asr_status: asset.asrStatus,
    duration_seconds: asset.durationSeconds,
    width: asset.width,
    height: asset.height,
    frame_rate: asset.frameRate,
    transcript_text: asset.transcriptText || '',
    source_url: originalFile ? `/api/library/assets/${asset.id}/source` : null
  };
}

function mapTimelineCompact(timeline) {
  const settings = normalizeTimelineSettings(timeline?.settings);
  const kind = readTimelineKind(timeline);
  const color = String(settings.color || (kind === 'slice' ? DEFAULT_SLICE_COLOR : '')).trim();
  const clips = Array.isArray(timeline.clips) ? timeline.clips : [];
  return {
    id: timeline.id,
    name: timeline.name,
    title: String(settings.title || timeline.name || '').trim() || timeline.name,
    is_primary: timeline.isPrimary,
    kind,
    color: color || null,
    description: String(settings.description || '').trim(),
    summary: String(settings.summary || '').trim(),
    source_timeline_id: String(settings.sourceTimelineId || settings.source_timeline_id || '').trim() || null,
    generated_by: String(settings.generatedBy || settings.generated_by || '').trim() || null,
    query: String(settings.query || '').trim(),
    target_duration_seconds: Number(settings.targetDurationSeconds || settings.target_duration_seconds || 0) || 0,
    clip_count: clips.length,
    total_duration: Number(clips[clips.length - 1]?.timelineEndSeconds || 0),
    tracks: (timeline.tracks || []).map((track) => ({
      id: track.id,
      kind: track.kind,
      name: track.name,
      sort_order: track.sortOrder
    })),
    clips: clips.map((clip) => ({
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
    }))
  };
}

function mapProjectDetail(project) {
  return {
    id: project.id,
    name: project.name,
    description: project.description || '',
    status: project.status,
    category: project.category ? {
      id: project.category.id,
      name: project.category.name
    } : null,
    created_at: project.createdAt,
    updated_at: project.updatedAt,
    last_opened_at: project.lastOpenedAt,
    projectAssets: (project.projectAssets || []).map((relation) => ({
      id: relation.id,
      asset_id: relation.assetId,
      sort_order: relation.sortOrder,
      added_at: relation.addedAt,
      asset: mapAssetCompact(relation.asset)
    })),
    timelines: (project.timelines || []).map(mapTimelineCompact)
  };
}

export async function listProjectCategories() {
  return withDatabase((db) => db.projectCategory.findMany({
    orderBy: { name: 'asc' }
  }));
}

export async function createProject({ name, description = '', categoryName = '', ownerId = '' }) {
  return withDatabase(async (db) => {
    const category = await ensureCategory(db, categoryName);
    const project = await db.project.create({
      data: {
        ownerId: String(ownerId || '').trim() || null,
        name: String(name || '').trim() || 'Untitled Project',
        description: String(description || '').trim() || null,
        categoryId: category?.id || null,
        lastOpenedAt: new Date()
      }
    });

    await ensurePrimaryTimeline(db, project.id);

    const created = await db.project.findUnique({
      where: { id: project.id },
      include: {
        category: true,
        _count: {
          select: {
            projectAssets: true,
            timelines: true
          }
        }
      }
    });

    return mapProjectSummary(created);
  });
}

export async function listProjects(ownerId = '') {
  return withDatabase(async (db) => {
    const projects = await db.project.findMany({
      where: {
        ownerId: String(ownerId || '').trim() || null
      },
      include: {
        category: true,
        _count: {
          select: {
            projectAssets: true,
            timelines: true
          }
        }
      },
      orderBy: [
        { lastOpenedAt: 'desc' },
        { updatedAt: 'desc' }
      ]
    });

    return projects.map(mapProjectSummary);
  });
}

export async function getProjectById(projectId) {
  return withDatabase(async (db) => {
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
        description: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        lastOpenedAt: true,
        category: {
          select: {
            id: true,
            name: true
          }
        },
        projectAssets: {
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true,
            assetId: true,
            sortOrder: true,
            addedAt: true,
            asset: {
              select: {
                id: true,
                title: true,
                originalFilename: true,
                kind: true,
                status: true,
                asrStatus: true,
                durationSeconds: true,
                width: true,
                height: true,
                frameRate: true,
                transcriptText: true,
                files: {
                  select: {
                    role: true,
                    uri: true
                  }
                }
              }
            }
          }
        },
        timelines: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            name: true,
            isPrimary: true,
            settings: true,
            tracks: {
              orderBy: { sortOrder: 'asc' },
              select: {
                id: true,
                kind: true,
                name: true,
                sortOrder: true
              }
            },
            clips: {
              orderBy: { sortOrder: 'asc' },
              select: {
                id: true,
                assetId: true,
                label: true,
                sourceStartSeconds: true,
                sourceEndSeconds: true,
                timelineStartSeconds: true,
                timelineEndSeconds: true,
                sortOrder: true,
                metadata: true,
                asset: {
                  select: {
                    id: true,
                    title: true,
                    files: {
                      select: {
                        role: true,
                        uri: true
                      }
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
      return null;
    }

    await db.project.update({
      where: { id: projectId },
      data: { lastOpenedAt: new Date() }
    });

    return mapProjectDetail(project);
  });
}

export async function deleteProject(projectId) {
  return withDatabase(async (db) => {
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true
      }
    });

    if (!project) {
      return null;
    }

    await db.job.deleteMany({
      where: { projectId }
    });

    await db.project.delete({
      where: { id: projectId }
    });

    return {
      id: project.id,
      name: project.name
    };
  });
}

export async function addAssetToProject(projectId, assetId) {
  return withDatabase(async (db) => {
    const existing = await db.projectAsset.findUnique({
      where: {
        projectId_assetId: {
          projectId,
          assetId
        }
      }
    });

    if (existing) {
      return existing;
    }

    const last = await db.projectAsset.findFirst({
      where: { projectId },
      orderBy: { sortOrder: 'desc' }
    });

    return db.projectAsset.create({
      data: {
        projectId,
        assetId,
        sortOrder: (last?.sortOrder || 0) + 1
      }
    });
  });
}

export async function getProjectAssetIds(projectId) {
  return withDatabase(async (db) => {
    const rows = await db.projectAsset.findMany({
      where: { projectId },
      select: { assetId: true },
      orderBy: { sortOrder: 'asc' }
    });

    return rows.map((row) => row.assetId);
  });
}

async function resequenceProjectAssets(db, projectId) {
  const rows = await db.projectAsset.findMany({
    where: { projectId },
    orderBy: { sortOrder: 'asc' }
  });

  for (let index = 0; index < rows.length; index += 1) {
    const nextOrder = index + 1;
    if (rows[index].sortOrder !== nextOrder) {
      await db.projectAsset.update({
        where: { id: rows[index].id },
        data: { sortOrder: nextOrder }
      });
    }
  }
}

async function resequenceTimelineClipsForProject(db, projectId) {
  const timeline = await ensurePrimaryTimeline(db, projectId);
  const videoTrack = timeline.tracks.find((track) => track.kind === 'video') || timeline.tracks[0];

  const clips = await db.timelineClip.findMany({
    where: {
      timelineId: timeline.id,
      trackId: videoTrack.id
    },
    orderBy: { sortOrder: 'asc' }
  });

  let cursor = 0;
  for (let index = 0; index < clips.length; index += 1) {
    const clip = clips[index];
    const duration = Number(clip.sourceEndSeconds || 0) - Number(clip.sourceStartSeconds || 0);
    const safeDuration = Math.max(0.1, duration);
    await db.timelineClip.update({
      where: { id: clip.id },
      data: {
        sortOrder: index + 1,
        timelineStartSeconds: cursor,
        timelineEndSeconds: cursor + safeDuration
      }
    });
    cursor += safeDuration;
  }
}

export async function reorderProjectAssets(projectId, orderedAssetIds = []) {
  return withDatabase(async (db) => {
    const rows = await db.projectAsset.findMany({
      where: { projectId },
      orderBy: { sortOrder: 'asc' }
    });

    const rowByAssetId = new Map(rows.map((row) => [row.assetId, row]));
    const normalized = orderedAssetIds.filter((assetId) => rowByAssetId.has(assetId));
    const missing = rows.map((row) => row.assetId).filter((assetId) => !normalized.includes(assetId));
    const finalOrder = [...normalized, ...missing];

    for (let index = 0; index < finalOrder.length; index += 1) {
      const row = rowByAssetId.get(finalOrder[index]);
      if (!row) continue;
      await db.projectAsset.update({
        where: { id: row.id },
        data: { sortOrder: index + 1 }
      });
    }

    const timeline = await ensurePrimaryTimeline(db, projectId);
    const videoTrack = timeline.tracks.find((track) => track.kind === 'video') || timeline.tracks[0];
    const clips = await db.timelineClip.findMany({
      where: {
        timelineId: timeline.id,
        trackId: videoTrack.id
      },
      orderBy: [
        { sortOrder: 'asc' }
      ]
    });

    const assetOrderIndex = new Map(finalOrder.map((assetId, index) => [assetId, index]));
    const reorderedClips = [...clips].sort((left, right) => {
      const leftAssetOrder = assetOrderIndex.get(left.assetId) ?? Number.MAX_SAFE_INTEGER;
      const rightAssetOrder = assetOrderIndex.get(right.assetId) ?? Number.MAX_SAFE_INTEGER;
      if (leftAssetOrder !== rightAssetOrder) return leftAssetOrder - rightAssetOrder;
      if (Number(left.sourceStartSeconds || 0) !== Number(right.sourceStartSeconds || 0)) {
        return Number(left.sourceStartSeconds || 0) - Number(right.sourceStartSeconds || 0);
      }
      return left.sortOrder - right.sortOrder;
    });

    let cursor = 0;
    for (let index = 0; index < reorderedClips.length; index += 1) {
      const clip = reorderedClips[index];
      const duration = Math.max(
        0.1,
        Number(clip.sourceEndSeconds || 0) - Number(clip.sourceStartSeconds || 0)
      );
      await db.timelineClip.update({
        where: { id: clip.id },
        data: {
          sortOrder: index + 1,
          timelineStartSeconds: cursor,
          timelineEndSeconds: cursor + duration
        }
      });
      cursor += duration;
    }

    await resequenceProjectAssets(db, projectId);
    return getProjectById(projectId);
  });
}

export async function removeAssetFromProject(projectId, assetId) {
  return withDatabase(async (db) => {
    await db.projectAsset.deleteMany({
      where: {
        projectId,
        assetId
      }
    });

    const timeline = await ensurePrimaryTimeline(db, projectId);
    const videoTrack = timeline.tracks.find((track) => track.kind === 'video') || timeline.tracks[0];

    await db.timelineClip.deleteMany({
      where: {
        timelineId: timeline.id,
        trackId: videoTrack.id,
        assetId
      }
    });

    await resequenceProjectAssets(db, projectId);
    await resequenceTimelineClipsForProject(db, projectId);
    return getProjectById(projectId);
  });
}

export async function getOrCreatePrimaryTimeline(projectId) {
  return withDatabase((db) => ensurePrimaryTimeline(db, projectId));
}
