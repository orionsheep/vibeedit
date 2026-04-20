<template>
  <div class="projects-page">
    <AppConfirmDialog
      :visible="confirmDialog.visible"
      :title="confirmDialog.title"
      :message="confirmDialog.message"
      :confirm-text="confirmDialog.confirmText"
      :cancel-text="confirmDialog.cancelText"
      :danger="confirmDialog.danger"
      @confirm="handleConfirmDialogConfirm"
      @cancel="closeConfirmDialog"
    />
    <section class="hero">
      <div class="hero-copy">
        <div class="eyebrow">PROJECTS</div>
        <h1>多视频项目工作区</h1>
        <p>先建项目，再把素材库里的视频加入项目，最后进入主时间线和 Agent 工作台。</p>
        <div class="hero-stats">
          <span>{{ projects.length }} 个项目</span>
          <span>{{ categories.length }} 个分类</span>
          <span>主流程：项目 → 素材库 → 工作台</span>
        </div>
      </div>
      <div class="hero-side">
        <div class="hero-side-title">工作方式</div>
        <ul>
          <li>项目负责组织素材、时间线和导出结果。</li>
          <li>素材库负责统一上传、检索和转写状态。</li>
          <li>工作台负责字幕编辑、Agent 操作和精确导出。</li>
        </ul>
        <router-link class="ghost-link" to="/library">打开素材库</router-link>
      </div>
    </section>

    <section class="create-card">
      <div class="card-head">
        <div>
          <h2>创建项目</h2>
          <p>用一个清晰的项目名，把后续的素材导入、直播切片和工程导出收进同一工作区。</p>
        </div>
        <span class="chip-label">{{ categories.length }} 个分类</span>
      </div>
      <form class="create-form" @submit.prevent="handleCreateProject">
        <input v-model="form.name" type="text" placeholder="项目名称" required />
        <input v-model="form.categoryName" type="text" list="category-options" placeholder="分类，例如：短视频 / 播客 / 课程" />
        <input v-model="form.description" type="text" placeholder="项目描述（可选）" />
        <button class="btn-primary" type="submit" :disabled="isCreating">{{ isCreating ? '创建中...' : '创建项目' }}</button>
      </form>
      <datalist id="category-options">
        <option v-for="category in categories" :key="category.id" :value="category.name"></option>
      </datalist>
      <div v-if="error" class="inline-error">{{ error }}</div>
    </section>

    <section class="project-grid">
      <article v-if="!projects.length" class="empty-card">
        <div class="empty-title">还没有项目</div>
        <p>先创建一个项目，再把素材库里的视频加入进来。之后所有的时间线、Agent 编辑和导出都会围绕这个项目展开。</p>
      </article>
      <article v-for="project in projects" :key="project.id" class="project-card">
        <div class="project-top">
          <div>
            <div class="project-name">{{ project.name }}</div>
            <div class="project-meta">
              <span>{{ project.category || '未分类' }}</span>
              <span>{{ project.asset_count }} 个素材</span>
            </div>
          </div>
          <div class="project-actions">
            <button
              class="chip-link danger-chip"
              type="button"
              :disabled="deletingProjectId === project.id"
              @click="handleDeleteProject(project)"
            >
              {{ deletingProjectId === project.id ? '删除中...' : '删除项目' }}
            </button>
            <router-link class="chip-link" :to="`/projects/${project.id}/edit`">进入工作台</router-link>
          </div>
        </div>
        <p class="project-desc">{{ project.description || '这个项目还没有填写描述。' }}</p>
        <div class="project-footer">
          <span>最近打开：{{ formatDate(project.last_opened_at || project.updated_at) }}</span>
        </div>
      </article>
    </section>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import AppConfirmDialog from '../components/AppConfirmDialog.vue';
import { createProject, deleteProject, listProjectCategories, listProjects } from '../features/projects/api/projectsApi';

const projects = ref([]);
const categories = ref([]);
const error = ref('');
const isCreating = ref(false);
const deletingProjectId = ref('');
const confirmDialog = ref({
  visible: false,
  title: '',
  message: '',
  confirmText: '确认',
  cancelText: '取消',
  danger: false
});
const form = ref({
  name: '',
  categoryName: '',
  description: ''
});
let confirmDialogAction = null;

async function loadData() {
  projects.value = await listProjects();
  categories.value = await listProjectCategories();
}

async function handleCreateProject() {
  error.value = '';
  isCreating.value = true;
  try {
    const project = await createProject(form.value);
    form.value = { name: '', categoryName: '', description: '' };
    projects.value = [project, ...projects.value];
    categories.value = await listProjectCategories();
  } catch (err) {
    error.value = err.response?.data?.error || err.message;
  } finally {
    isCreating.value = false;
  }
}

async function handleDeleteProject(project) {
  const projectName = String(project?.name || '这个项目').trim();
  openConfirmDialog({
    title: '删除项目',
    message: `确定要删除项目《${projectName}》吗？\n此操作不可恢复。`,
    confirmText: '删除项目',
    danger: true,
    onConfirm: async () => {
      deletingProjectId.value = project.id;
      try {
        await deleteProject(project.id);
        projects.value = projects.value.filter((item) => item.id !== project.id);
      } catch (err) {
        error.value = err.response?.data?.error || err.message;
      } finally {
        deletingProjectId.value = '';
      }
    }
  });
}

function openConfirmDialog(options = {}) {
  confirmDialogAction = typeof options.onConfirm === 'function' ? options.onConfirm : null;
  confirmDialog.value = {
    visible: true,
    title: options.title || '请确认',
    message: options.message || '确定继续吗？',
    confirmText: options.confirmText || '确认',
    cancelText: options.cancelText || '取消',
    danger: Boolean(options.danger)
  };
}

function closeConfirmDialog() {
  confirmDialog.value.visible = false;
  confirmDialogAction = null;
}

async function handleConfirmDialogConfirm() {
  const action = confirmDialogAction;
  closeConfirmDialog();
  if (action) {
    await action();
  }
}

function formatDate(value) {
  if (!value) return '刚刚';
  return new Date(value).toLocaleString();
}

onMounted(loadData);
</script>

<style scoped>
.projects-page {
  max-width: 1280px;
  margin: 0 auto;
  display: grid;
  gap: 20px;
}

.hero,
.create-card,
.project-card,
.empty-card {
  border: 1px solid var(--app-border);
  background: linear-gradient(180deg, rgba(14, 23, 33, 0.98), rgba(9, 16, 24, 0.96));
  box-shadow: var(--app-shadow);
}

.hero {
  padding: 28px;
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(280px, 0.9fr);
  gap: 22px;
  align-items: stretch;
}

.eyebrow {
  color: var(--app-accent-strong);
  font-size: 12px;
  letter-spacing: 0.14em;
  margin-bottom: 8px;
  font-family: var(--font-mono);
}

h1 {
  font-size: 42px;
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
.chip-label {
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
.chip-link {
  color: var(--app-copy);
  text-decoration: none;
  border: 1px solid var(--app-border-strong);
  background: rgba(10, 18, 27, 0.92);
  padding: 10px 14px;
  transition: 0.18s ease;
}

.ghost-link:hover,
.chip-link:hover {
  border-color: rgba(88, 219, 255, 0.32);
  color: var(--app-accent-strong);
}

.create-card {
  padding: 22px;
  display: grid;
  gap: 14px;
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
}

.card-head p {
  margin-top: 6px;
  color: var(--app-copy-muted);
}

.create-form {
  display: grid;
  grid-template-columns: 1.2fr 0.8fr 1fr auto;
  gap: 12px;
}

.create-form input,
.btn-primary {
  height: 44px;
  border: 1px solid var(--app-border-strong);
  background: rgba(8, 15, 23, 0.92);
  color: var(--app-copy);
  padding: 0 12px;
}

.btn-primary {
  background: linear-gradient(135deg, #58dbff, #7fe9ff);
  border-color: transparent;
  color: #071018;
  font-weight: 700;
  cursor: pointer;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.24);
}

.project-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.empty-card,
.project-card {
  padding: 20px;
  display: grid;
  gap: 14px;
}

.empty-card {
  grid-column: 1 / -1;
}

.empty-title {
  font-size: 18px;
  font-weight: 700;
}

.empty-card p {
  color: var(--app-copy-muted);
  line-height: 1.7;
}

.project-top {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}

.project-actions {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.project-name {
  font-size: 20px;
  font-weight: 700;
}

.project-meta {
  display: flex;
  gap: 12px;
  color: var(--app-copy-soft);
  font-size: 13px;
  margin-top: 4px;
}

.project-desc {
  color: var(--app-copy);
  line-height: 1.6;
  min-height: 48px;
}

.project-footer {
  color: var(--app-copy-soft);
  font-size: 13px;
}

.inline-error {
  color: #ff9f9f;
}

.danger-chip {
  color: #ffb3bc;
  border-color: rgba(255, 135, 147, 0.28);
  background: rgba(52, 15, 22, 0.82);
  cursor: pointer;
}

.danger-chip:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

@media (max-width: 900px) {
  .create-form,
  .project-grid {
    grid-template-columns: 1fr;
  }

  .hero,
  .card-head,
  .project-top {
    grid-template-columns: 1fr;
    display: grid;
  }
}
</style>
