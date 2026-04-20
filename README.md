# VibeEdit

[![VibeEdit 产品演示](./assets/vibeedit-demo-poster.jpg)](./assets/vibeedit-demo.mp4)

产品演示视频：[`assets/vibeedit-demo.mp4`](./assets/vibeedit-demo.mp4)

在线体验：`https://vibeedit.orionsheep.shop/`

`VibeEdit` 不是一个“全功能复杂视频剪辑软件”。

它解决的是视频剪辑工作里的**第一步**：

- 先把长视频 / 多视频素材快速整理成一版可用的初剪
- 快速去掉重复表达、明显停顿、口头禅和无效段落
- 在不离开字幕面板的情况下，把口播内容整理成一版更干净、更适合继续精修的时间线

如果要类比，它更像是一个围绕 **“快编 / 初剪”** 搭建的工作台，而不是完整复刻传统 NLE 的所有高级能力。

## 产品工作流

这套产品的核心工作流很直接：

1. 视频先进入 `素材库`
2. 转写模型把音频转成文本
3. 强制对齐 / 时间戳模型把文本和音频逐词对齐
4. 素材被加入 `项目`
5. `Claude Code Agent` 读取项目字幕、时间线和删除态
6. Agent 通过现有工具对视频做初步剪辑
7. 用户继续和 Agent 对话，或者直接在字幕面板里手动修

也就是说，这个产品并不是“先分析视频画面再做复杂蒙太奇”，而是：

- 先把视频变成**可操作的字幕时间线**
- 再基于字幕去驱动视频剪辑

## 这个项目真正的优势

这个项目的优势不在于“有很多花哨的视频特效能力”，而在于：

### 1. Claude Code Agent 很强

项目的核心操作器不是传统规则引擎，而是基于 `Claude Code SDK` 构建的项目级 Agent。

这意味着它可以：

- 直接读取当前项目的字幕和时间线
- 基于字幕理解口播内容
- 在现有结果上继续增量修改
- 通过工具直接操作项目，而不是只做摘要

对于“初剪 / 快编”这个阶段，这种能力非常重要，因为大量工作其实不是加特效，而是：

- 识别重复
- 调整保留内容
- 删掉停顿和口头禅
- 保持顺序自然
- 基于当前版本继续改，而不是每次重来

### 2. AI 和人工编辑共用同一套编辑真相

当 AI 的处理不符合要求时，你不用被迫重新跑一轮。

你可以：

- 继续和 Agent 对话，让它在当前结果上接着改
- 或者直接在字幕面板上手动操作

而且这两种方式不是彼此割裂的：

- Agent 和人工都在操作同一套项目级编辑状态
- 删除是划线删除态
- 恢复、去停顿、局部修正都能持续叠加

这让工作流更像“AI 先帮你做第一轮，人工接着精修”，而不是“AI 做一版废稿，你只能推倒重来”。

## 当前功能

围绕“初剪 / 快编”这一定位，当前实现的重点功能包括：

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

## 当前定位边界

为了避免误解，当前项目的定位边界也很明确：

- 它擅长的是**字幕驱动的初步剪辑**
- 它不是完整替代传统剪辑软件的复杂后期系统
- 它的强项是：
  - 快速整理口播
  - 初步压缩时长
  - 去掉重复和明显无效内容
  - 为后续进入 PR / AE / 达芬奇 / 剪映做准备

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
- 旧地址 `/dashboard` 会自动跳转到 `/library`

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
