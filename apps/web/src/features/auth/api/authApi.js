import axios from 'axios';

const API_BASE = '/api/auth';

export async function fetchSession() {
  const response = await axios.get(`${API_BASE}/session`);
  return response.data;
}

export async function loginWithPassword(payload = {}) {
  const response = await axios.post(`${API_BASE}/login`, payload);
  return response.data;
}

export async function registerWithPassword(payload = {}) {
  const response = await axios.post(`${API_BASE}/register`, payload);
  return response.data;
}

export async function logoutSession() {
  const response = await axios.post(`${API_BASE}/logout`);
  return response.data;
}
