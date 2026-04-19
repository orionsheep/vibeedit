import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import ffmpeg from 'fluent-ffmpeg';
import { v4 as uuidv4 } from 'uuid';
import { ensureStorageDirs } from '../editor/config.js';
import { withDatabase } from '../core/database.service.js';
import { completeJob, createJob, failJob, markJobRunning, updateJobProgress } from '../core/job.service.js';
import { createTimelineSnapshot } from './timeline.service.js';
import { getProjectEditState, loadProjectEditSource } from './project-edit-state.service.js';
import { buildProjectInterchangeArtifacts, collectSourceInfoByAssetId } from './project-interchange.service.js';
import { readTimelineKind, roundTime } from '../shared/timeline-utils.js';
import { sanitizeFilename } from '../shared/text-utils.js';

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
                  include: { files: true }
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

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatListPath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions(['-c:v', 'libx264', '-c:a', 'aac', '-movflags', '+faststart'])
        .output(outputPath)
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

export async function exportProjectPackage(projectId, { includeSourceMedia = true, timelineId = '' } = {}) {
  const job = await createJob({
    type: 'export.project_package',
    payload: { projectId, includeSourceMedia, timelineId },
    projectId,
    message: 'Queued project package export'
  });

  const project = await loadProjectExportData(projectId, timelineId);
  try {
    const selectedTimeline = selectTimelineForExport(project, timelineId);
    await markJobRunning(job.id, 'Creating OTIO snapshot');
    const snapshot = await createTimelineSnapshot(projectId, {
      source: 'package_export',
      note: 'Project package export',
      timelineId: selectedTimeline?.id || ''
    });
    const editState = await getProjectEditState(projectId);
    const sourceState = await loadProjectEditSource(projectId);

    const { packagesDir } = ensureStorageDirs();
    const packageId = uuidv4().substring(0, 8);
    const baseName = `${sanitizeFilename(project.name)}_${packageId}`;
    const packageDir = path.join(packagesDir, baseName);
    const projectDir = path.join(packageDir, 'project');
    const mediaDir = path.join(packageDir, 'media');
    const captionsDir = path.join(projectDir, 'captions');

    await fs.promises.mkdir(projectDir, { recursive: true });
    await fs.promises.mkdir(mediaDir, { recursive: true });
    await fs.promises.mkdir(captionsDir, { recursive: true });

    const manifest = {
      project_id: project.id,
      name: project.name,
      category: project.category?.name || '',
      exported_at: new Date().toISOString(),
      include_source_media: includeSourceMedia,
      asset_count: project.projectAssets.length,
      clip_count: selectedTimeline?.clips?.length || 0,
      timeline_id: selectedTimeline?.id || null,
      timeline_kind: readTimelineKind(selectedTimeline),
      timeline_title: selectedTimeline?.settings?.title || selectedTimeline?.name || null
    };

    await fs.promises.writeFile(
      path.join(projectDir, 'project.json'),
      JSON.stringify({
        id: project.id,
        name: project.name,
        description: project.description || '',
        category: project.category?.name || ''
      }, null, 2),
      'utf-8'
    );

    await fs.promises.writeFile(
      path.join(projectDir, 'assets.json'),
      JSON.stringify(project.projectAssets.map((relation) => ({
        asset_id: relation.asset.id,
        title: relation.asset.title,
        original_filename: relation.asset.originalFilename,
        mime_type: relation.asset.mimeType || '',
        duration_seconds: relation.asset.durationSeconds,
        media_filename: relation.asset.files?.find((file) => file.role === 'original')?.uri
          ? path.basename(relation.asset.files.find((file) => file.role === 'original').uri)
          : null,
        caption_filename: `${relation.asset.id}.json`
      })), null, 2),
      'utf-8'
    );

    await fs.promises.writeFile(
      path.join(projectDir, 'edit-state.json'),
      JSON.stringify(editState, null, 2),
      'utf-8'
    );

    await fs.promises.writeFile(
      path.join(projectDir, 'source-state.json'),
      JSON.stringify(sourceState, null, 2),
      'utf-8'
    );

    await fs.promises.writeFile(
      path.join(projectDir, 'timeline.otio'),
      JSON.stringify(snapshot.otio, null, 2),
      'utf-8'
    );

    if (selectedTimeline?.clips?.length) {
      const sourceInfoByAssetId = await collectSourceInfoByAssetId(selectedTimeline.clips, {
        pathurlResolver: ({ sourcePath }) => (
          includeSourceMedia
            ? path.join(mediaDir, path.basename(sourcePath))
            : sourcePath
        )
      });
      const interchange = buildProjectInterchangeArtifacts({
        project,
        clips: selectedTimeline.clips,
        sourceInfoByAssetId,
        sourceState
      });
      const interchangeBaseName = sanitizeFilename(readTimelineKind(selectedTimeline) === 'slice'
        ? `${project.name}_${selectedTimeline.settings?.title || selectedTimeline.name}`
        : project.name);

      await fs.promises.writeFile(
        path.join(projectDir, `${interchangeBaseName}.xml`),
        interchange.premiereXml,
        'utf-8'
      );
      await fs.promises.writeFile(
        path.join(projectDir, `${interchangeBaseName}.edl`),
        interchange.edl,
        'utf-8'
      );
      if (String(interchange.capcutSrt || '').trim()) {
        await fs.promises.writeFile(
          path.join(projectDir, `${interchangeBaseName}.srt`),
          interchange.capcutSrt,
          'utf-8'
        );
      }

      manifest.interchange_files = {
        premiere_xml: `${interchangeBaseName}.xml`,
        edl: `${interchangeBaseName}.edl`,
        capcut_srt: String(interchange.capcutSrt || '').trim() ? `${interchangeBaseName}.srt` : null
      };
    }

    for (const relation of project.projectAssets) {
      await fs.promises.writeFile(
        path.join(captionsDir, `${relation.asset.id}.json`),
        JSON.stringify({
          asset_id: relation.asset.id,
          title: relation.asset.title,
          transcript_text: relation.asset.transcriptText || relation.asset.captions?.[0]?.text || '',
          payload: relation.asset.captions?.[0]?.payload || {}
        }, null, 2),
        'utf-8'
      );
    }

    await fs.promises.writeFile(
      path.join(packageDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8'
    );

    await updateJobProgress(job.id, includeSourceMedia ? 45 : 70, 'Packaging project files');

    if (includeSourceMedia) {
      let copied = 0;
      for (const relation of project.projectAssets) {
        const sourcePath = relation.asset.files?.find((file) => file.role === 'original')?.uri;
        if (!sourcePath || !fs.existsSync(sourcePath)) {
          continue;
        }
        await fs.promises.copyFile(sourcePath, path.join(mediaDir, path.basename(sourcePath)));
        copied += 1;
        await updateJobProgress(job.id, Math.min(85, 45 + Math.round((copied / Math.max(project.projectAssets.length, 1)) * 40)), `Copied ${copied}/${project.projectAssets.length} source files`);
      }
    }

    const zipPath = `${packageDir}.zip`;
    execFileSync('zip', ['-r', zipPath, '.'], {
      cwd: packageDir
    });

    await completeJob(job.id, { packageDir, zipPath }, 'Project package export completed');

    return {
      success: true,
      packageDir,
      zipPath
    };
  } catch (error) {
    await failJob(job.id, error);
    throw error;
  }
}
