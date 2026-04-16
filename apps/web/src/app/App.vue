<template>
  <div id="app">
    <nav class="nav" v-if="showNav">
      <h1 class="logo">AUTOEDIT</h1>
      <div class="nav-links">
        <router-link to="/projects">项目</router-link>
        <router-link to="/library">素材库</router-link>
        <router-link to="/dashboard">快速上传</router-link>
      </div>
    </nav>
    <main class="main" :class="{ 'full-height': isWorkspace, 'no-padding': isFullPage }">
      <router-view />
    </main>
  </div>
</template>

<script>
export default {
  computed: {
    isWorkspace() {
      const path = this.$route.path;
      return path.includes('/projects/');
    },
    isFullPage() {
      const path = this.$route.path;
      return path === '/' || path === '/docs';
    },
    showNav() {
      const path = this.$route.path;
      return path !== '/' && path !== '/docs' && !path.includes('/projects/');
    }
  }
};
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
