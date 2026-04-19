<template>
  <div class="auth-page">
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
  place-items: center;
  padding: 24px;
  background:
    radial-gradient(circle at top left, rgba(25, 189, 255, 0.08), transparent 28%),
    linear-gradient(180deg, #060b10 0%, #091019 100%);
}

.auth-card {
  width: min(100%, 420px);
  border: 1px solid #20303f;
  background: rgba(10, 17, 25, 0.96);
  padding: 24px;
  display: grid;
  gap: 18px;
}

.eyebrow {
  color: #78dcff;
  font-size: 12px;
  letter-spacing: 0.14em;
  margin-bottom: 8px;
}

.auth-head h1 {
  font-size: 32px;
  margin-bottom: 8px;
}

.auth-head p {
  color: #93abbb;
  line-height: 1.6;
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
  border: 1px solid #253646;
  background: #0b1218;
  color: #eff7fc;
  padding: 0 12px;
}

.primary-btn {
  height: 42px;
  border: 1px solid #16c5ff;
  background: #16c5ff;
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
  color: #93abbb;
}

.auth-foot a {
  color: #8fe7ff;
  text-decoration: none;
}
</style>
