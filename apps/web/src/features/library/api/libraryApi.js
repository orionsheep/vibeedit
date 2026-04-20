import axios from 'axios';

const API_BASE = '/api/library';

export async function listLibraryAssets(query = '', options = {}) {
  const response = await axios.get(`${API_BASE}/assets`, {
    params: query ? { q: query } : {},
    signal: options.signal
  });
  return response.data.assets || [];
}

export async function uploadLibraryAssets(formData, onUploadProgress) {
  const response = await axios.post(`${API_BASE}/assets/upload`, formData, {
    headers: {
      'Content-Type': 'multipart/form-data'
    },
    onUploadProgress
  });
  return response.data.assets || [];
}

export async function getLibraryAsset(assetId) {
  const response = await axios.get(`${API_BASE}/assets/${assetId}`);
  return response.data.asset;
}

export async function getLibraryAssetSegments(assetId) {
  const response = await axios.get(`${API_BASE}/assets/${assetId}/segments`);
  return response.data.segments || [];
}

export async function getLibraryAssetWords(assetId, projectId = '') {
  const response = await axios.get(`${API_BASE}/assets/${assetId}/words`, {
    params: projectId ? { projectId } : {}
  });
  return response.data.words || [];
}

export async function retranscribeLibraryAsset(assetId, payload = {}) {
  const response = await axios.post(`${API_BASE}/assets/${assetId}/retranscribe`, payload);
  return response.data.asset;
}

export async function addLibraryAssetToProject(assetId, projectId) {
  const response = await axios.post(`${API_BASE}/assets/${assetId}/projects/${projectId}`);
  return response.data;
}
