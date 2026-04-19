/**
 * AutoEdit API server
 * Pure API entry used during local development.
 */

import express from 'express';
import cors from 'cors';
import authRouter from './server/routes/auth.routes.js';
import projectRouter from './server/routes/projects.routes.js';
import libraryRouter from './server/routes/library.routes.js';
import { loadConfig } from './server/services/editor/config.js';
import { checkDatabaseConnection, getDatabaseState } from './server/services/core/database.service.js';
import { attachAuthContext } from './server/services/auth/auth.middleware.js';

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
app.use(attachAuthContext);

app.use('/api/auth', authRouter);
app.use('/api/projects', projectRouter);
app.use('/api/library', libraryRouter);

const config = loadConfig();

// Use configured port and host
const API_PORT = process.env.PORT || config.api_port || 12081;
const API_HOST = config.dashboard_host || '0.0.0.0';

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

// ============ 启动服务器 ============

app.listen(API_PORT, API_HOST, () => {
  const displayHost = API_HOST === '0.0.0.0' ? '0.0.0.0 (所有接口)' : API_HOST;
  console.log(`\n[AutoEdit API] Server running at http://${displayHost}:${API_PORT}`);
  console.log(`[AutoEdit API] Endpoints:`);
  console.log(`  GET  /api/skills`);
  console.log(`  GET  /api/projects`);
  console.log(`  GET  /api/library/assets`);
  console.log(`  GET  /api/system/status`);
  checkDatabaseConnection()
    .then((dbState) => {
      console.log(`[AutoEdit API] Database configured: ${dbState.configured ? 'yes' : 'no'}`);
      console.log(`[AutoEdit API] Database connected: ${dbState.connected ? 'yes' : 'no'}`);
      if (dbState.lastError) {
        console.log(`[AutoEdit API] Database error: ${dbState.lastError}`);
      }
      console.log(`\n`);
    })
    .catch((error) => {
      const dbState = getDatabaseState();
      console.log(`[AutoEdit API] Database configured: ${dbState.configured ? 'yes' : 'no'}`);
      console.log(`[AutoEdit API] Database check failed: ${error.message}`);
      console.log(`\n`);
    });
});
