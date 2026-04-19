import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '../features/auth/stores/authStore';

const LandingPage = () => import('../pages/LandingPage.vue');
const DocsPage = () => import('../pages/DocsPage.vue');
const ProjectsPage = () => import('../pages/ProjectsPage.vue');
const LibraryPage = () => import('../pages/LibraryPage.vue');
const ProjectWorkspacePage = () => import('../pages/ProjectWorkspacePage.vue');
const LoginPage = () => import('../pages/LoginPage.vue');
const RegisterPage = () => import('../pages/RegisterPage.vue');
const AccountSettingsPage = () => import('../pages/AccountSettingsPage.vue');

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
  { path: '/dashboard', redirect: '/library' }
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
