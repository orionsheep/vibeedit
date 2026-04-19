<template>
  <div class="home">
    <div class="intro">
      <div class="eyebrow">VIBEEDIT</div>
      <h2>快速导入素材，接入项目系统</h2>
      <p>这里不再直接把用户送进旧的单视频编辑页。上传后，素材会先进入素材库，再可选择挂到某个项目下，最后进入多视频工作台。</p>
    </div>

    <div class="panel">
      <h3>导入到素材库</h3>
      <form @submit.prevent="startUpload">
        <div class="upload-grid">
          <label class="upload-card" :class="{ active: uploadForm.video }">
            <span class="upload-label">视频素材</span>
            <span class="upload-value">
              {{ uploadForm.video ? uploadForm.video.name : '点击选择视频文件' }}
            </span>
            <input type="file" accept="video/*,.mp4,.mov,.m4v,.mkv,.webm" @change="handleVideoChange" required />
          </label>

          <label class="upload-card" :class="{ active: uploadForm.json }">
            <span class="upload-label">ASR JSON（可选）</span>
            <span class="upload-value">
              {{ uploadForm.json ? uploadForm.json.name : '可选上传现成时间线，跳过 ASR' }}
            </span>
            <input type="file" accept=".json,application/json" @change="handleJsonChange" />
          </label>
        </div>

        <div class="form-group">
          <label>识别语言</label>
          <select v-model="uploadForm.language">
            <option value="Chinese">Chinese</option>
            <option value="English">English</option>
            <option value="">Auto</option>
          </select>
        </div>

        <div class="project-grid">
          <div class="form-group">
            <label>加入已有项目（可选）</label>
            <select v-model="selectedProjectId">
              <option value="">仅导入素材库</option>
              <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option>
            </select>
          </div>

          <div class="form-group">
            <label>或新建项目（可选）</label>
            <input v-model="newProjectName" type="text" placeholder="例如：4月短视频精剪" />
          </div>
        </div>

        <div v-if="cutLoading" class="progress">
          <div class="progress-bar">
            <div class="progress-fill" :style="{ width: `${uploadProgress}%` }"></div>
          </div>
          <div class="progress-text">
            {{ uploadProgress > 0 ? `上传中 ${uploadProgress}%` : '服务处理中...' }}
          </div>
        </div>

        <div class="service-note">
          上传完成后，素材会先进入全局素材库；如果你选了项目，系统会自动把素材挂到该项目下并跳转到项目工作台。
        </div>

        <button type="submit" class="btn primary" :disabled="cutLoading">
          {{ cutLoading ? '处理中...' : '导入并进入工作流' }}
        </button>
      </form>

      <div v-if="cutResult" class="result">
        <p>{{ cutResult.message }}</p>
        <div class="result-actions">
          <button v-if="cutResult.project_id" @click="openProject" class="btn primary">打开项目工作台</button>
          <button @click="openLibrary" class="btn">打开素材库</button>
        </div>
      </div>

      <div v-if="cutError" class="error">{{ cutError }}</div>
    </div>
  </div>
</template>

<script>
import { uploadLibraryAssets, addLibraryAssetToProject } from '../features/library/api/libraryApi';
import { createProject, listProjects } from '../features/projects/api/projectsApi';

export default {
  data() {
    return {
      uploadForm: {
        video: null,
        json: null,
        language: 'Chinese'
      },
      projects: [],
      selectedProjectId: '',
      newProjectName: '',
      cutLoading: false,
      uploadProgress: 0,
      cutResult: null,
      cutError: null
    };
  },
  async mounted() {
    this.projects = await listProjects();
  },
  methods: {
    handleVideoChange(event) {
      this.uploadForm.video = event.target.files?.[0] || null;
    },
    handleJsonChange(event) {
      this.uploadForm.json = event.target.files?.[0] || null;
    },
    async startUpload() {
      if (!this.uploadForm.video) {
        this.cutError = '请先选择一个视频文件';
        return;
      }

      this.cutLoading = true;
      this.cutError = null;
      this.cutResult = null;
      this.uploadProgress = 0;

      try {
        const formData = new FormData();
        formData.append('video', this.uploadForm.video);
        if (this.uploadForm.json) {
          formData.append('json', this.uploadForm.json);
        }
        if (this.uploadForm.language) {
          formData.append('language', this.uploadForm.language);
        }

        const assets = await uploadLibraryAssets(formData, (event) => {
          if (!event?.total) return;
          this.uploadProgress = Math.min(100, Math.round((event.loaded / event.total) * 100));
        });

        let projectId = this.selectedProjectId;
        if (this.newProjectName.trim()) {
          const createdProject = await createProject({
            name: this.newProjectName.trim(),
            description: '从 dashboard 快速导入创建'
          });
          projectId = createdProject.id;
          this.projects = await listProjects();
        }

        if (projectId) {
          await Promise.all(assets.map((asset) => addLibraryAssetToProject(asset.id, projectId)));
        }

        this.cutResult = {
          asset_count: assets.length,
          project_id: projectId || '',
          message: projectId
            ? `已导入 ${assets.length} 个素材，并挂到项目中。`
            : `已导入 ${assets.length} 个素材到素材库。`
        };
        this.uploadProgress = 100;
        this.uploadForm.video = null;
        this.uploadForm.json = null;
        this.newProjectName = '';

        if (projectId) {
          this.$router.push(`/projects/${projectId}/edit`);
        } else {
          this.$router.push('/library');
        }
      } catch (e) {
        this.cutError = e.response?.data?.error || e.message;
      } finally {
        this.cutLoading = false;
      }
    },
    openProject() {
      if (this.cutResult?.project_id) {
        this.$router.push(`/projects/${this.cutResult.project_id}/edit`);
      }
    },
    openLibrary() {
      this.$router.push('/library');
    }
  }
};
</script>

<style scoped>
.home {
  max-width: 920px;
  margin: 0 auto;
}

.intro {
  margin-bottom: 18px;
}

.eyebrow {
  font-size: 12px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: #6fdde7;
  margin-bottom: 8px;
}

h2 {
  font-size: 28px;
  margin-bottom: 10px;
}

.intro p {
  color: #9cb0bc;
  line-height: 1.7;
}

.panel {
  background: #13181e;
  border: 1px solid #283342;
  padding: 24px;
}

.panel h3 {
  margin-bottom: 16px;
}

.upload-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 14px;
}

.upload-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px;
  background: #0b1015;
  border: 1px dashed #35506d;
  cursor: pointer;
}

.upload-card.active {
  border-style: solid;
  border-color: #00d4ff;
  background: #0d1821;
}

.upload-card input {
  display: none;
}

.upload-label {
  font-size: 13px;
  color: #8da4b7;
}

.upload-value {
  color: #f3f8fc;
  line-height: 1.6;
  word-break: break-word;
}

.form-group {
  margin-bottom: 14px;
}

.project-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.form-group label {
  display: block;
  margin-bottom: 6px;
  font-size: 14px;
  color: #9cb0bc;
}

.form-group select {
  width: 100%;
  padding: 11px 12px;
  background: #0b1015;
  border: 1px solid #283342;
  color: #fff;
}

.form-group input {
  width: 100%;
  padding: 11px 12px;
  background: #0b1015;
  border: 1px solid #283342;
  color: #fff;
}

.service-note {
  margin-bottom: 14px;
  padding: 12px;
  background: #0b1015;
  border: 1px solid #283342;
  color: #a3b7c8;
  line-height: 1.7;
}

.progress {
  margin-bottom: 14px;
}

.progress-bar {
  height: 8px;
  background: #0b1015;
  border: 1px solid #283342;
}

.progress-fill {
  height: 100%;
  background: #00d4ff;
}

.progress-text {
  margin-top: 8px;
  color: #8da4b7;
  font-size: 13px;
}

.btn {
  padding: 10px 16px;
  background: #171f28;
  border: 1px solid #283342;
  color: #fff;
  cursor: pointer;
}

.btn.primary {
  background: #00d4ff;
  border-color: #00d4ff;
  color: #081015;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.result {
  margin-top: 16px;
  padding: 12px;
  background: #13291d;
  border: 1px solid #25543a;
}

.result-actions {
  display: flex;
  gap: 10px;
  margin-top: 10px;
}

.error {
  margin-top: 16px;
  padding: 12px;
  background: #2a1616;
  border: 1px solid #5a2e2e;
  color: #ff9f9f;
}

@media (max-width: 760px) {
  .upload-grid,
  .project-grid {
    grid-template-columns: 1fr;
  }

  .result-actions {
    display: grid;
    grid-template-columns: 1fr;
  }
}
</style>
