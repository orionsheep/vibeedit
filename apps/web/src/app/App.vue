<template>
  <div id="app">
    <nav class="nav" v-if="showNav">
      <h1 class="logo">
        <span class="logo-mark">VE</span>
        <span class="logo-copy">
          <span class="logo-text">VibeEdit</span>
          <span class="logo-subtitle">Agent Editing Console</span>
        </span>
      </h1>
      <div class="nav-links">
        <router-link v-if="authStore.isAuthenticated" to="/projects">项目</router-link>
        <router-link v-if="authStore.isAuthenticated" to="/library">素材库</router-link>
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
:root {
  --app-bg: #07111a;
  --app-bg-elevated: #0d1822;
  --app-bg-panel: rgba(10, 20, 30, 0.92);
  --app-bg-soft: rgba(9, 17, 25, 0.78);
  --app-border: #203241;
  --app-border-strong: #2d475e;
  --app-copy: #eef7ff;
  --app-copy-muted: #8ea8bb;
  --app-copy-soft: #6f8697;
  --app-accent: #58dbff;
  --app-accent-strong: #8ceaff;
  --app-danger: #ff8793;
  --app-success: #a4f0ba;
  --app-shadow: 0 22px 60px rgba(0, 0, 0, 0.34);
  --app-radius: 14px;
  --font-sans: "Avenir Next", "SF Pro Display", "Segoe UI", sans-serif;
  --font-mono: "IBM Plex Mono", "SFMono-Regular", ui-monospace, monospace;
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html,
body {
  min-height: 100%;
}

body {
  font-family: var(--font-sans);
  background:
    radial-gradient(circle at top left, rgba(88, 219, 255, 0.12), transparent 24%),
    radial-gradient(circle at top right, rgba(124, 102, 255, 0.08), transparent 18%),
    linear-gradient(180deg, #061017 0%, #08131c 100%);
  color: var(--app-copy);
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
  position: sticky;
  top: 0;
  z-index: 40;
  min-height: 58px;
  background: rgba(7, 15, 22, 0.9);
  backdrop-filter: blur(18px);
  border-bottom: 1px solid rgba(60, 95, 121, 0.34);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 24px;
  position: relative;
}

.nav::after {
  content: '';
  position: absolute;
  inset: auto 24px 0 24px;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(88, 219, 255, 0.24), transparent);
}

.nav .logo {
  position: absolute;
  left: 24px;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 14px;
  font-weight: 600;
}

.logo-mark {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border: 1px solid rgba(88, 219, 255, 0.38);
  background:
    linear-gradient(135deg, rgba(88, 219, 255, 0.22), rgba(88, 219, 255, 0.04)),
    #0d1822;
  color: var(--app-accent-strong);
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 0.06em;
}

.logo-copy {
  display: grid;
}

.logo-text {
  font-size: 15px;
  line-height: 1.05;
}

.logo-subtitle {
  color: var(--app-copy-soft);
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.nav-links {
  display: flex;
  gap: 8px;
  overflow-x: auto;
}

.nav-links a {
  color: var(--app-copy-muted);
  text-decoration: none;
  padding: 8px 12px;
  border: 1px solid transparent;
  font-size: 13px;
  transition: all 0.18s ease;
}

.nav-links a:hover {
  border-color: rgba(88, 219, 255, 0.16);
  background: rgba(11, 21, 31, 0.82);
  color: var(--app-copy);
}

.nav-links a.router-link-active {
  border-color: rgba(88, 219, 255, 0.3);
  background: rgba(88, 219, 255, 0.1);
  color: var(--app-accent-strong);
}

.nav-user {
  position: absolute;
  right: 24px;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--app-copy-muted);
  max-width: 42vw;
  min-width: 0;
}

.role-badge {
  border: 1px solid rgba(164, 240, 186, 0.38);
  background: rgba(19, 43, 27, 0.92);
  color: var(--app-success);
  padding: 4px 8px;
  font-size: 11px;
  letter-spacing: 0.04em;
}

.logout-btn {
  border: 1px solid var(--app-border-strong);
  background: rgba(10, 18, 27, 0.92);
  color: var(--app-copy);
  padding: 7px 12px;
  cursor: pointer;
}

.main {
  padding: 28px;
}

.main.full-height {
  padding: 0;
  height: 100vh;
}

.main.no-padding {
  padding: 0;
  overflow: visible;
}

::selection {
  background: rgba(88, 219, 255, 0.26);
  color: #fff;
}

@media (max-width: 1100px) {
  .nav {
    justify-content: flex-end;
    gap: 12px;
    padding: 12px 16px;
    flex-wrap: wrap;
  }

  .nav .logo,
  .nav-user {
    position: static;
  }

  .nav-links {
    order: 3;
    width: 100%;
    justify-content: flex-start;
  }

  .nav-user {
    max-width: 100%;
  }
}
</style>
