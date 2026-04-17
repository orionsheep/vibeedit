/**
 * AutoEdit web server
 * Serves the built SPA plus the editor API in one process.
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import projectRouter from './server/routes/projects.routes.js';
import libraryRouter from './server/routes/library.routes.js';
import { loadConfig } from './server/services/editor/config.js';
import { checkDatabaseConnection, getDatabaseState } from './server/services/core/database.service.js';
import { recoverPendingAssetJobs } from './server/services/library/asset-library.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.set('json replacer', (_key, value) => {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
});

// 启用 CORS，允许远程访问
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json());

app.use('/api/projects', projectRouter);
app.use('/api/library', libraryRouter);

const config = loadConfig();

// Use configured port and host
const DASHBOARD_PORT = process.env.PORT || config.dashboard_port || 12080;
const DASHBOARD_HOST = config.dashboard_host || '0.0.0.0';

// ============ API Routes ============

/**
 * 获取所有技能状态
 */
app.get('/api/skills', (req, res) => {
  res.json({
    skills: [
      {
        name: 'projects',
        displayName: '项目工作台',
        description: '项目、素材库与项目级 Agent 编辑工作流',
        route: '/projects',
        status: 'running'
      }
    ]
  });
});

app.get('/api/system/status', async (_req, res) => {
  const db = await checkDatabaseConnection();
  res.json({
    success: true,
    database: db,
    routes: {
      projects: '/api/projects',
      library: '/api/library'
    }
  });
});

// ============ 静态文件服务 (Vue 前端) ============

const vueDistPath = path.join(__dirname, 'dist');
if (fs.existsSync(vueDistPath)) {
  app.use(express.static(vueDistPath));
  console.log(`[Dashboard] Serving static files from ${vueDistPath}`);
}

// SPA 路由回退
app.get('*', (req, res) => {
  const indexPath = path.join(vueDistPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.json({
      message: 'AutoEdit Web Server',
      endpoints: {
        skills: 'GET /api/skills',
        projects: 'GET /api/projects',
        library: 'GET /api/library/assets'
      }
    });
  }
});

// ============ 启动服务器 ============

app.listen(DASHBOARD_PORT, DASHBOARD_HOST, () => {
  const displayHost = DASHBOARD_HOST === '0.0.0.0' ? '0.0.0.0 (所有接口)' : DASHBOARD_HOST;
  console.log(`\n[AutoEdit Dashboard] Server running at http://${displayHost}:${DASHBOARD_PORT}`);
  console.log(`[AutoEdit Dashboard] API: http://${displayHost}:${DASHBOARD_PORT}/api/skills`);
  console.log(`[AutoEdit Dashboard] Frontend: http://${displayHost}:${DASHBOARD_PORT}/projects`);
  checkDatabaseConnection()
    .then((dbState) => {
      console.log(`[AutoEdit Dashboard] Database configured: ${dbState.configured ? 'yes' : 'no'}`);
      console.log(`[AutoEdit Dashboard] Database connected: ${dbState.connected ? 'yes' : 'no'}`);
      if (dbState.lastError) {
        console.log(`[AutoEdit Dashboard] Database error: ${dbState.lastError}`);
      }
      recoverPendingAssetJobs()
        .then((count) => {
          if (count > 0) {
            console.log(`[AutoEdit Dashboard] Requeued ${count} pending asset jobs`);
          }
        })
        .catch((error) => {
          console.log(`[AutoEdit Dashboard] Asset job recovery failed: ${error.message}`);
        });
      console.log(`\n`);
    })
    .catch((error) => {
      const dbState = getDatabaseState();
      console.log(`[AutoEdit Dashboard] Database configured: ${dbState.configured ? 'yes' : 'no'}`);
      console.log(`[AutoEdit Dashboard] Database check failed: ${error.message}`);
      console.log(`\n`);
    });
});
