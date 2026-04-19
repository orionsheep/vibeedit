import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { withDatabase } from '../core/database.service.js';
import { createJob, markJobRunning, updateJobProgress, completeJob, failJob } from '../core/job.service.js';
import { copyExternalAssetFile, moveUploadedAssetFile } from '../core/storage.service.js';
import { loadConfig } from '../editor/config.js';
import { runAsrPipeline } from '../editor/asr.service.js';
import { createSignedAssetSourceToken } from '../auth/auth.service.js';

const RECOVERABLE_ASSET_JOB_TYPES = new Set(['asset.ingest', 'asset.retranscribe']);
const ACTIVE_ASSET_JOB_IDS = new Set();

function flattenWords(asrResult = {}) {
  if (Array.isArray(asrResult.words)) return asrResult.words;
  if (Array.isArray(asrResult.segments)) {
    return asrResult.segments.flatMap((segment) => segment?.words || []);
  }
  return [];
}

function mapAssetSummary(asset) {
  const originalFile = asset.files?.find((file) => file.role === 'original') || asset.files?.[0] || null;
  const ingestJob = asset.jobs?.[0] || null;
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
    source_url: originalFile ? `/api/library/assets/${asset.id}/source` : null,
    ingest_job: ingestJob ? {
      id: ingestJob.id,
      type: ingestJob.type,
      status: ingestJob.status,
      progress: Number(ingestJob.progress || 0),
      message: ingestJob.message || '',
      created_at: ingestJob.createdAt,
      started_at: ingestJob.startedAt,
      finished_at: ingestJob.finishedAt
    } : null
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

async function createAssetAsrJob(assetId, sourcePath, { language = 'Chinese', uploadedJson = null, jobType = 'asset.ingest' } = {}) {
  return createJob({
    type: jobType,
    payload: {
      assetId,
      sourcePath,
      language,
      uploadedJson
    },
    assetId,
    message: 'Queued for ASR'
  });
}

function queueAssetJob(jobId) {
  if (!jobId || ACTIVE_ASSET_JOB_IDS.has(jobId)) return;
  ACTIVE_ASSET_JOB_IDS.add(jobId);
  Promise.resolve()
    .then(() => processAssetJob(jobId))
    .catch((error) => {
      console.error(`[asset-job] ${jobId} failed:`, error);
    })
    .finally(() => {
      ACTIVE_ASSET_JOB_IDS.delete(jobId);
    });
}

async function enqueueAssetAsr(assetId, sourcePath, { language = 'Chinese', uploadedJson = null, jobType = 'asset.ingest' } = {}) {
  const job = await createAssetAsrJob(assetId, sourcePath, { language, uploadedJson, jobType });
  queueAssetJob(job.id);
  return job;
}

async function processAssetJob(jobId) {
  const job = await withDatabase((db) => db.job.findUnique({
    where: { id: jobId }
  }));

  if (!job) {
    throw new Error(`Asset job not found: ${jobId}`);
  }

  if (!RECOVERABLE_ASSET_JOB_TYPES.has(String(job.type || '').trim())) {
    throw new Error(`Unsupported asset job type: ${job.type}`);
  }

  if (['completed', 'failed'].includes(String(job.status || '').trim())) {
    return null;
  }

  const payload = job.payload || {};
  const assetId = String(payload.assetId || job.assetId || '').trim();
  const sourcePath = String(payload.sourcePath || '').trim();
  const language = String(payload.language || 'Chinese').trim() || 'Chinese';
  const uploadedJson = payload.uploadedJson || null;

  if (!assetId || !sourcePath) {
    await failJob(job.id, new Error('Asset job payload is missing assetId or sourcePath'));
    throw new Error('Asset job payload is missing assetId or sourcePath');
  }

  try {
    await withDatabase((db) => db.asset.update({
      where: { id: assetId },
      data: {
        status: 'processing',
        asrStatus: uploadedJson ? 'provided' : 'processing'
      }
    }));

    await markJobRunning(job.id, 'Probing media');
    await fs.promises.access(sourcePath, fs.constants.R_OK);
    const mediaInfo = await probeMediaInfo(sourcePath);
    await updateJobProgress(job.id, 25, 'Running ASR');

    const asrInput = uploadedJson ? sourcePath : resolveAsrInput(assetId, sourcePath);
    const asrResult = uploadedJson || await runAsrPipeline(asrInput, language);

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

async function runAssetAsr(assetId, sourcePath, { language = 'Chinese', uploadedJson = null, jobType = 'asset.ingest' } = {}) {
  const job = await createAssetAsrJob(assetId, sourcePath, { language, uploadedJson, jobType });
  return processAssetJob(job.id);
}

function resolveAsrInput(assetId, sourcePath) {
  const config = loadConfig();
  if (String(config.asr_provider || '').trim().toLowerCase() !== 'qwen_filetrans') {
    return sourcePath;
  }

  const publicBaseUrl = String(config.public_base_url || '').trim().replace(/\/+$/, '');
  if (!publicBaseUrl) {
    throw new Error('public_base_url is required when asr_provider is qwen_filetrans');
  }

  const token = createSignedAssetSourceToken(assetId);
  return `${publicBaseUrl}/api/library/assets/${encodeURIComponent(assetId)}/source?token=${encodeURIComponent(token)}`;
}

export async function createAssetFromUpload(file, { title = '', language = 'Chinese', jsonFile = null, ownerId = '' } = {}) {
  const originalFilename = file.originalname || 'uploaded-video.mp4';
  const uploadedJson = await parseUploadedJson(jsonFile);

  const created = await withDatabase((db) => db.asset.create({
    data: {
      ownerId: String(ownerId || '').trim() || null,
      title: String(title || '').trim() || path.basename(originalFilename, path.extname(originalFilename)),
      originalFilename,
      mimeType: file.mimetype || 'video/mp4',
      kind: 'video',
      status: 'processing',
      asrStatus: uploadedJson ? 'provided' : 'processing'
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

  await enqueueAssetAsr(created.id, stored.uri, { language, uploadedJson, jobType: 'asset.ingest' });

  return withDatabase((db) => db.asset.findUnique({
    where: { id: created.id },
    include: {
      files: true,
      jobs: {
        where: {
          type: {
            in: [...RECOVERABLE_ASSET_JOB_TYPES]
          }
        },
        orderBy: { createdAt: 'desc' },
        take: 1
      },
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
  waitForAsr = true,
  ownerId = ''
} = {}) {
  const resolvedFilename = originalFilename || path.basename(sourcePath || '') || 'imported-video.mp4';
  const mimeType = inferMimeTypeFromFilename(resolvedFilename);

  const created = await withDatabase((db) => db.asset.create({
    data: {
      ownerId: String(ownerId || '').trim() || null,
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
    return runAssetAsr(created.id, stored.uri, { language, jobType: 'asset.ingest' });
  }

  await enqueueAssetAsr(created.id, stored.uri, { language, jobType: 'asset.ingest' });
  return withDatabase((db) => db.asset.findUnique({
    where: { id: created.id },
    include: {
      files: true,
      jobs: {
        where: {
          type: {
            in: [...RECOVERABLE_ASSET_JOB_TYPES]
          }
        },
        orderBy: { createdAt: 'desc' },
        take: 1
      },
      captions: {
        orderBy: { createdAt: 'desc' },
        take: 1
      }
    }
  })).then(mapAssetSummary);
}

export async function retranscribeAsset(assetId, { language = 'Chinese', ownerId = '' } = {}) {
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
  if (ownerId && String(asset.ownerId || '') !== String(ownerId || '')) {
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
  return runAssetAsr(assetId, originalFile.uri, {
    language: inferredLanguage,
    jobType: 'asset.retranscribe'
  });
}

export async function retranscribeAllAssets({ language = 'Chinese', ownerId = '' } = {}) {
  const assets = await withDatabase((db) => db.asset.findMany({
    where: {
      kind: 'video',
      ...(ownerId ? { ownerId: String(ownerId || '').trim() } : {})
    },
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
        language: language || asset.captions?.[0]?.language || 'Chinese',
        ownerId
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

export async function listAssets({ query = '', ownerId = '' } = {}) {
  return withDatabase(async (db) => {
    const assets = await db.asset.findMany({
      where: {
        kind: 'video',
        ...(ownerId ? { ownerId: String(ownerId || '').trim() } : {}),
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
        files: true,
        jobs: {
          where: {
            type: {
              in: [...RECOVERABLE_ASSET_JOB_TYPES]
            }
          },
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    return assets.map(mapAssetSummary);
  });
}

export async function getAssetById(assetId, ownerId = '') {
  return withDatabase(async (db) => {
    const asset = await db.asset.findUnique({
      where: { id: assetId },
      include: {
        files: true,
        jobs: {
          where: {
            type: {
              in: [...RECOVERABLE_ASSET_JOB_TYPES]
            }
          },
          orderBy: { createdAt: 'desc' },
          take: 1
        },
        captions: {
          orderBy: { createdAt: 'desc' }
        }
      }
    });

    if (!asset) return null;
    if (ownerId && String(asset.ownerId || '') !== String(ownerId || '')) return null;

    return {
      ...mapAssetSummary(asset),
      captions: asset.captions
    };
  });
}

export async function getAssetSourcePath(assetId, ownerId = '', { allowAny = false } = {}) {
  return withDatabase(async (db) => {
    if (!allowAny && ownerId) {
      const asset = await db.asset.findFirst({
        where: {
          id: assetId,
          ownerId: String(ownerId || '').trim()
        },
        select: { id: true }
      });
      if (!asset) return null;
    }

    const file = await db.assetFile.findFirst({
      where: {
        assetId,
        role: 'original'
      }
    });

    return file?.uri || null;
  });
}

export async function recoverPendingAssetJobs() {
  const jobs = await withDatabase((db) => db.job.findMany({
    where: {
      type: {
        in: [...RECOVERABLE_ASSET_JOB_TYPES]
      },
      status: {
        in: ['queued', 'running']
      }
    },
    orderBy: { createdAt: 'asc' }
  }));

  jobs.forEach((job) => {
    queueAssetJob(job.id);
  });

  return jobs.length;
}
