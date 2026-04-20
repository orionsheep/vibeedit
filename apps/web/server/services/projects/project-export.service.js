import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { v4 as uuidv4 } from 'uuid';
import { ensureStorageDirs } from '../editor/config.js';
import { withDatabase } from '../core/database.service.js';
import { completeJob, createJob, failJob, markJobRunning, updateJobProgress } from '../core/job.service.js';
import { readTimelineKind, roundTime } from '../shared/timeline-utils.js';
import { sanitizeFilename } from '../shared/text-utils.js';

function timemarkToSeconds(timemark = '') {
  const raw = String(timemark || '').trim();
  if (!raw) return 0;
  const parts = raw.split(':').map((part) => Number(part || 0));
  if (parts.some((value) => !Number.isFinite(value))) {
    return 0;
  }
  if (parts.length === 3) {
    return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
  }
  if (parts.length === 2) {
    return (parts[0] * 60) + parts[1];
  }
  return Number(parts[0] || 0);
}

function exportClipSegment(sourcePath, clip, outputPath) {
  return new Promise((resolve, reject) => {
    const duration = Math.max(0.05, Number(clip.sourceEndSeconds) - Number(clip.sourceStartSeconds));

    ffmpeg(sourcePath)
      .setStartTime(Number(clip.sourceStartSeconds))
      .setDuration(duration)
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions(['-movflags', '+faststart'])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

function selectTimelineForExport(project, timelineId = '') {
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

async function loadProjectExportData(projectId, timelineId = '') {
  return withDatabase(async (db) => {
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
        description: true,
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
                mimeType: true,
                durationSeconds: true,
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
          where: timelineId
            ? { id: String(timelineId || '').trim() }
            : undefined,
          select: {
            id: true,
            name: true,
            isPrimary: true,
            settings: true,
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
      throw new Error('Project not found');
    }

    const timeline = selectTimelineForExport(project, timelineId);
    if (!timeline) {
      throw new Error('Project timeline is empty');
    }

    return project;
  });
}

export async function exportProjectTimelineVideo(projectId, { timelineId = '' } = {}) {
  const job = await createJob({
    type: 'export.video',
    payload: { projectId, timelineId },
    projectId,
    message: 'Queued project video export'
  });

  return runProjectTimelineVideoExportJob(job.id, projectId, { timelineId });
}

export async function queueProjectTimelineVideoExport(projectId, { timelineId = '' } = {}) {
  const job = await createJob({
    type: 'export.video',
    payload: { projectId, timelineId },
    projectId,
    message: 'Queued project video export'
  });

  Promise.resolve()
    .then(() => runProjectTimelineVideoExportJob(job.id, projectId, { timelineId }))
    .catch((error) => {
      console.error(`[export.video] background job ${job.id} failed:`, error);
    });

  return job;
}

async function runProjectTimelineVideoExportJob(jobId, projectId, { timelineId = '' } = {}) {
  const job = { id: jobId };

  const project = await loadProjectExportData(projectId, timelineId);
  const timeline = selectTimelineForExport(project, timelineId);
  if (!timeline || !timeline.clips.length) {
    await failJob(job.id, new Error('Project timeline is empty'));
    throw new Error('Project timeline is empty');
  }

  const { exportsDir } = ensureStorageDirs();
  const exportId = uuidv4().substring(0, 8);
  const baseName = readTimelineKind(timeline) === 'slice'
    ? `${project.name}_${timeline.settings?.title || timeline.name}`
    : project.name;
  const outputPath = path.join(exportsDir, `${sanitizeFilename(baseName)}_${exportId}.mp4`);
  const concatListPath = path.join(exportsDir, `concat_${exportId}.txt`);
  const tempSegments = [];
  const totalDurationSeconds = Math.max(
    0.1,
    timeline.clips.reduce((sum, clip) => (
      sum + Math.max(0.05, Number(clip.sourceEndSeconds || 0) - Number(clip.sourceStartSeconds || 0))
    ), 0)
  );

  try {
    await markJobRunning(job.id, 'Rendering timeline clips');
    for (const clip of timeline.clips) {
      const sourcePath = clip.asset.files?.find((file) => file.role === 'original')?.uri;
      if (!sourcePath) {
        throw new Error(`Original file missing for asset ${clip.assetId}`);
      }
      const tempSegment = path.join(exportsDir, `segment_${uuidv4().substring(0, 8)}.mp4`);
      tempSegments.push(tempSegment);
      await exportClipSegment(sourcePath, clip, tempSegment);
      await updateJobProgress(job.id, Math.round((tempSegments.length / Math.max(timeline.clips.length, 1)) * 70), `Rendered ${tempSegments.length}/${timeline.clips.length} clips`);
    }

    const concatContent = tempSegments
      .map((segmentPath) => `file '${segmentPath.replace(/'/g, "'\\''")}'`)
      .join('\n');
    await fs.promises.writeFile(concatListPath, concatContent, 'utf-8');
    await updateJobProgress(job.id, 72, '正在合成最终视频');

    await new Promise((resolve, reject) => {
      let lastProgressValue = 72;
      ffmpeg()
        .input(concatListPath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions(['-c:v', 'libx264', '-c:a', 'aac', '-movflags', '+faststart'])
        .output(outputPath)
        .on('progress', ({ timemark }) => {
          const renderedSeconds = timemarkToSeconds(timemark);
          if (!Number.isFinite(renderedSeconds) || renderedSeconds <= 0) {
            return;
          }
          const ratio = Math.max(0, Math.min(1, renderedSeconds / totalDurationSeconds));
          const progressValue = Math.max(72, Math.min(98, 72 + Math.round(ratio * 26)));
          if (progressValue <= lastProgressValue) {
            return;
          }
          lastProgressValue = progressValue;
          void updateJobProgress(job.id, progressValue, `正在合成最终视频 ${Math.round(ratio * 100)}%`).catch(() => {});
        })
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    await completeJob(job.id, { outputPath }, 'Project video export completed');

    return {
      success: true,
      outputPath
    };
  } catch (error) {
    await failJob(job.id, error);
    throw error;
  } finally {
    for (const segmentPath of tempSegments) {
      if (fs.existsSync(segmentPath)) {
        await fs.promises.unlink(segmentPath).catch(() => {});
      }
    }
    if (fs.existsSync(concatListPath)) {
      await fs.promises.unlink(concatListPath).catch(() => {});
    }
  }
}
