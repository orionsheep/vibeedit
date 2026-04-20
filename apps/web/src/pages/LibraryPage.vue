<template>
  <div class="library-page">
    <section class="hero">
      <div class="hero-copy">
        <div class="eyebrow">LIBRARY</div>
        <h1>全局素材库</h1>
        <p>素材先进入素材库，再被引用到某个项目。这里管理上传、检索和分发到项目。</p>
        <div class="hero-stats">
          <span>{{ assets.length }} 条素材</span>
          <span>{{ selectedProjectId ? '已选择项目' : '未选择项目' }}</span>
          <span>状态自动跟踪上传与转写</span>
        </div>
      </div>
      <div class="hero-side">
        <div class="hero-side-title">素材主线</div>
        <ul>
          <li>上传后先进入全局素材库。</li>
          <li>项目只是引用素材，不复制底层视频。</li>
          <li>转写状态和源文件访问都在这里统一管理。</li>
        </ul>
        <router-link class="ghost-link" to="/projects">返回项目列表</router-link>
      </div>
    </section>

    <section class="upload-card">
      <div class="upload-top">
        <div>
          <h2>导入素材</h2>
          <p>支持多文件上传，导入后自动进入转写流程。</p>
        </div>
        <span class="progress-chip" v-if="uploading">{{ uploadProgress }}%</span>
      </div>
      <form class="upload-form" @submit.prevent="handleUpload">
        <input ref="fileInputRef" type="file" accept="video/*,.mp4,.mov,.m4v,.mkv,.webm" multiple @change="handleFileSelect" />
        <select v-model="language">
          <option value="Chinese">Chinese</option>
          <option value="English">English</option>
          <option value="">Auto</option>
        </select>
        <button class="btn-primary" type="submit" :disabled="!selectedFiles.length || uploading">
          {{ uploading ? '上传中...' : `上传 ${selectedFiles.length || ''} 个素材` }}
        </button>
      </form>
      <div class="selected-files" v-if="selectedFiles.length">
        <span v-for="file in selectedFiles" :key="file.name">{{ file.name }}</span>
      </div>
    </section>

    <section class="toolbar">
      <input v-model="search" type="text" placeholder="搜索素材标题、文件名、字幕内容" />
      <select v-model="selectedProjectId">
        <option value="">选择项目后可一键加入</option>
        <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option>
      </select>
      <button class="ghost-link button-like" @click="loadAssets">刷新</button>
    </section>

    <section class="asset-grid">
      <article v-for="asset in assets" :key="asset.id" class="asset-card">
        <div class="asset-card-top">
          <div>
            <div class="asset-title">{{ asset.title }}</div>
            <div class="asset-meta">
              <span>{{ formatDuration(asset.duration_seconds) }}</span>
              <span>{{ asset.status }}</span>
              <span>{{ asset.asr_status }}</span>
            </div>
            <div v-if="asset.ingest_job" class="asset-job" :class="`status-${asset.ingest_job.status}`">
              <span>{{ formatJobLabel(asset.ingest_job) }}</span>
              <span v-if="Number(asset.ingest_job.progress || 0) > 0">{{ asset.ingest_job.progress }}%</span>
              <span v-if="asset.ingest_job.message">{{ asset.ingest_job.message }}</span>
            </div>
          </div>
          <a class="chip-link" :href="asset.source_url" target="_blank" rel="noopener">源文件</a>
        </div>
        <p class="asset-desc">{{ asset.transcript_text || '还没有可用的字幕摘要。' }}</p>
        <div class="asset-actions">
          <button class="ghost-link button-like" :disabled="!selectedProjectId" @click="handleAddToProject(asset.id)">
            加入项目
          </button>
        </div>
      </article>
    </section>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { listProjects } from '../features/projects/api/projectsApi';
import { addLibraryAssetToProject, listLibraryAssets, uploadLibraryAssets } from '../features/library/api/libraryApi';

const assets = ref([]);
const projects = ref([]);
const selectedFiles = ref([]);
const language = ref('Chinese');
const uploading = ref(false);
const uploadProgress = ref(0);
const selectedProjectId = ref('');
const search = ref('');
const fileInputRef = ref(null);
const assetPollTimer = ref(null);
const assetsLoading = ref(false);
let assetSearchTimer = 0;
let assetRequestSequence = 0;
let activeAssetRequestController = null;

function hasActiveIngest(asset) {
  const asrStatus = String(asset?.asr_status || '').trim();
  const jobStatus = String(asset?.ingest_job?.status || '').trim();
  return ['processing', 'pending', 'provided'].includes(asrStatus) || ['queued', 'running'].includes(jobStatus);
}

function syncAssetPolling() {
  const shouldPoll = assets.value.some((asset) => hasActiveIngest(asset));
  clearAssetPollTimer();
  if (!shouldPoll) return;
  assetPollTimer.value = window.setTimeout(() => {
    loadAssets({ reason: 'poll' }).catch(() => {});
  }, assetsLoading.value ? 5500 : 4000);
}

function clearAssetPollTimer() {
  if (assetPollTimer.value) {
    clearTimeout(assetPollTimer.value);
    assetPollTimer.value = null;
  }
}

function clearAssetSearchTimer() {
  if (assetSearchTimer) {
    clearTimeout(assetSearchTimer);
    assetSearchTimer = 0;
  }
}

function cancelActiveAssetRequest() {
  if (activeAssetRequestController) {
    activeAssetRequestController.abort();
    activeAssetRequestController = null;
  }
}

async function loadAssets({ reason = 'manual' } = {}) {
  const requestId = ++assetRequestSequence;
  cancelActiveAssetRequest();
  const controller = new AbortController();
  activeAssetRequestController = controller;
  assetsLoading.value = true;

  try {
    const nextAssets = await listLibraryAssets(search.value.trim(), { signal: controller.signal });
    if (requestId !== assetRequestSequence) {
      return;
    }
    assets.value = nextAssets;
  } catch (error) {
    if (error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED') {
      return;
    }
    throw error;
  } finally {
    if (requestId === assetRequestSequence) {
      assetsLoading.value = false;
      activeAssetRequestController = null;
      syncAssetPolling();
    } else if (activeAssetRequestController === controller) {
      activeAssetRequestController = null;
    }
  }
}

async function loadProjects() {
  projects.value = await listProjects();
}

function handleFileSelect(event) {
  selectedFiles.value = Array.from(event.target.files || []);
}

async function handleUpload() {
  if (!selectedFiles.value.length) return;
  uploading.value = true;
  uploadProgress.value = 0;

  try {
    const formData = new FormData();
    selectedFiles.value.forEach((file) => formData.append('videos', file));
    if (language.value) {
      formData.append('language', language.value);
    }

    await uploadLibraryAssets(formData, (event) => {
      if (!event?.total) return;
      uploadProgress.value = Math.round((event.loaded / event.total) * 100);
    });

    selectedFiles.value = [];
    if (fileInputRef.value) {
      fileInputRef.value.value = '';
    }
    await loadAssets();
  } finally {
    uploading.value = false;
  }
}

async function handleAddToProject(assetId) {
  if (!selectedProjectId.value) return;
  await addLibraryAssetToProject(assetId, selectedProjectId.value);
}

function formatJobLabel(job = {}) {
  const type = String(job.type || '').trim();
  if (type === 'asset.retranscribe') return '重转写';
  return '上传转写';
}

function formatDuration(seconds) {
  const safe = Number(seconds || 0);
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

watch(search, () => {
  clearAssetSearchTimer();
  assetSearchTimer = window.setTimeout(() => {
    loadAssets({ reason: 'search' }).catch(() => {});
  }, 260);
});

onMounted(async () => {
  await Promise.all([loadAssets(), loadProjects()]);
});

onUnmounted(() => {
  clearAssetPollTimer();
  clearAssetSearchTimer();
  cancelActiveAssetRequest();
});
</script>

<style scoped>
.library-page {
  max-width: 1320px;
  margin: 0 auto;
  display: grid;
  gap: 20px;
}

.hero,
.upload-card,
.asset-card,
.toolbar {
  border: 1px solid var(--app-border);
  background: linear-gradient(180deg, rgba(14, 23, 33, 0.98), rgba(9, 16, 24, 0.96));
  box-shadow: var(--app-shadow);
}

.hero {
  padding: 28px;
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(280px, 0.9fr);
  gap: 22px;
}

.eyebrow {
  color: var(--app-accent-strong);
  font-size: 12px;
  letter-spacing: 0.14em;
  margin-bottom: 8px;
  font-family: var(--font-mono);
}

h1 {
  font-size: 40px;
  margin-bottom: 10px;
  letter-spacing: -0.03em;
}

.hero p {
  color: var(--app-copy-muted);
  line-height: 1.7;
}

.hero-copy {
  display: grid;
  gap: 14px;
}

.hero-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.hero-stats span,
.progress-chip {
  border: 1px solid rgba(88, 219, 255, 0.16);
  background: rgba(10, 18, 27, 0.82);
  color: var(--app-copy);
  padding: 8px 11px;
  font-size: 12px;
}

.hero-side {
  border: 1px solid rgba(88, 219, 255, 0.16);
  background: rgba(8, 16, 25, 0.8);
  padding: 18px;
  display: grid;
  gap: 14px;
  align-content: start;
}

.hero-side-title {
  color: var(--app-copy-soft);
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.hero-side ul {
  padding-left: 18px;
  color: var(--app-copy);
  line-height: 1.65;
}

.ghost-link,
.chip-link,
.button-like,
.btn-primary {
  text-decoration: none;
  border: 1px solid var(--app-border-strong);
  background: rgba(10, 18, 27, 0.92);
  color: var(--app-copy);
  padding: 10px 12px;
  cursor: pointer;
  transition: 0.18s ease;
}

.ghost-link:hover,
.chip-link:hover,
.button-like:hover {
  border-color: rgba(88, 219, 255, 0.32);
  color: var(--app-accent-strong);
}

.btn-primary {
  background: linear-gradient(135deg, #58dbff, #7fe9ff);
  border-color: transparent;
  color: #071018;
  font-weight: 700;
}

.upload-card {
  padding: 22px;
  display: grid;
  gap: 12px;
}

.upload-top,
.toolbar,
.asset-card-top,
.asset-actions {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
}

.upload-top p {
  margin-top: 5px;
  color: var(--app-copy-muted);
}

.upload-form,
.toolbar {
  display: grid;
  grid-template-columns: 1.4fr 220px auto;
  gap: 12px;
}

.upload-form input,
.upload-form select,
.toolbar input,
.toolbar select {
  height: 42px;
  border: 1px solid var(--app-border-strong);
  background: rgba(8, 15, 23, 0.92);
  color: var(--app-copy);
  padding: 0 12px;
}

.selected-files {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.selected-files span {
  border: 1px solid rgba(88, 219, 255, 0.14);
  background: rgba(9, 17, 25, 0.72);
  padding: 6px 9px;
  font-size: 13px;
}

.asset-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.asset-card {
  padding: 20px;
  display: grid;
  gap: 12px;
}

.asset-title {
  font-size: 18px;
  font-weight: 700;
}

.asset-meta {
  margin-top: 4px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--app-copy-soft);
  font-size: 13px;
}

.asset-job {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--app-copy-soft);
  font-size: 12px;
}

.asset-job.status-running,
.asset-job.status-queued {
  color: var(--app-accent-strong);
}

.asset-job.status-failed {
  color: var(--app-danger);
}

.asset-job.status-completed {
  color: var(--app-success);
}

.asset-desc {
  color: var(--app-copy);
  line-height: 1.6;
  min-height: 48px;
}

@media (max-width: 960px) {
  .hero,
  .upload-form,
  .toolbar,
  .asset-grid {
    grid-template-columns: 1fr;
  }
}
</style>
