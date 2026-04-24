import express from 'express';
import multer from 'multer';
import path from 'path';
import { ensureWorkspaceDirs } from '../services/editor/config.js';
import { createAssetFromUpload, getAssetById, getAssetFilePath, getAssetSourcePath, listAssets, retranscribeAllAssets, retranscribeAsset } from '../services/library/asset-library.service.js';
import { addAssetToProject } from '../services/projects/project.service.js';
import { listAssetSegments, listAssetWords } from '../services/projects/timeline.service.js';
import { allowSignedAssetSourceOrOwner, attachAuthContext, requireAuth, requireOwnedAsset } from '../services/auth/auth.middleware.js';
import { getOwnedProjectById } from '../services/auth/auth.service.js';

const router = express.Router();
const { uploadsDir } = ensureWorkspaceDirs();
const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }
});

router.use(attachAuthContext);

router.get('/assets/:assetId/source', allowSignedAssetSourceOrOwner, async (req, res) => {
  try {
    const sourcePath = await getAssetSourcePath(req.params.assetId, req.auth?.userId || '', {
      allowAny: Boolean(String(req.query?.token || '').trim())
    });
    if (!sourcePath) {
      return res.status(404).json({ error: 'Source file not found' });
    }
    res.sendFile(sourcePath);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/assets/:assetId/files/:role', allowSignedAssetSourceOrOwner, async (req, res) => {
  try {
    const filePath = await getAssetFilePath(req.params.assetId, req.params.role, req.auth?.userId || '', {
      allowAny: Boolean(String(req.query?.token || '').trim())
    });
    if (!filePath) {
      return res.status(404).json({ error: 'Asset file not found' });
    }
    res.sendFile(filePath);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.use(requireAuth);

router.get('/assets', async (req, res) => {
  try {
    const assets = await listAssets({ query: req.query.q || '', ownerId: req.auth?.userId || '' });
    res.json({ success: true, assets });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/assets/upload', upload.fields([
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

    const results = [];
    for (let index = 0; index < videoFiles.length; index += 1) {
      const file = videoFiles[index];
      const asset = await createAssetFromUpload(file, {
        language: req.body.language || 'Chinese',
        title: Array.isArray(req.body.title) ? req.body.title[index] : req.body.title,
        jsonFile: index === 0 ? jsonFile : null,
        ownerId: req.auth?.userId || ''
      });
      results.push(asset);
    }

    res.json({
      success: true,
      assets: results
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/assets/:assetId', async (req, res) => {
  try {
    const asset = await getAssetById(req.params.assetId, req.auth?.userId || '');
    if (!asset) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    res.json({ success: true, asset });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/assets/retranscribe', async (req, res) => {
  try {
    const results = await retranscribeAllAssets({
      language: req.body?.language || 'Chinese',
      ownerId: req.auth?.userId || ''
    });
    res.json({ success: true, results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.use('/assets/:assetId', requireOwnedAsset);

router.post('/assets/:assetId/retranscribe', async (req, res) => {
  try {
    const asset = await retranscribeAsset(req.params.assetId, {
      language: req.body?.language || 'Chinese',
      ownerId: req.auth?.userId || ''
    });
    res.json({ success: true, asset });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/assets/:assetId/segments', async (req, res) => {
  try {
    const segments = await listAssetSegments(req.params.assetId);
    res.json({ success: true, segments });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/assets/:assetId/words', async (req, res) => {
  try {
    const words = await listAssetWords(req.params.assetId, {
      projectId: String(req.query?.projectId || '').trim()
    });
    res.json({ success: true, words });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/assets/:assetId/projects/:projectId', async (req, res) => {
  try {
    const project = await getOwnedProjectById(req.params.projectId, req.auth?.userId || '');
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    await addAssetToProject(req.params.projectId, req.params.assetId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
