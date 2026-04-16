# autoedit

本地优先的多视频字幕剪辑工作台，围绕这些能力构建：

- 项目 / 素材库
- 多素材时间线与项目级编辑状态
- ASR 转写与词级时间轴
- 字幕划线删除 / 恢复 / 去停顿
- 项目级 Agent 辅助口播剪辑
- 导出视频、工程包与剪辑交换格式

当前这套代码的定位很明确：

- 视频先进入 `素材库`
- 素材再被引用进 `项目`
- 项目内维护真实的多视频主时间线
- 人类和 Agent 都在同一套项目级编辑真相上工作
- 导出结果从项目状态派生，而不是从一堆临时前端状态拼出来

## 当前功能

- 项目列表、创建、删除
- 项目工作台
- 项目素材上传、拖拽上传、转写进度、失败重试
- 多素材预览与连续时间线播放
- 字幕编辑：
  - 划线删除 / 恢复
  - 口头禅删除
  - 长停顿清理
  - 项目级字幕覆盖
- Claude Agent SDK 驱动的项目 Agent
  - `口播拼稿`
  - `自由指令`
- 导入 / 导出：
  - 完整工程包
  - 视频
  - Premiere / Resolve XML
  - 通用 EDL
  - 剪映 / CapCut SRT

## 仓库安全说明

这个仓库默认**不提交任何真实密钥、运行时目录或用户数据**：

- 真实配置：`.autoedit/config.json` 不提交
- 运行时目录：`.autoedit/claude-runtime*` 不提交
- 本地 workspace / storage / uploads / tmp 不提交
- `node_modules`、`dist`、`.venv` 不提交

公开仓库里保留：

- `.autoedit/CLAUDE.md`
- `.autoedit/config.example.json`

用于说明 Agent 约束和本地配置格式。

## 目录

```text
autoedit/
├── AGENTS.md
├── README.md
├── pyproject.toml
├── uv.lock
├── apps/
│   └── web/
│       ├── api-server.js
│       ├── web-server.js
│       ├── prisma/
│       ├── package.json
│       ├── server/
│       │   ├── routes/
│       │   ├── services/core/
│       │   ├── services/editor/
│       │   ├── services/library/
│       │   ├── services/projects/
│       │   └── services/agent/
│       └── src/
│           ├── app/
│           ├── pages/
│           ├── shared/
│           ├── features/editor/
│           ├── features/library/
│           └── features/projects/
└── scripts/
    ├── cli.py
    ├── opc.py
    ├── asr/
    └── shared/
```

## 运行

### 1. 安装 Python 依赖

```bash
cd /Users/mychanging/Desktop/autoedit
uv sync
```

### 2. 启动 Postgres

```bash
cd /Users/mychanging/Desktop/autoedit
docker compose up -d postgres
```

### 3. 安装前端 / Node 依赖

```bash
cd /Users/mychanging/Desktop/autoedit/apps/web
npm install
```

### 4. 初始化数据库

```bash
cd /Users/mychanging/Desktop/autoedit/apps/web
DATABASE_URL='postgresql://autoedit:autoedit@127.0.0.1:5432/autoedit?schema=public' npx prisma generate
DATABASE_URL='postgresql://autoedit:autoedit@127.0.0.1:5432/autoedit?schema=public' npx prisma db push
```

### 5. 启动开发服务

```bash
cd /Users/mychanging/Desktop/autoedit/apps/web
npm run dev:all
```

默认端口：

- 前端：`http://localhost:12080`
- API：`http://localhost:12081`

生产/本地打包静态前端：

```bash
cd /Users/mychanging/Desktop/autoedit/apps/web
npm run build
```

## 主页面与路由

- 项目列表：`/projects`
- 素材库：`/library`
- 项目工作台：`/projects/:projectId/edit`
- 兼容入口：`/dashboard`

## 配置

默认主配置与 workspace：

- 配置文件：`.autoedit/config.json`
- 工作目录：当前代码默认值是 `~/.autoedit/workspace`；也可以在 `.autoedit/config.json` 里显式指定其他目录。当前仓库里的示例/现网配置为了兼容已有素材，可能仍指向旧的 `~/.opc_skill/workspace`

如果你希望这个独立项目使用自己的配置或工作目录，可以通过环境变量覆盖：

```bash
export AUTOEDIT_CONFIG_FILE=/path/to/config.json
export AUTOEDIT_WORKSPACE_DIR=/path/to/workspace
export AUTOEDIT_PY_ROOT=/Users/mychanging/Desktop/autoedit
```

## 当前架构

- 前端：Vue 3 + Vue Router + Vite
- API：Express + multer + fluent-ffmpeg
- 数据库：Postgres + Prisma
- 状态模型：`projects / assets / timelines / clips / captions / jobs / agent_runs / snapshots`
- Agent：Claude Agent SDK 为唯一主链，默认走 Claude-compatible GLM / SiliconFlow 配置
- 字幕 / ASR：Python `autoedit asr` 链路，兼容 MLX / CUDA
- 时间线交换：OTIO + XML / EDL / SRT
- 导出：FFmpeg + 完整工程包

## 注意

- `apps/web/src/pages/ProjectWorkspacePage.vue` 是当前多视频主工作台页面。
- `apps/web/src/pages/ProjectsPage.vue` 和 `apps/web/src/pages/LibraryPage.vue` 是正式入口。
- `apps/web/server/services/projects/` 管理项目、时间线、导出。
- `apps/web/server/services/library/` 管理素材导入与 ASR。
- `apps/web/server/services/agent/project-agent.service.js` 是项目级 Agent 的核心逻辑。
- `apps/web/prisma/schema.prisma` 是当前数据库结构来源。
- `scripts/tts`、设备发现、声音克隆这一类能力已不再是本项目目标，后续开发不要重新加回。
- 不要把生成文件、workspace 输出、`dist`、`node_modules` 当作源码修改目标。
