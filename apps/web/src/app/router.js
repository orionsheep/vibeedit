import { createRouter, createWebHistory } from 'vue-router';
import LandingPage from '../pages/LandingPage.vue';
import DocsPage from '../pages/DocsPage.vue';
import UploadPage from '../pages/UploadPage.vue';
import ProjectsPage from '../pages/ProjectsPage.vue';
import LibraryPage from '../pages/LibraryPage.vue';
import ProjectWorkspacePage from '../pages/ProjectWorkspacePage.vue';

const routes = [
  { path: '/', name: 'Landing', component: LandingPage },
  { path: '/docs', name: 'Docs', component: DocsPage },
  { path: '/projects', name: 'Projects', component: ProjectsPage },
  { path: '/library', name: 'Library', component: LibraryPage },
  { path: '/projects/:projectId', name: 'Project', component: ProjectWorkspacePage },
  { path: '/projects/:projectId/edit', name: 'ProjectWorkspace', component: ProjectWorkspacePage },
  { path: '/dashboard', name: 'Dashboard', component: UploadPage }
];

export default createRouter({
  history: createWebHistory(),
  routes
});
