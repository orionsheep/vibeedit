import { withDatabase } from './database.service.js';

export async function createJob({ type, payload, assetId = null, projectId = null, message = null }) {
  return withDatabase((db) => db.job.create({
    data: {
      type,
      payload,
      assetId,
      projectId,
      message
    }
  }));
}

export async function markJobRunning(jobId, message = null) {
  return withDatabase((db) => db.job.update({
    where: { id: jobId },
    data: {
      status: 'running',
      startedAt: new Date(),
      ...(message ? { message } : {})
    }
  }));
}

export async function updateJobProgress(jobId, progress, message = null) {
  return withDatabase((db) => db.job.update({
    where: { id: jobId },
    data: {
      progress: Math.max(0, Math.min(100, Number(progress || 0))),
      ...(message ? { message } : {})
    }
  }));
}

export async function completeJob(jobId, result = null, message = 'completed') {
  return withDatabase((db) => db.job.update({
    where: { id: jobId },
    data: {
      status: 'completed',
      progress: 100,
      result,
      message,
      finishedAt: new Date()
    }
  }));
}

export async function failJob(jobId, error) {
  return withDatabase((db) => db.job.update({
    where: { id: jobId },
    data: {
      status: 'failed',
      message: error?.message || String(error || 'Unknown error'),
      finishedAt: new Date()
    }
  }));
}

export async function listJobsByProject(projectId) {
  return withDatabase(async (db) => {
    const assetRelations = await db.projectAsset.findMany({
      where: { projectId },
      select: { assetId: true }
    });

    const assetIds = assetRelations.map((item) => item.assetId);

    return db.job.findMany({
      where: {
        OR: [
          { projectId },
          assetIds.length ? { assetId: { in: assetIds } } : undefined
        ].filter(Boolean)
      },
      orderBy: { createdAt: 'desc' },
      take: 100
    });
  });
}
