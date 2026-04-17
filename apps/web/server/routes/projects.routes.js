import express from 'express';
import fs from 'fs';
import multer from 'multer';
import path from 'path';
import { withDatabase } from '../services/core/database.service.js';
import { listJobsByProject } from '../services/core/job.service.js';
import { createProject, deleteProject, getProjectById, listProjectCategories, listProjects, addAssetToProject, reorderProjectAssets, removeAssetFromProject } from '../services/projects/project.service.js';
import { appendAssetToTimeline, createTimelineSnapshot, getProjectTimeline, listTimelineSnapshots, removeTimelineClip, replaceTimelineClips } from '../services/projects/timeline.service.js';
import { getProjectEditState, realignProjectEditState, saveProjectEditState } from '../services/projects/project-edit-state.service.js';
import { exportProjectPackage, exportProjectTimelineVideo } from '../services/projects/project-export.service.js';
import { exportProjectInterchangeFile, PROJECT_INTERCHANGE_FORMATS } from '../services/projects/project-interchange.service.js';
import { importProjectPackageFromZip } from '../services/projects/project-import.service.js';
import { cancelProjectAgentRun, confirmProjectAgentRun, runProjectAgentSessionWorkflow } from '../services/agent/project-agent.service.js';
import { createProjectAgentSession, getProjectAgentSession, listProjectAgentSessions, listRunEvents } from '../services/agent/agent-session.service.js';
import { ensureStorageDirs, ensureWorkspaceDirs } from '../services/editor/config.js';
import { createAssetFromUpload } from '../services/library/asset-library.service.js';

const router = express.Router();
const { uploadsDir } = ensureWorkspaceDirs();
const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }
});

router.get('/categories', async (_req, res) => {
  try {
    const categories = await listProjectCategories();
    res.json({
      success: true,
      categories: categories.map((item) => ({
        id: item.id,
        name: item.name
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/', async (_req, res) => {
  try {
    const projects = await listProjects();
    res.json({ success: true, projects });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const project = await createProject(req.body || {});
    res.json({ success: true, project });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/imports/package', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No package file uploaded' });
    }

    const project = await importProjectPackageFromZip(req.file.path);
    await fs.promises.unlink(req.file.path).catch(() => {});
    res.json({ success: true, project });
  } catch (error) {
    if (req.file?.path) {
      await fs.promises.unlink(req.file.path).catch(() => {});
    }
    res.status(500).json({ error: error.message });
  }
});

router.get('/:projectId', async (req, res) => {
  try {
    const project = await getProjectById(req.params.projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    res.json({ success: true, project });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:projectId', async (req, res) => {
  try {
    const project = await deleteProject(req.params.projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    res.json({ success: true, project });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:projectId/assets', async (req, res) => {
  try {
    const { assetId } = req.body;
    if (!assetId) {
      return res.status(400).json({ error: 'assetId is required' });
    }
    await addAssetToProject(req.params.projectId, assetId);
    await realignProjectEditState(req.params.projectId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:projectId/assets/upload', upload.fields([
  { name: 'video', maxCount: 20 },
  { name: 'videos', maxCount: 20 },
  { name: 'json', maxCount: 1 }
]), async (req, res) => {
  try {
    const videoFiles = [
      ...(req.files?.video || []),
      ...(req.files?.videos || [])
    ];
    const jsonFile = req.files?.json?.[0] || null;

    if (!videoFiles.length) {
      return res.status(400).json({ error: 'No videos uploaded' });
    }

    const assets = [];
    for (let index = 0; index < videoFiles.length; index += 1) {
      const file = videoFiles[index];
      const asset = await createAssetFromUpload(file, {
        language: req.body.language || 'Chinese',
        title: Array.isArray(req.body.title) ? req.body.title[index] : req.body.title,
        jsonFile: index === 0 ? jsonFile : null
      });
      await addAssetToProject(req.params.projectId, asset.id);
      assets.push(asset);
    }

    const realigned = await realignProjectEditState(req.params.projectId);
    res.json({
      success: true,
      assets,
      edit_state: realigned.edit_state,
      timeline: realigned.timeline
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:projectId/assets/order', async (req, res) => {
  try {
    const orderedAssetIds = Array.isArray(req.body?.assetIds) ? req.body.assetIds : [];
    const project = await reorderProjectAssets(req.params.projectId, orderedAssetIds);
    await realignProjectEditState(req.params.projectId);
    res.json({ success: true, project });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:projectId/assets/:assetId', async (req, res) => {
  try {
    const project = await removeAssetFromProject(req.params.projectId, req.params.assetId);
    await realignProjectEditState(req.params.projectId);
    res.json({ success: true, project });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:projectId/edit-state', async (req, res) => {
  try {
    const editState = await getProjectEditState(req.params.projectId);
    res.json({ success: true, edit_state: editState });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:projectId/edit-state', async (req, res) => {
  try {
    const result = await saveProjectEditState(req.params.projectId, req.body || {});
    if (req.body?.createSnapshot !== false) {
      await createTimelineSnapshot(req.params.projectId, {
        source: req.body?.source || 'manual',
        note: req.body?.note || 'Manual edit state update'
      });
    }
    res.json({ success: true, edit_state: result.edit_state, timeline: result.timeline });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:projectId/timeline', async (req, res) => {
  try {
    const timeline = await getProjectTimeline(req.params.projectId);
    res.json({ success: true, timeline });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:projectId/timeline', async (req, res) => {
  try {
    const timeline = await replaceTimelineClips(req.params.projectId, req.body.clips || []);
    await createTimelineSnapshot(req.params.projectId, {
      source: 'manual',
      note: 'Manual timeline update'
    });
    res.json({ success: true, timeline });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:projectId/timeline/clips', async (req, res) => {
  try {
    const { assetId, start, end, label } = req.body;
    if (!assetId) {
      return res.status(400).json({ error: 'assetId is required' });
    }
    const clip = await appendAssetToTimeline(req.params.projectId, assetId, { start, end, label });
    await createTimelineSnapshot(req.params.projectId, {
      source: 'manual',
      note: 'Append clip'
    });
    res.json({ success: true, clip });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:projectId/timeline/clips/:clipId', async (req, res) => {
  try {
    const timeline = await removeTimelineClip(req.params.projectId, req.params.clipId);
    await createTimelineSnapshot(req.params.projectId, {
      source: 'manual',
      note: 'Remove clip'
    });
    res.json({ success: true, timeline });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:projectId/timeline/snapshots', async (req, res) => {
  try {
    const snapshots = await listTimelineSnapshots(req.params.projectId);
    res.json({ success: true, snapshots });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:projectId/timeline/snapshot', async (req, res) => {
  try {
    const snapshot = await createTimelineSnapshot(req.params.projectId, {
      source: req.body?.source || 'manual',
      note: req.body?.note || 'Manual snapshot'
    });
    res.json({ success: true, snapshot });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:projectId/jobs', async (req, res) => {
  try {
    const jobs = await listJobsByProject(req.params.projectId);
    res.json({ success: true, jobs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:projectId/agent/runs', async (req, res) => {
  try {
    const runs = await withDatabase((db) => db.agentRun.findMany({
      where: { projectId: req.params.projectId },
      orderBy: { createdAt: 'desc' },
      take: 30
    }));
    res.json({ success: true, runs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:projectId/agent/sessions', async (req, res) => {
  try {
    const sessions = await listProjectAgentSessions(req.params.projectId);
    res.json({ success: true, sessions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:projectId/agent/sessions', async (req, res) => {
  try {
    const session = await createProjectAgentSession(req.params.projectId, req.body || {});
    res.json({ success: true, session });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:projectId/agent/sessions/:sessionId', async (req, res) => {
  try {
    const session = await getProjectAgentSession(req.params.projectId, req.params.sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Agent session not found' });
    }
    res.json({ success: true, session });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:projectId/agent/sessions/:sessionId/runs/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': keep-alive\n\n');
    }
  }, 10000);

  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const normalizedBody = {
      ...(req.body || {}),
      prompt: String(req.body?.prompt || req.body?.message || '').trim()
    };
    const result = await runProjectAgentSessionWorkflow({
      projectId: req.params.projectId,
      sessionId: req.params.sessionId,
      ...normalizedBody,
      onEvent: (event) => {
        sendEvent({
          type: event.type,
          step: event.step,
          message: event.message,
          payload: event.payload,
          created_at: event.created_at,
          run_id: event.run_id,
          session_id: event.session_id
        });
      }
    });

    sendEvent({
      type: 'result',
      result
    });
  } catch (error) {
    sendEvent({
      type: 'error',
      message: error.message
    });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

router.post('/:projectId/agent/runs/:runId/confirm', async (req, res) => {
  try {
    const result = await confirmProjectAgentRun({
      projectId: req.params.projectId,
      runId: req.params.runId,
      approved: req.body?.approved !== false
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:projectId/agent/runs/:runId/cancel', async (req, res) => {
  try {
    const result = await cancelProjectAgentRun({
      projectId: req.params.projectId,
      runId: req.params.runId
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:projectId/agent/runs/:runId/events', async (req, res) => {
  try {
    const events = await listRunEvents(req.params.runId);
    res.json({ success: true, events });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:projectId/exports/video', async (req, res) => {
  try {
    const result = await exportProjectTimelineVideo(req.params.projectId);
    const filename = path.basename(result.outputPath);
    res.json({
      success: true,
      output_file: result.outputPath,
      download_url: `/api/projects/${req.params.projectId}/downloads/${filename}`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:projectId/exports/package', async (req, res) => {
  try {
    const result = await exportProjectPackage(req.params.projectId, req.body || {});
    const filename = path.basename(result.zipPath);
    res.json({
      success: true,
      package_dir: result.packageDir,
      zip_file: result.zipPath,
      download_url: `/api/projects/${req.params.projectId}/downloads/${filename}`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:projectId/exports/interchange', async (req, res) => {
  try {
    const format = String(req.body?.format || 'premiere_xml').trim();
    if (!PROJECT_INTERCHANGE_FORMATS[format]) {
      return res.status(400).json({ error: 'Unsupported export format' });
    }

    const result = await exportProjectInterchangeFile(req.params.projectId, format);
    const filename = path.basename(result.outputPath);
    res.json({
      success: true,
      format: result.format,
      label: result.label,
      output_file: result.outputPath,
      download_url: `/api/projects/${req.params.projectId}/downloads/${filename}`,
      compatibility_note: result.compatibilityNote
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:projectId/downloads/:filename', async (req, res) => {
  try {
    const { exportsDir, packagesDir } = ensureStorageDirs();
    const candidates = [
      path.join(exportsDir, req.params.filename),
      path.join(packagesDir, req.params.filename)
    ];

    const hit = candidates.find((candidate) => fs.existsSync(candidate));
    if (!hit) {
      return res.status(404).json({ error: 'File not found' });
    }

    res.download(hit);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
