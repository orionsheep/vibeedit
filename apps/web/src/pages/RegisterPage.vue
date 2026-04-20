<template>
  <div class="auth-page">
    <section class="auth-card auth-aside">
      <div class="eyebrow">VIBEEDIT</div>
      <h2>注册一个剪辑工作区账号</h2>
      <p>账号体系只保留最必要的一层：邮箱、密码、项目归属。注册后即可进入项目系统继续剪辑。</p>
      <ul>
        <li>管理员首个账号会自动接管历史项目和素材。</li>
        <li>之后的账号默认是普通用户，按 ownerId 隔离资源。</li>
        <li>所有导出、切片和 Agent run 都在账号体系内归档。</li>
      </ul>
      <router-link class="auth-link" to="/login">已有账号，直接登录</router-link>
    </section>

    <section class="auth-card">
      <div class="auth-head">
        <div class="eyebrow">VIBEEDIT</div>
        <h1>注册</h1>
        <p>只需要邮箱、密码、确认密码。</p>
        <p v-if="authStore.bootstrapAdminEmail" class="bootstrap-note">
          如果这是首个账号，必须使用管理员邮箱：{{ authStore.bootstrapAdminEmail }}
        </p>
      </div>

      <form class="auth-form" @submit.prevent="handleRegister">
        <label>
          <span>邮箱</span>
          <input v-model.trim="form.email" type="email" autocomplete="email" required />
        </label>

        <label>
          <span>密码</span>
          <input v-model="form.password" type="password" autocomplete="new-password" required />
        </label>

        <label>
          <span>确认密码</span>
          <input v-model="form.confirmPassword" type="password" autocomplete="new-password" required />
        </label>

        <div v-if="error" class="auth-error">{{ error }}</div>

        <button class="primary-btn" type="submit" :disabled="authStore.loading">
          {{ authStore.loading ? '注册中...' : '注册并进入系统' }}
        </button>
      </form>

      <div class="auth-foot">
        <span>已经有账号？</span>
        <router-link to="/login">去登录</router-link>
      </div>
    </section>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../features/auth/stores/authStore';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const error = ref('');
const form = reactive({
  email: '',
  password: '',
  confirmPassword: ''
});

onMounted(() => {
  authStore.hydrateSession().catch(() => {});
});

async function handleRegister() {
  error.value = '';
  try {
    await authStore.register(form);
    await router.push(String(route.query.redirect || '/projects'));
  } catch (registerError) {
    error.value = registerError.response?.data?.error || registerError.message || '注册失败';
  }
}
</script>

<style scoped>
.auth-page {
  min-height: 100vh;
  display: grid;
  grid-template-columns: minmax(280px, 0.95fr) minmax(320px, 440px);
  justify-content: center;
  align-items: center;
  gap: 18px;
  padding: 24px;
  background:
    radial-gradient(circle at top left, rgba(88, 219, 255, 0.1), transparent 30%),
    linear-gradient(180deg, #060b10 0%, #091019 100%);
}

.auth-card {
  width: min(100%, 440px);
  border: 1px solid var(--app-border);
  background: rgba(10, 17, 25, 0.96);
  box-shadow: var(--app-shadow);
  padding: 26px;
  display: grid;
  gap: 18px;
}

.auth-aside {
  width: min(100%, 560px);
  align-content: start;
}

.eyebrow {
  color: var(--app-accent-strong);
  font-size: 12px;
  letter-spacing: 0.14em;
  margin-bottom: 8px;
  font-family: var(--font-mono);
}

.auth-head h1 {
  font-size: 32px;
  margin-bottom: 8px;
}

.auth-aside h2 {
  font-size: 34px;
  letter-spacing: -0.03em;
}

.auth-head p {
  color: var(--app-copy-muted);
  line-height: 1.6;
}

.auth-aside p,
.auth-aside li {
  color: var(--app-copy-muted);
  line-height: 1.7;
}

.auth-aside ul {
  padding-left: 18px;
}

.auth-link {
  color: var(--app-accent-strong);
  text-decoration: none;
}

.bootstrap-note {
  margin-top: 8px;
  color: #ffd27d;
}

.auth-form {
  display: grid;
  gap: 14px;
}

.auth-form label {
  display: grid;
  gap: 6px;
  font-size: 12px;
  color: #b5c9d8;
}

.auth-form input {
  height: 42px;
  border: 1px solid var(--app-border-strong);
  background: rgba(8, 15, 23, 0.92);
  color: var(--app-copy);
  padding: 0 12px;
}

.primary-btn {
  height: 42px;
  border: 1px solid transparent;
  background: linear-gradient(135deg, #58dbff, #7fe9ff);
  color: #071018;
  font-weight: 700;
  cursor: pointer;
}

.auth-error {
  color: #ffb1b1;
  font-size: 12px;
}

.auth-foot {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  color: var(--app-copy-muted);
}

.auth-foot a {
  color: var(--app-accent-strong);
  text-decoration: none;
}

@media (max-width: 980px) {
  .auth-page {
    grid-template-columns: 1fr;
  }

  .auth-card,
  .auth-aside {
    width: min(100%, 560px);
  }
}
</style>
