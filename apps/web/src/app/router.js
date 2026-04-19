import { createRouter, createWebHistory } from 'vue-router';
import LandingPage from '../pages/LandingPage.vue';
import DocsPage from '../pages/DocsPage.vue';
import UploadPage from '../pages/UploadPage.vue';
import ProjectsPage from '../pages/ProjectsPage.vue';
import LibraryPage from '../pages/LibraryPage.vue';
import ProjectWorkspacePage from '../pages/ProjectWorkspacePage.vue';
import LoginPage from '../pages/LoginPage.vue';
import RegisterPage from '../pages/RegisterPage.vue';
import AccountSettingsPage from '../pages/AccountSettingsPage.vue';
import { useAuthStore } from '../features/auth/stores/authStore';

const routes = [
  { path: '/', name: 'Landing', component: LandingPage, meta: { public: true } },
  { path: '/docs', name: 'Docs', component: DocsPage, meta: { public: true } },
  { path: '/login', name: 'Login', component: LoginPage, meta: { public: true, authOnly: true } },
  { path: '/register', name: 'Register', component: RegisterPage, meta: { public: true, authOnly: true } },
  { path: '/projects', name: 'Projects', component: ProjectsPage },
  { path: '/library', name: 'Library', component: LibraryPage },
  { path: '/settings', name: 'AccountSettings', component: AccountSettingsPage },
  { path: '/projects/:projectId', name: 'Project', component: ProjectWorkspacePage },
  { path: '/projects/:projectId/edit', name: 'ProjectWorkspace', component: ProjectWorkspacePage },
  { path: '/dashboard', name: 'Dashboard', component: UploadPage }
];

const router = createRouter({
  history: createWebHistory(),
  routes
});

router.beforeEach(async (to) => {
  const authStore = useAuthStore();
  await authStore.hydrateSession();

  const isPublic = Boolean(to.meta?.public);
  const authOnly = Boolean(to.meta?.authOnly);

  if (!isPublic && !authStore.isAuthenticated) {
    return {
      path: '/login',
      query: {
        redirect: to.fullPath
      }
    };
  }

  if (authOnly && authStore.isAuthenticated) {
    return '/projects';
  }

  return true;
});

export default router;
