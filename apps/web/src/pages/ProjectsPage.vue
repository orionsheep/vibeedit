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
      <div>
        <div class="eyebrow">PROJECTS</div>
        <h1>多视频项目工作区</h1>
        <p>先建项目，再把素材库里的视频加入项目，最后进入主时间线和 Agent 工作台。</p>
      </div>
      <router-link class="ghost-link" to="/library">打开素材库</router-link>
    </section>

    <section class="create-card">
      <div class="card-head">
        <h2>创建项目</h2>
        <span>{{ categories.length }} 个分类</span>
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
  gap: 18px;
}

.hero,
.create-card,
.project-card {
  border: 1px solid #243140;
  background: #111821;
}

.hero {
  padding: 24px;
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
}

.eyebrow {
  color: #73dce6;
  font-size: 12px;
  letter-spacing: 0.14em;
  margin-bottom: 8px;
}

h1 {
  font-size: 36px;
  margin-bottom: 8px;
}

.hero p {
  color: #97acbb;
  max-width: 720px;
  line-height: 1.7;
}

.ghost-link,
.chip-link {
  color: #dff9ff;
  text-decoration: none;
  border: 1px solid #2f4050;
  background: #0f151d;
  padding: 9px 12px;
}

.create-card {
  padding: 20px;
  display: grid;
  gap: 14px;
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.create-form {
  display: grid;
  grid-template-columns: 1.2fr 0.8fr 1fr auto;
  gap: 12px;
}

.create-form input,
.btn-primary {
  height: 44px;
  border: 1px solid #2d3a47;
  background: #091018;
  color: #f2f6fb;
  padding: 0 12px;
}

.btn-primary {
  background: #00d4ff;
  border-color: #00d4ff;
  color: #071018;
  font-weight: 700;
  cursor: pointer;
}

.project-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.project-card {
  padding: 18px;
  display: grid;
  gap: 14px;
}

.project-top {
  display: flex;
  justify-content: space-between;
  gap: 12px;
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
  color: #8aa1b3;
  font-size: 13px;
  margin-top: 4px;
}

.project-desc {
  color: #c8d6e3;
  line-height: 1.6;
  min-height: 48px;
}

.project-footer {
  color: #7e95a8;
  font-size: 13px;
}

.inline-error {
  color: #ff9f9f;
}

.danger-chip {
  color: #ffb3bc;
  border-color: #5b2831;
  background: #1a0d12;
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

  .hero {
    flex-direction: column;
  }
}
</style>
