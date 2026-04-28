import axios from 'axios';

const API_BASE = '/api/projects';

export class ProjectAgentStreamError extends Error {
  constructor(message, { code = '', payload = {}, result = null } = {}) {
    super(message);
    this.name = 'ProjectAgentStreamError';
    this.code = code;
    this.payload = payload || {};
    this.result = result || null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function listProjects() {
  const response = await axios.get(API_BASE);
  return response.data.projects || [];
}

export async function listProjectCategories() {
  const response = await axios.get(`${API_BASE}/categories`);
  return response.data.categories || [];
}

export async function createProject(payload) {
  const response = await axios.post(API_BASE, payload);
  return response.data.project;
}

export async function getProject(projectId) {
  const response = await axios.get(`${API_BASE}/${projectId}`);
  return response.data.project;
}

export async function deleteProject(projectId) {
  const response = await axios.delete(`${API_BASE}/${projectId}`);
  return response.data.project;
}

export async function addAssetToProject(projectId, assetId) {
  const response = await axios.post(`${API_BASE}/${projectId}/assets`, { assetId });
  return response.data;
}

export async function uploadProjectAssets(projectId, formData, onUploadProgress) {
  const response = await axios.post(`${API_BASE}/${projectId}/assets/upload`, formData, {
    headers: {
      'Content-Type': 'multipart/form-data'
    },
    onUploadProgress
  });
  return {
    assets: response.data.assets || [],
    edit_state: response.data.edit_state,
    timeline: response.data.timeline
  };
}

export async function reorderProjectAssets(projectId, assetIds) {
  const response = await axios.put(`${API_BASE}/${projectId}/assets/order`, { assetIds });
  return response.data.project;
}

export async function removeProjectAsset(projectId, assetId) {
  const response = await axios.delete(`${API_BASE}/${projectId}/assets/${assetId}`);
  return response.data.project;
}

export async function getProjectTimeline(projectId) {
  const response = await axios.get(`${API_BASE}/${projectId}/timeline`);
  return response.data.timeline;
}

export async function getProjectEditState(projectId) {
  const response = await axios.get(`${API_BASE}/${projectId}/edit-state`);
  return response.data.edit_state;
}

export async function updateProjectEditState(projectId, payload) {
  const response = await axios.put(`${API_BASE}/${projectId}/edit-state`, payload);
  return {
    edit_state: response.data.edit_state,
    timeline: response.data.timeline
  };
}

export async function listProjectSnapshots(projectId) {
  const response = await axios.get(`${API_BASE}/${projectId}/timeline/snapshots`);
  return response.data.snapshots || [];
}

export async function getProjectSnapshot(projectId, snapshotId) {
  const response = await axios.get(`${API_BASE}/${projectId}/timeline/snapshots/${snapshotId}`);
  return response.data.snapshot;
}

export async function createProjectSnapshot(projectId, payload = {}) {
  const response = await axios.post(`${API_BASE}/${projectId}/timeline/snapshot`, payload);
  return response.data.snapshot;
}

export async function listProjectEditHistory(projectId, params = {}) {
  const response = await axios.get(`${API_BASE}/${projectId}/edit-history`, {
    params
  });
  return response.data.histories || [];
}

export async function appendTimelineClip(projectId, payload) {
  const response = await axios.post(`${API_BASE}/${projectId}/timeline/clips`, payload);
  return response.data.clip;
}

export async function updateProjectTimeline(projectId, clips) {
  const response = await axios.put(`${API_BASE}/${projectId}/timeline`, { clips });
  return response.data.timeline;
}

export async function deleteTimelineClip(projectId, clipId) {
  const response = await axios.delete(`${API_BASE}/${projectId}/timeline/clips/${clipId}`);
  return response.data.timeline;
}

export async function listProjectAgentSessions(projectId) {
  const response = await axios.get(`${API_BASE}/${projectId}/agent/sessions`);
  return response.data.sessions || [];
}

export async function createProjectAgentSession(projectId, payload = {}) {
  const response = await axios.post(`${API_BASE}/${projectId}/agent/sessions`, payload);
  return response.data.session;
}

export async function getProjectAgentSession(projectId, sessionId) {
  const response = await axios.get(`${API_BASE}/${projectId}/agent/sessions/${sessionId}`);
  return response.data.session;
}

export async function runProjectAgentWithProgress(projectId, sessionId, payload, onProgress, signal) {
  const response = await fetch(`${API_BASE}/${projectId}/agent/sessions/${sessionId}/runs/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload),
    signal
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Project agent failed' }));
    throw new ProjectAgentStreamError(error.error || 'Project agent failed', {
      code: error.code || '',
      payload: error.payload || {}
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';

      for (const event of events) {
        const lines = event.split('\n');
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = JSON.parse(line.slice(6));
          if (data.type === 'heartbeat') {
            continue;
          }
          if (onProgress) {
            onProgress(data);
          }
          if (data.type === 'result') {
            result = data.result;
          }
          if (data.type === 'error') {
            throw new ProjectAgentStreamError(data.message || 'Project agent failed', {
              code: data.code || '',
              payload: data.payload || {}
            });
          }
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return result;
}

export async function confirmProjectAgentRun(projectId, runId, approved = true) {
  const response = await axios.post(`${API_BASE}/${projectId}/agent/runs/${runId}/confirm`, {
    approved
  });
  return response.data;
}

export async function cancelProjectAgentRun(projectId, runId) {
  const response = await axios.post(`${API_BASE}/${projectId}/agent/runs/${runId}/cancel`);
  return response.data;
}

export async function listProjectAgentRunEvents(projectId, runId) {
  const response = await axios.get(`${API_BASE}/${projectId}/agent/runs/${runId}/events`);
  return response.data.events || [];
}

export async function listProjectJobs(projectId) {
  const response = await axios.get(`${API_BASE}/${projectId}/jobs`);
  return response.data.jobs || [];
}

export async function listProjectSlices(projectId) {
  const response = await axios.get(`${API_BASE}/${projectId}/slices`);
  return response.data.slices || [];
}

export async function getProjectSlice(projectId, sliceId) {
  const response = await axios.get(`${API_BASE}/${projectId}/slices/${sliceId}`);
  return response.data.slice;
}

export async function createProjectSlice(projectId, payload = {}) {
  const response = await axios.post(`${API_BASE}/${projectId}/slices`, payload);
  return response.data.slice;
}

export async function updateProjectSlice(projectId, sliceId, payload = {}) {
  const response = await axios.put(`${API_BASE}/${projectId}/slices/${sliceId}`, payload);
  return response.data.slice;
}

export async function deleteProjectSlice(projectId, sliceId) {
  const response = await axios.delete(`${API_BASE}/${projectId}/slices/${sliceId}`);
  return response.data.slice;
}

export async function suggestProjectSlices(projectId, payload = {}) {
  const response = await axios.post(`${API_BASE}/${projectId}/slices/suggest`, payload);
  return response.data;
}

export async function exportProjectVideo(projectId, payload = {}) {
  const response = await axios.post(`${API_BASE}/${projectId}/exports/video`, payload);
  return response.data;
}

export async function waitForProjectJob(projectId, jobId, {
  timeoutMs = 45 * 60 * 1000,
  pollMs = 1500,
  onProgress = null
} = {}) {
  const normalizedJobId = String(jobId || '').trim();
  if (!normalizedJobId) {
    throw new Error('缺少导出任务 ID');
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const jobs = await listProjectJobs(projectId);
    const job = jobs.find((entry) => String(entry.id || '') === normalizedJobId);

    if (job) {
      if (typeof onProgress === 'function') {
        onProgress(job);
      }
      if (String(job.status || '') === 'completed') {
        return job;
      }
      if (String(job.status || '') === 'failed') {
        throw new Error(job.message || '导出任务失败');
      }
    }

    await sleep(pollMs);
  }

  throw new Error('导出超时，请稍后重试');
}

export async function exportProjectInterchange(projectId, format, payload = {}) {
  const response = await axios.post(`${API_BASE}/${projectId}/exports/interchange`, { format, ...payload });
  return response.data;
}

export async function exportProjectSliceXmlBundle(projectId) {
  const response = await axios.post(`${API_BASE}/${projectId}/exports/live-slices/xml-bundle`);
  return response.data;
}
