import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { withDatabase } from '../core/database.service.js';
import { createJob, markJobRunning, updateJobProgress, completeJob, failJob } from '../core/job.service.js';
import { copyExternalAssetFile, moveUploadedAssetFile } from '../core/storage.service.js';
import { runAsrPipeline } from '../editor/asr.service.js';

function flattenWords(asrResult = {}) {
  if (Array.isArray(asrResult.words)) return asrResult.words;
  if (Array.isArray(asrResult.segments)) {
    return asrResult.segments.flatMap((segment) => segment?.words || []);
  }
  return [];
}

function mapAssetSummary(asset) {
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
    mime_type: asset.mimeType || '',
    created_at: asset.createdAt,
    source_url: originalFile ? `/api/library/assets/${asset.id}/source` : null
  };
}

function probeMediaInfo(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (error, metadata) => {
      if (error) {
        reject(error);
        return;
      }

      const videoStream = metadata?.streams?.find((stream) => stream.codec_type === 'video');
      resolve({
        durationSeconds: Number(metadata?.format?.duration || 0),
        width: Number(videoStream?.width || 0) || null,
        height: Number(videoStream?.height || 0) || null,
        frameRate: parseFrameRate(videoStream?.avg_frame_rate || videoStream?.r_frame_rate),
        raw: metadata
      });
    });
  });
}

function parseFrameRate(rawValue) {
  if (!rawValue) return null;
  if (typeof rawValue === 'number') return rawValue > 0 ? rawValue : null;
  if (typeof rawValue === 'string' && rawValue.includes('/')) {
    const [num, den] = rawValue.split('/').map(Number);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
      return Number((num / den).toFixed(3));
    }
  }
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function inferMimeTypeFromFilename(filename = '') {
  const ext = path.extname(filename || '').toLowerCase();
  switch (ext) {
    case '.mov':
      return 'video/quicktime';
    case '.mkv':
      return 'video/x-matroska';
    case '.webm':
      return 'video/webm';
    case '.avi':
      return 'video/x-msvideo';
    case '.m4v':
      return 'video/x-m4v';
    case '.mp4':
    default:
      return 'video/mp4';
  }
}

async function parseUploadedJson(jsonFile) {
  if (!jsonFile) return null;
  const content = await fs.promises.readFile(jsonFile.path, 'utf-8');
  const data = JSON.parse(content);
  await fs.promises.unlink(jsonFile.path).catch(() => {});
  return data?.asr_result || data;
}

async function updateAssetFromAsr(db, assetId, asrResult, mediaInfo) {
  const transcriptText = asrResult?.text || flattenWords(asrResult).map((word) => word.text || '').join('');

  await db.caption.deleteMany({
    where: {
      assetId,
      kind: 'word_timeline'
    }
  });

  await db.caption.create({
    data: {
      assetId,
      kind: 'word_timeline',
      language: asrResult?.language || 'Chinese',
      text: transcriptText,
      payload: asrResult
    }
  });

  return db.asset.update({
    where: { id: assetId },
    data: {
      status: 'ready',
      asrStatus: 'completed',
      durationSeconds: Number(asrResult?.duration || mediaInfo?.durationSeconds || 0),
      width: mediaInfo?.width || null,
      height: mediaInfo?.height || null,
      frameRate: mediaInfo?.frameRate || null,
      transcriptText,
      metadata: mediaInfo?.raw || null
    },
    include: {
      files: true,
      captions: {
        orderBy: { createdAt: 'desc' },
        take: 1
      }
    }
  });
}

async function ingestAsset(assetId, sourcePath, { language = 'Chinese', jsonFile = null } = {}) {
  return processAssetAsr(assetId, sourcePath, {
    language,
    jsonFile,
    jobType: 'asset.ingest'
  });
}

function queueAssetIngest(assetId, sourcePath, { language = 'Chinese', jsonFile = null } = {}) {
  Promise.resolve()
    .then(() => ingestAsset(assetId, sourcePath, { language, jsonFile }))
    .catch((error) => {
      console.error(`[asset-ingest] ${assetId} failed:`, error);
    });
}

async function processAssetAsr(assetId, sourcePath, { language = 'Chinese', jsonFile = null, jobType = 'asset.ingest' } = {}) {
  const job = await createJob({
    type: jobType,
    payload: { assetId, sourcePath, language },
    assetId
  });

  try {
    await markJobRunning(job.id, 'Probing media');
    const mediaInfo = await probeMediaInfo(sourcePath);
    await updateJobProgress(job.id, 25, 'Running ASR');

    const uploadedJson = await parseUploadedJson(jsonFile);
    const asrResult = uploadedJson || await runAsrPipeline(sourcePath, language);

    await updateJobProgress(job.id, 80, 'Persisting captions');

    const updatedAsset = await withDatabase((db) => updateAssetFromAsr(db, assetId, asrResult, mediaInfo));

    await completeJob(job.id, { assetId }, 'Asset ready');
    return mapAssetSummary(updatedAsset);
  } catch (error) {
    await failJob(job.id, error);
    await withDatabase((db) => db.asset.update({
      where: { id: assetId },
      data: {
        status: 'failed',
        asrStatus: 'failed'
      }
    }));
    throw error;
  }
}

export async function createAssetFromUpload(file, { title = '', language = 'Chinese', jsonFile = null } = {}) {
  const originalFilename = file.originalname || 'uploaded-video.mp4';

  const created = await withDatabase((db) => db.asset.create({
    data: {
      title: String(title || '').trim() || path.basename(originalFilename, path.extname(originalFilename)),
      originalFilename,
      mimeType: file.mimetype || 'video/mp4',
      kind: 'video',
      status: 'processing',
      asrStatus: jsonFile ? 'provided' : 'processing'
    }
  }));

  const stored = await moveUploadedAssetFile(file.path, created.id, originalFilename);

  await withDatabase((db) => db.assetFile.create({
    data: {
      assetId: created.id,
      role: stored.role,
      storageKey: stored.storageKey,
      uri: stored.uri,
      mimeType: file.mimetype || 'video/mp4',
      sizeBytes: BigInt(file.size || 0)
    }
  }));

  queueAssetIngest(created.id, stored.uri, { language, jsonFile });

  return withDatabase((db) => db.asset.findUnique({
    where: { id: created.id },
    include: {
      files: true,
      captions: {
        orderBy: { createdAt: 'desc' },
        take: 1
      }
    }
  })).then(mapAssetSummary);
}

export async function createAssetFromSourceFile(sourcePath, {
  title = '',
  originalFilename = '',
  language = 'Chinese',
  jsonData = null,
  waitForAsr = true
} = {}) {
  const resolvedFilename = originalFilename || path.basename(sourcePath || '') || 'imported-video.mp4';
  const mimeType = inferMimeTypeFromFilename(resolvedFilename);

  const created = await withDatabase((db) => db.asset.create({
    data: {
      title: String(title || '').trim() || path.basename(resolvedFilename, path.extname(resolvedFilename)),
      originalFilename: resolvedFilename,
      mimeType,
      kind: 'video',
      status: 'processing',
      asrStatus: jsonData ? 'provided' : 'processing'
    }
  }));

  const stored = await copyExternalAssetFile(sourcePath, created.id, resolvedFilename);

  const stats = await fs.promises.stat(sourcePath);
  await withDatabase((db) => db.assetFile.create({
    data: {
      assetId: created.id,
      role: stored.role,
      storageKey: stored.storageKey,
      uri: stored.uri,
      mimeType,
      sizeBytes: BigInt(stats.size || 0)
    }
  }));

  if (jsonData) {
    const mediaInfo = await probeMediaInfo(stored.uri);
    const updated = await withDatabase((db) => updateAssetFromAsr(db, created.id, jsonData, mediaInfo));
    return mapAssetSummary(updated);
  }

  if (waitForAsr) {
    return ingestAsset(created.id, stored.uri, { language });
  }

  queueAssetIngest(created.id, stored.uri, { language });
  return withDatabase((db) => db.asset.findUnique({
    where: { id: created.id },
    include: {
      files: true,
      captions: {
        orderBy: { createdAt: 'desc' },
        take: 1
      }
    }
  })).then(mapAssetSummary);
}

export async function retranscribeAsset(assetId, { language = 'Chinese' } = {}) {
  const asset = await withDatabase((db) => db.asset.findUnique({
    where: { id: assetId },
    include: {
      files: true,
      captions: {
        orderBy: { createdAt: 'desc' },
        take: 1
      }
    }
  }));

  if (!asset) {
    throw new Error(`Asset not found: ${assetId}`);
  }

  const originalFile = asset.files?.find((file) => file.role === 'original') || asset.files?.[0] || null;
  if (!originalFile?.uri) {
    throw new Error(`Original source file not found for asset: ${assetId}`);
  }

  await withDatabase((db) => db.asset.update({
    where: { id: assetId },
    data: {
      status: 'processing',
      asrStatus: 'processing'
    }
  }));

  const inferredLanguage = language || asset.captions?.[0]?.language || 'Chinese';
  return processAssetAsr(assetId, originalFile.uri, {
    language: inferredLanguage,
    jobType: 'asset.retranscribe'
  });
}

export async function retranscribeAllAssets({ language = 'Chinese' } = {}) {
  const assets = await withDatabase((db) => db.asset.findMany({
    where: { kind: 'video' },
    include: {
      files: true,
      captions: {
        orderBy: { createdAt: 'desc' },
        take: 1
      }
    },
    orderBy: { createdAt: 'asc' }
  }));

  const results = [];
  for (const asset of assets) {
    const originalFile = asset.files?.find((file) => file.role === 'original') || asset.files?.[0] || null;
    if (!originalFile?.uri) {
      results.push({
        assetId: asset.id,
        title: asset.title,
        success: false,
        error: 'Original source file not found'
      });
      continue;
    }

    try {
      const updated = await retranscribeAsset(asset.id, {
        language: language || asset.captions?.[0]?.language || 'Chinese'
      });
      results.push({
        assetId: asset.id,
        title: updated.title,
        success: true
      });
    } catch (error) {
      results.push({
        assetId: asset.id,
        title: asset.title,
        success: false,
        error: error.message
      });
    }
  }

  return results;
}

export async function listAssets({ query = '' } = {}) {
  return withDatabase(async (db) => {
    const assets = await db.asset.findMany({
      where: {
        kind: 'video',
        ...(query
          ? {
              OR: [
                { title: { contains: query, mode: 'insensitive' } },
                { originalFilename: { contains: query, mode: 'insensitive' } },
                { transcriptText: { contains: query, mode: 'insensitive' } }
              ]
            }
          : {})
      },
      include: {
        files: true
      },
      orderBy: { createdAt: 'desc' }
    });

    return assets.map(mapAssetSummary);
  });
}

export async function getAssetById(assetId) {
  return withDatabase(async (db) => {
    const asset = await db.asset.findUnique({
      where: { id: assetId },
      include: {
        files: true,
        captions: {
          orderBy: { createdAt: 'desc' }
        }
      }
    });

    if (!asset) return null;

    return {
      ...mapAssetSummary(asset),
      captions: asset.captions
    };
  });
}

export async function getAssetSourcePath(assetId) {
  return withDatabase(async (db) => {
    const file = await db.assetFile.findFirst({
      where: {
        assetId,
        role: 'original'
      }
    });

    return file?.uri || null;
  });
}
