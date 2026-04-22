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
      <div class="hero-main">
        <div class="hero-header">
          <div class="hero-copy">
            <div class="eyebrow">PROJECTS</div>
            <h1>多视频项目工作区</h1>
            <p>先建项目，再把素材库里的视频加入项目，最后进入主时间线和 Agent 工作台。这里更适合快速创建、继续编辑和集中管理多个视频项目。</p>
          </div>
          <router-link class="ghost-link hero-library-link" to="/library">打开素材库</router-link>
        </div>
        <div class="hero-stats">
          <article class="stat-panel">
            <span class="stat-label">项目数</span>
            <strong>{{ projects.length }}</strong>
            <span class="stat-meta">当前工作区</span>
          </article>
          <article class="stat-panel">
            <span class="stat-label">分类</span>
            <strong>{{ categories.length }}</strong>
            <span class="stat-meta">已建立标签</span>
          </article>
          <article class="stat-panel stat-panel-wide">
            <span class="stat-label">主流程</span>
            <strong>项目 → 素材库 → 工作台</strong>
            <span class="stat-meta">项目组织素材，工作台完成字幕、Agent 和导出。</span>
          </article>
        </div>
        <div class="hero-footnote">
          <span>适合：口播剪辑、直播切片、多素材合并讲解。</span>
          <span>默认工作流：建项目 → 加素材 → 进入工作台继续处理。</span>
        </div>
      </div>
      <aside class="hero-side">
        <div class="hero-side-section">
          <div class="hero-side-title">工作方式</div>
          <ul>
            <li>项目负责组织素材、时间线和导出结果。</li>
            <li>素材库负责统一上传、检索和转写状态。</li>
            <li>工作台负责字幕编辑、Agent 操作和精确导出。</li>
          </ul>
        </div>
        <div class="community-card">
          <div class="community-copy">
            <span class="community-label">扫码加入微信群</span>
            <strong>VibeEdit 共创群</strong>
            <span>作者微信：AInatives</span>
            <small>有问题直接进群交流，或加微信反馈使用体验。</small>
          </div>
          <img class="community-qr" src="/vibeedit-wechat-group-qr.jpg" alt="VibeEdit 微信群二维码" />
        </div>
      </aside>
    </section>

    <section class="create-card">
      <div class="card-head">
        <div>
          <h2>快速创建项目</h2>
          <p>项目名尽量直接描述内容主题。建好后，把素材加进来，再进入工作台继续剪辑。</p>
        </div>
        <div class="card-head-meta">
          <span class="chip-label">{{ categories.length }} 个分类</span>
          <span class="chip-label">支持多素材 / 多切片</span>
        </div>
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
  width: min(1560px, calc(100vw - 40px));
  margin: 0 auto 24px;
  display: grid;
  gap: 16px;
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
  padding: 22px;
  display: grid;
  grid-template-columns: minmax(0, 1.7fr) minmax(320px, 0.92fr);
  gap: 16px;
  align-items: start;
}

.eyebrow {
  color: var(--app-accent-strong);
  font-size: 12px;
  letter-spacing: 0.14em;
  margin-bottom: 8px;
  font-family: var(--font-mono);
}

h1 {
  font-size: clamp(30px, 3.2vw, 44px);
  margin-bottom: 8px;
  letter-spacing: -0.03em;
}

.hero p {
  color: var(--app-copy-muted);
  line-height: 1.6;
}

.hero-main,
.hero-copy {
  display: grid;
  gap: 14px;
}

.hero-main {
  min-width: 0;
}

.hero-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 16px;
  align-items: start;
}

.hero-stats {
  display: grid;
  grid-template-columns: 132px 132px minmax(0, 1fr);
  gap: 12px;
}

.chip-label {
  border: 1px solid rgba(88, 219, 255, 0.16);
  background: rgba(10, 18, 27, 0.82);
  color: var(--app-copy);
  padding: 8px 11px;
  font-size: 12px;
}

.stat-panel {
  min-height: 104px;
  padding: 14px 16px;
  display: grid;
  gap: 4px;
  align-content: start;
  border: 1px solid rgba(88, 219, 255, 0.16);
  background:
    linear-gradient(180deg, rgba(12, 20, 30, 0.96), rgba(7, 14, 22, 0.92));
}

.stat-panel strong {
  font-size: 30px;
  line-height: 1;
  letter-spacing: -0.04em;
  color: #f6fbff;
}

.stat-panel-wide strong {
  font-size: 22px;
  line-height: 1.2;
}

.stat-label,
.stat-meta,
.hero-footnote span {
  font-size: 12px;
}

.stat-label {
  color: var(--app-copy-soft);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-family: var(--font-mono);
}

.stat-meta {
  color: var(--app-copy-muted);
  line-height: 1.5;
}

.hero-footnote {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
}

.hero-footnote span {
  color: var(--app-copy-soft);
}

.hero-side {
  border: 1px solid rgba(88, 219, 255, 0.16);
  background: rgba(8, 16, 25, 0.8);
  padding: 16px;
  display: grid;
  gap: 14px;
  align-content: start;
}

.hero-side-section {
  display: grid;
  gap: 10px;
}

.hero-side-title {
  color: var(--app-copy-soft);
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.hero-side ul {
  margin: 0;
  padding-left: 18px;
  color: var(--app-copy);
  line-height: 1.55;
  display: grid;
  gap: 8px;
}

.community-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 126px;
  gap: 12px;
  align-items: center;
  padding: 12px;
  border: 1px solid rgba(88, 219, 255, 0.16);
  background: rgba(10, 18, 27, 0.78);
}

.community-copy {
  display: grid;
  gap: 6px;
}

.community-label {
  color: var(--app-copy-soft);
  font-size: 11px;
  letter-spacing: 0.08em;
}

.community-copy strong {
  color: var(--app-copy);
  font-size: 16px;
}

.community-copy span:last-of-type {
  color: var(--app-copy-muted);
  font-size: 12px;
}

.community-copy small {
  color: var(--app-copy-soft);
  line-height: 1.45;
}

.community-qr {
  width: 126px;
  aspect-ratio: 939 / 1461;
  height: auto;
  object-fit: contain;
  border: 1px solid rgba(88, 219, 255, 0.14);
  background: #08111a;
  justify-self: end;
}

.ghost-link,
.chip-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--app-copy);
  text-decoration: none;
  border: 1px solid var(--app-border-strong);
  background: rgba(10, 18, 27, 0.92);
  padding: 10px 14px;
  transition: 0.18s ease;
}

.hero-library-link {
  min-height: 42px;
  white-space: nowrap;
}

.ghost-link:hover,
.chip-link:hover {
  border-color: rgba(88, 219, 255, 0.32);
  color: var(--app-accent-strong);
}

.create-card {
  padding: 18px 20px;
  display: grid;
  gap: 12px;
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

.card-head-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
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
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 16px;
}

.empty-card,
.project-card {
  padding: 16px 18px;
  display: grid;
  gap: 12px;
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
  font-size: 18px;
  font-weight: 700;
  line-height: 1.3;
}

.project-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  color: var(--app-copy-soft);
  font-size: 13px;
  margin-top: 4px;
}

.project-desc {
  color: var(--app-copy);
  line-height: 1.55;
  min-height: 44px;
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
  .projects-page {
    width: min(100%, calc(100vw - 24px));
  }

  .create-form {
    grid-template-columns: 1fr;
  }

  .hero,
  .community-card {
    grid-template-columns: 1fr;
  }

  .hero-header,
  .hero-stats,
  .card-head,
  .project-top {
    display: grid;
    grid-template-columns: 1fr;
  }

  .project-grid {
    grid-template-columns: 1fr;
  }

  .community-qr {
    width: 180px;
    height: auto;
    justify-self: start;
  }

  .hero-library-link {
    width: 100%;
  }
}
</style>
