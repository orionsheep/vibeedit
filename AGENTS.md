# AGENTS.md

## Project Identity

这个仓库是独立维护的“本地视频剪辑 + 聊天式剪辑 Agent”项目。
后续开发默认都以这里为主。
项目范围已经收敛：只做 Agent 剪辑与字幕，不再保留 TTS、设备发现、声音克隆等旁支能力。

## Source Of Truth

- 正式入口页面：`apps/web/src/pages/ProjectsPage.vue` / `apps/web/src/pages/LibraryPage.vue`
- 多视频工作台：`apps/web/src/pages/ProjectWorkspacePage.vue`
- 项目 API：`apps/web/server/routes/projects.routes.js`
- 素材库 API：`apps/web/server/routes/library.routes.js`
- 项目服务：`apps/web/server/services/projects/`
- 素材服务：`apps/web/server/services/library/`
- 项目级 Agent：`apps/web/server/services/agent/project-agent.service.js`
- 模型抽象层：`apps/web/server/services/editor/llm.service.js`
- 数据库结构：`apps/web/prisma/schema.prisma`
- Python ASR / CLI：`scripts/` + `pyproject.toml`

## Development Rules

- 默认把 `/projects` -> `/library` -> `/projects/:projectId/edit` 当成正式主流程。
- 不再维护 `/skill/cut/*` 旧入口，也不要再新增任何对它的依赖。
- 多视频工作台右侧的项目级 Agent 必须始终存在，不要再做成点击后才展开的临时面板。
- 任何新的功能提议，都要先判断是否直接服务于“剪辑”或“字幕”。不相关的能力默认不做。
- 页面布局保持：
  - 左侧：项目素材 / 素材抽屉
  - 中间：预览 + 主时间线 + 字幕片段
  - 右侧：常驻 Agent 聊天区
- 多视频主工作台优先用项目、素材、时间线三个层次组织，不要退回单视频平铺思路。
- 设置项应优先放在弹出框或边栏里，不要长期占据主工作区。
- 顶部至少保留：
  - `素材库入口`
  - `导出工程包`
  - `导出视频`

## UI Style Rules

- 这是生产工具，不是展示页。优先高密度、清晰、克制。
- 不要使用夸张的大圆角；默认使用更硬朗、更省空间的直角或很小的圆角。
- 避免大面积空洞的说明卡片和冗余统计卡片。
- 视频预览必须确保完整显示画面，宁可留黑边，也不要裁掉内容。

## Agent Rules

- 模型层不要写死在单一厂商上。当前主链是 Claude Agent SDK + GLM Claude-compatible，必要时可以显式切换备援 provider / model。
- 项目级 Agent 必须以“结构化时间线 patch”为目标，而不是只生成总结文本。
- 主题提取失败时，不要回退到随便挑片段；宁可返回空结果，也不要误导用户。
- 像“删停顿 / 剪空白 / 去静音”这种请求，优先走确定性时间线工具，不要只让模型做内容总结。
- 聊天式 Agent 的输出必须能落回 `deletedWords` / `deletedGaps` / cuts，而不只是生成文案。
- 如果用户继续编辑，旧的精确预览或旧的下载链接应视为过期。
- 不要重新引入 TTS 对话、音色面板、设备发现、播放设备管理等非剪辑功能。

## Preview Rules

- 预览有延迟时，优先修“精确预览代理”链路，不要轻易为了 UI 壳子更换整个播放器框架。
- `PreviewPlayer.vue` 中要同时维护：
  - 实时预览
  - 精确预览
- 代理时间轴和源时间轴映射必须保持正确。

## Export Rules

- 导出不仅是视频成片，也包括工程交换文件：
  - OTIO
  - Premiere / Resolve XML
  - EDL
  - 剪映 / CapCut SRT
  - 完整工程包
- 修改导出逻辑时，要同时考虑：
  - macOS 编码器
  - Linux + NVIDIA 编码器
  - 工程包中的素材引用路径

## Run Commands

### Install

```bash
cd /Users/mychanging/Desktop/autoedit
uv sync
docker compose up -d postgres
cd /Users/mychanging/Desktop/autoedit/apps/web
npm install
DATABASE_URL='postgresql://autoedit:autoedit@127.0.0.1:5432/autoedit?schema=public' npx prisma generate
DATABASE_URL='postgresql://autoedit:autoedit@127.0.0.1:5432/autoedit?schema=public' npx prisma db push
```

### Start

```bash
cd /Users/mychanging/Desktop/autoedit/apps/web
npm run dev:all
```

### Build

```bash
cd /Users/mychanging/Desktop/autoedit/apps/web
npm run build
```

## Config And Workspace

- 默认配置文件：`.autoedit/config.json`
- 默认工作目录：当前代码默认值是 `~/.autoedit/workspace`；如果项目已显式配置其他目录，先以项目配置为准，不要静默改动已有数据。当前仓库里的实际配置为了兼容已有素材，可能仍显式指向旧的 `~/.opc_skill/workspace`
- 可以通过环境变量覆盖：
  - `AUTOEDIT_CONFIG_FILE`
  - `AUTOEDIT_CONFIG_DIR`
  - `AUTOEDIT_WORKSPACE_DIR`
  - `AUTOEDIT_PY_ROOT`

## Editing Rules

- 修改文件时优先小步、可验证。
- 不要把 `node_modules`、`dist`、workspace 输出文件当成源码改。
- 如果修改了 Agent、预览、导出任一主链路，至少做一次对应的接口或构建验证。
