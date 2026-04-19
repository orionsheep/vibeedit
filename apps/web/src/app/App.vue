<template>
  <div id="app">
    <nav class="nav" v-if="showNav">
      <h1 class="logo">VIBEEDIT</h1>
      <div class="nav-links">
        <router-link v-if="authStore.isAuthenticated" to="/projects">项目</router-link>
        <router-link v-if="authStore.isAuthenticated" to="/library">素材库</router-link>
        <router-link v-if="authStore.isAuthenticated" to="/dashboard">快速上传</router-link>
        <router-link v-if="authStore.isAuthenticated" to="/settings">账号</router-link>
      </div>
      <div class="nav-user" v-if="authStore.isAuthenticated">
        <span class="role-badge" v-if="authStore.isAdmin">管理员</span>
        <span>{{ authStore.user?.email }}</span>
        <button class="logout-btn" :disabled="authStore.loading" @click="handleLogout">
          {{ authStore.loading ? '退出中...' : '退出' }}
        </button>
      </div>
    </nav>
    <main class="main" :class="{ 'full-height': isWorkspace, 'no-padding': isFullPage }">
      <router-view />
    </main>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../features/auth/stores/authStore';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();

const isWorkspace = computed(() => route.path.includes('/projects/'));
const isFullPage = computed(() => ['/','/docs','/login','/register'].includes(route.path));
const showNav = computed(() => {
  const path = route.path;
  return authStore.isAuthenticated && path !== '/' && path !== '/docs' && path !== '/login' && path !== '/register' && !path.includes('/projects/');
});

async function handleLogout() {
  await authStore.logout();
  await router.push('/login');
}
</script>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: #0a0a0a;
  color: #ffffff;
}

html {
  scrollbar-width: thin;
  scrollbar-color: rgba(84, 116, 148, 0.92) rgba(10, 16, 23, 0.92);
}

* {
  scrollbar-width: thin;
  scrollbar-color: rgba(84, 116, 148, 0.92) rgba(10, 16, 23, 0.92);
}

*::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

*::-webkit-scrollbar-track {
  background: rgba(10, 16, 23, 0.96);
  border-left: 1px solid rgba(79, 126, 171, 0.14);
  border-top: 1px solid rgba(79, 126, 171, 0.14);
}

*::-webkit-scrollbar-thumb {
  background: linear-gradient(180deg, rgba(103, 140, 178, 0.98), rgba(74, 104, 136, 0.98));
  border: 2px solid rgba(10, 16, 23, 0.96);
  border-radius: 999px;
  min-height: 36px;
}

*::-webkit-scrollbar-thumb:hover {
  background: linear-gradient(180deg, rgba(124, 167, 211, 1), rgba(88, 126, 167, 1));
}

*::-webkit-scrollbar-corner {
  background: rgba(10, 16, 23, 0.96);
}

#app {
  min-height: 100vh;
}

.nav {
  height: 40px;
  background: #141414;
  border-bottom: 1px solid #2a2a2a;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 24px;
  position: relative;
}

.nav .logo {
  font-size: 14px;
  font-weight: 600;
  position: absolute;
  left: 24px;
}

.nav-links {
  display: flex;
  gap: 8px;
  overflow-x: auto;
}

.nav-links a {
  color: #a0a0a0;
  text-decoration: none;
  padding: 6px 12px;
  border-radius: 4px;
  font-size: 13px;
  transition: all 0.15s;
}

.nav-links a:hover {
  background: #1f1f1f;
  color: #fff;
}

.nav-links a.router-link-active {
  background: #00d4ff;
  color: #000;
}

.nav-user {
  position: absolute;
  right: 24px;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: #9cb0bf;
}

.role-badge {
  border: 1px solid #4f6542;
  background: #122112;
  color: #b7f5aa;
  padding: 3px 8px;
  font-size: 11px;
  letter-spacing: 0.04em;
}

.logout-btn {
  border: 1px solid #304151;
  background: #0d151d;
  color: #dff5ff;
  padding: 6px 10px;
  cursor: pointer;
}

.main {
  padding: 24px;
}

.main.full-height {
  padding: 0;
  height: 100vh;
}

.main.no-padding {
  padding: 0;
  overflow: visible;
}
</style>
