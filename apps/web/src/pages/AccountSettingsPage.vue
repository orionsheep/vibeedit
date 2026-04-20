<template>
  <div class="settings-page">
    <section class="settings-section">
      <div class="section-head">
        <div>
          <div class="eyebrow">ACCOUNT</div>
          <h1>账号设置</h1>
          <p>管理当前登录账号和密码。</p>
        </div>
        <div class="account-meta">
          <div class="meta-chip">{{ authStore.user?.email }}</div>
          <div class="meta-chip admin" v-if="authStore.isAdmin">管理员</div>
        </div>
      </div>

      <form class="password-form" @submit.prevent="handlePasswordUpdate">
        <label>
          <span>当前密码</span>
          <input v-model="passwordForm.currentPassword" type="password" autocomplete="current-password" required />
        </label>
        <label>
          <span>新密码</span>
          <input v-model="passwordForm.nextPassword" type="password" autocomplete="new-password" required />
        </label>
        <label>
          <span>确认新密码</span>
          <input v-model="passwordForm.confirmPassword" type="password" autocomplete="new-password" required />
        </label>

        <div v-if="passwordError" class="form-error">{{ passwordError }}</div>
        <div v-if="passwordSuccess" class="form-success">{{ passwordSuccess }}</div>

        <div class="form-actions">
          <button class="primary-btn" type="submit" :disabled="authStore.loading">
            {{ authStore.loading ? '保存中...' : '修改密码' }}
          </button>
        </div>
      </form>
    </section>

    <section class="settings-section" v-if="authStore.isAdmin">
      <div class="section-head compact">
        <div>
          <div class="eyebrow">ADMIN</div>
          <h2>用户管理</h2>
          <p>查看所有账号和它们接管的项目、素材数量。</p>
        </div>
        <button class="ghost-btn" type="button" :disabled="authStore.usersLoading" @click="reloadUsers">
          {{ authStore.usersLoading ? '刷新中...' : '刷新列表' }}
        </button>
      </div>

      <div class="user-table-wrap">
        <table class="user-table">
          <thead>
            <tr>
              <th>邮箱</th>
              <th>角色</th>
              <th>项目</th>
              <th>素材</th>
              <th>会话</th>
              <th>注册时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="user in authStore.users" :key="user.id">
              <td>{{ user.email }}</td>
              <td>
                <span class="table-role" :class="user.role">{{ user.role === 'admin' ? '管理员' : '普通用户' }}</span>
              </td>
              <td>{{ user.project_count }}</td>
              <td>{{ user.asset_count }}</td>
              <td>{{ user.active_session_count }}</td>
              <td>{{ formatDate(user.created_at) }}</td>
            </tr>
            <tr v-if="!authStore.usersLoading && !authStore.users.length">
              <td colspan="6" class="empty-cell">当前还没有用户数据。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { useAuthStore } from '../features/auth/stores/authStore';

const authStore = useAuthStore();
const passwordError = ref('');
const passwordSuccess = ref('');
const passwordForm = reactive({
  currentPassword: '',
  nextPassword: '',
  confirmPassword: ''
});

function formatDate(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

async function reloadUsers() {
  passwordError.value = '';
  if (!authStore.isAdmin) return;
  try {
    await authStore.loadUsers(true);
  } catch (error) {
    passwordError.value = error.response?.data?.error || error.message || '用户列表加载失败';
  }
}

async function handlePasswordUpdate() {
  passwordError.value = '';
  passwordSuccess.value = '';
  try {
    await authStore.updatePassword(passwordForm);
    passwordForm.currentPassword = '';
    passwordForm.nextPassword = '';
    passwordForm.confirmPassword = '';
    passwordSuccess.value = '密码已更新。其他旧会话已经失效。';
  } catch (error) {
    passwordError.value = error.response?.data?.error || error.message || '密码更新失败';
  }
}

onMounted(async () => {
  if (!authStore.sessionChecked) {
    await authStore.hydrateSession();
  }
  if (authStore.isAdmin) {
    await authStore.loadUsers();
  }
});
</script>

<style scoped>
.settings-page {
  padding: 24px;
  display: grid;
  gap: 18px;
  background:
    radial-gradient(circle at top left, rgba(88, 219, 255, 0.06), transparent 24%),
    #0a1016;
  min-height: calc(100vh - 40px);
}

.settings-section {
  border: 1px solid var(--app-border);
  background: linear-gradient(180deg, rgba(14, 23, 33, 0.98), rgba(9, 16, 24, 0.96));
  box-shadow: var(--app-shadow);
  padding: 22px;
  display: grid;
  gap: 18px;
}

.section-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
}

.section-head.compact {
  align-items: center;
}

.eyebrow {
  color: var(--app-accent-strong);
  font-size: 11px;
  letter-spacing: 0.12em;
  margin-bottom: 6px;
  font-family: var(--font-mono);
}

.section-head h1,
.section-head h2 {
  font-size: 22px;
  margin-bottom: 8px;
}

.section-head p {
  color: var(--app-copy-muted);
  line-height: 1.5;
}

.account-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.meta-chip {
  border: 1px solid rgba(88, 219, 255, 0.16);
  background: rgba(10, 17, 24, 0.92);
  color: var(--app-copy);
  padding: 7px 10px;
  font-size: 12px;
}

.meta-chip.admin {
  border-color: #4f6542;
  background: #122112;
  color: #b7f5aa;
}

.password-form {
  display: grid;
  gap: 14px;
  max-width: 520px;
}

.password-form label {
  display: grid;
  gap: 6px;
  color: #aec4d5;
  font-size: 12px;
}

.password-form input {
  height: 42px;
  border: 1px solid var(--app-border-strong);
  background: rgba(8, 15, 23, 0.92);
  color: var(--app-copy);
  padding: 0 12px;
}

.form-actions {
  display: flex;
  justify-content: flex-start;
}

.primary-btn,
.ghost-btn {
  height: 40px;
  border: 1px solid var(--app-border-strong);
  background: rgba(10, 18, 27, 0.92);
  color: var(--app-copy);
  padding: 0 14px;
  cursor: pointer;
}

.primary-btn {
  background: linear-gradient(135deg, #58dbff, #7fe9ff);
  border-color: transparent;
  color: #071018;
  font-weight: 700;
}

.form-error {
  color: #ffb1b1;
  font-size: 12px;
}

.form-success {
  color: var(--app-success);
  font-size: 12px;
}

.user-table-wrap {
  overflow: auto;
  border: 1px solid rgba(88, 219, 255, 0.12);
}

.user-table {
  width: 100%;
  border-collapse: collapse;
  min-width: 760px;
}

.user-table th,
.user-table td {
  text-align: left;
  padding: 10px 12px;
  border-bottom: 1px solid rgba(88, 219, 255, 0.08);
  font-size: 13px;
}

.user-table th {
  color: var(--app-copy-soft);
  font-weight: 600;
  background: rgba(10, 17, 24, 0.9);
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.table-role {
  display: inline-flex;
  align-items: center;
  padding: 5px 8px;
  border: 1px solid rgba(88, 219, 255, 0.14);
  background: rgba(10, 17, 24, 0.72);
  color: var(--app-copy);
  font-size: 12px;
}

.table-role.admin {
  border-color: rgba(164, 240, 186, 0.28);
  background: #122112;
  color: var(--app-success);
}

.empty-cell {
  color: var(--app-copy-muted);
}
</style>
