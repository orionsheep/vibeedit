<template>
  <div class="auth-page">
    <section class="auth-card auth-aside">
      <div class="eyebrow">VIBEEDIT</div>
      <h2>回到项目系统</h2>
      <p>邮箱登录后，直接进入素材库、项目时间线和右侧常驻 Agent 工作流。</p>
      <ul>
        <li>项目级字幕与时间线编辑</li>
        <li>直播切片与口播剪稿共用同一个 Agent</li>
        <li>支持视频导出，以及 XML / EDL / SRT 交换文件导出</li>
      </ul>
      <div class="author-contact">
        <span>作者微信</span>
        <strong>ChangqingMY</strong>
      </div>
      <router-link class="auth-link" to="/">查看产品概览</router-link>
    </section>

    <section class="auth-card">
      <div class="auth-head">
        <div class="eyebrow">VIBEEDIT</div>
        <h1>登录</h1>
        <p>用邮箱和密码进入项目系统。</p>
      </div>

      <form class="auth-form" @submit.prevent="handleLogin">
        <label>
          <span>邮箱</span>
          <input v-model.trim="form.email" type="email" autocomplete="email" required />
        </label>

        <label>
          <span>密码</span>
          <input v-model="form.password" type="password" autocomplete="current-password" required />
        </label>

        <div v-if="error" class="auth-error">{{ error }}</div>

        <button class="primary-btn" type="submit" :disabled="authStore.loading">
          {{ authStore.loading ? '登录中...' : '登录' }}
        </button>
      </form>

      <div class="auth-foot">
        <span>还没有账号？</span>
        <router-link to="/register">去注册</router-link>
      </div>
    </section>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../features/auth/stores/authStore';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const error = ref('');
const form = reactive({
  email: '',
  password: ''
});

async function handleLogin() {
  error.value = '';
  try {
    await authStore.login(form);
    await router.push(String(route.query.redirect || '/projects'));
  } catch (loginError) {
    error.value = loginError.response?.data?.error || loginError.message || '登录失败';
  }
}
</script>

<style scoped>
.auth-page {
  min-height: 100vh;
  display: grid;
  grid-template-columns: minmax(280px, 0.95fr) minmax(320px, 420px);
  justify-content: center;
  align-items: center;
  gap: 18px;
  padding: 24px;
  background:
    radial-gradient(circle at top left, rgba(88, 219, 255, 0.1), transparent 30%),
    linear-gradient(180deg, #060b10 0%, #091019 100%);
}

.auth-card {
  width: min(100%, 420px);
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
  gap: 16px;
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

.author-contact {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid rgba(88, 219, 255, 0.2);
  background: rgba(10, 18, 27, 0.72);
  color: var(--app-copy-soft);
  font-size: 12px;
  letter-spacing: 0.04em;
}

.author-contact strong {
  color: var(--app-copy);
  font-size: 14px;
  letter-spacing: 0.02em;
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
