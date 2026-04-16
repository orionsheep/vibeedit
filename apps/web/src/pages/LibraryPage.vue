<template>
  <div class="library-page">
    <section class="hero">
      <div>
        <div class="eyebrow">LIBRARY</div>
        <h1>全局素材库</h1>
        <p>素材先进入素材库，再被引用到某个项目。这里管理上传、检索和分发到项目。</p>
      </div>
      <router-link class="ghost-link" to="/projects">返回项目列表</router-link>
    </section>

    <section class="upload-card">
      <div class="upload-top">
        <h2>导入素材</h2>
        <span v-if="uploading">{{ uploadProgress }}%</span>
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
import { onMounted, ref, watch } from 'vue';
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

async function loadAssets() {
  assets.value = await listLibraryAssets(search.value.trim());
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

function formatDuration(seconds) {
  const safe = Number(seconds || 0);
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

watch(search, () => {
  loadAssets();
});

onMounted(async () => {
  await Promise.all([loadAssets(), loadProjects()]);
});
</script>

<style scoped>
.library-page {
  max-width: 1320px;
  margin: 0 auto;
  display: grid;
  gap: 18px;
}

.hero,
.upload-card,
.asset-card,
.toolbar {
  border: 1px solid #243140;
  background: #111821;
}

.hero {
  padding: 24px;
  display: flex;
  justify-content: space-between;
  gap: 16px;
}

.eyebrow {
  color: #73dce6;
  font-size: 12px;
  letter-spacing: 0.14em;
  margin-bottom: 8px;
}

h1 {
  font-size: 34px;
  margin-bottom: 8px;
}

.hero p {
  color: #97acbb;
  line-height: 1.7;
}

.ghost-link,
.chip-link,
.button-like,
.btn-primary {
  text-decoration: none;
  border: 1px solid #2f4050;
  background: #0f151d;
  color: #e9f6ff;
  padding: 10px 12px;
  cursor: pointer;
}

.btn-primary {
  background: #00d4ff;
  border-color: #00d4ff;
  color: #071018;
  font-weight: 700;
}

.upload-card {
  padding: 20px;
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
  border: 1px solid #2d3a47;
  background: #091018;
  color: #f2f6fb;
  padding: 0 12px;
}

.selected-files {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.selected-files span {
  border: 1px solid #30404e;
  padding: 6px 8px;
  font-size: 13px;
}

.asset-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.asset-card {
  padding: 18px;
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
  color: #87a0b3;
  font-size: 13px;
}

.asset-desc {
  color: #d4dfeb;
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
