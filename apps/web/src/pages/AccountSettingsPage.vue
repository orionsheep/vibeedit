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
  background: #0a1016;
  min-height: calc(100vh - 40px);
}

.settings-section {
  border: 1px solid #22313f;
  background: #0d151d;
  padding: 18px;
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
  color: #6fdcff;
  font-size: 11px;
  letter-spacing: 0.12em;
  margin-bottom: 6px;
}

.section-head h1,
.section-head h2 {
  font-size: 22px;
  margin-bottom: 8px;
}

.section-head p {
  color: #8ea5b8;
  line-height: 1.5;
}

.account-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.meta-chip {
  border: 1px solid #2b4051;
  background: #0a1118;
  color: #d7edf9;
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
  border: 1px solid #273a4a;
  background: #091118;
  color: #f3fbff;
  padding: 0 12px;
}

.form-actions {
  display: flex;
  justify-content: flex-start;
}

.primary-btn,
.ghost-btn {
  height: 40px;
  border: 1px solid #2a4050;
  background: #0c141c;
  color: #dff3ff;
  padding: 0 14px;
  cursor: pointer;
}

.primary-btn {
  background: #16c5ff;
  border-color: #16c5ff;
  color: #071018;
  font-weight: 700;
}

.form-error {
  color: #ffb1b1;
  font-size: 12px;
}

.form-success {
  color: #9be8a6;
  font-size: 12px;
}

.user-table-wrap {
  overflow: auto;
  border: 1px solid #1f2c37;
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
  border-bottom: 1px solid #1f2c37;
  font-size: 13px;
}

.user-table th {
  color: #8fb2c8;
  font-weight: 600;
  background: #0b1118;
}

.table-role {
  display: inline-flex;
  align-items: center;
  padding: 4px 8px;
  border: 1px solid #2b4051;
  background: #111a23;
  color: #d6eef8;
  font-size: 12px;
}

.table-role.admin {
  border-color: #4f6542;
  background: #122112;
  color: #b7f5aa;
}

.empty-cell {
  color: #8ea5b8;
}
</style>
