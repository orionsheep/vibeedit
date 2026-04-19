<template>
  <div class="docs">
    <aside class="sidebar">
      <div class="sidebar-title">VIBEEDIT Docs</div>
      <a href="#scope">项目范围</a>
      <a href="#install">安装</a>
      <a href="#run">启动</a>
      <a href="#routes">页面</a>
      <a href="#cli">CLI</a>
      <a href="#exports">导出</a>
      <a href="#config">配置</a>
    </aside>

    <main class="content">
      <section id="scope">
        <h1>VibeEdit 文档</h1>
        <p>
          这个项目现在只保留一条能力主线：<strong>Agent 剪辑 + 字幕生成 / 编辑</strong>。
          多引擎语音合成、设备发现、声音克隆与设计都已经被移出产品范围。
        </p>
      </section>

      <section id="install">
        <h2>安装</h2>
        <pre><code>cd /Users/mychanging/Desktop/autoedit
uv sync

cd /Users/mychanging/Desktop/autoedit/apps/web
npm install</code></pre>
      </section>

      <section id="run">
        <h2>启动</h2>
        <pre><code>cd /Users/mychanging/Desktop/autoedit/apps/web
npm run dev:all</code></pre>
        <p>默认端口：</p>
        <ul>
          <li>前端：<code>http://localhost:12080</code></li>
          <li>API：<code>http://localhost:12081</code></li>
        </ul>
      </section>

      <section id="routes">
        <h2>页面</h2>
        <ul>
          <li><code>/projects</code>：项目列表</li>
          <li><code>/library</code>：素材库</li>
          <li><code>/projects/:projectId/edit</code>：项目级字幕编辑与 Agent 工作台</li>
        </ul>
      </section>

      <section id="cli">
        <h2>CLI</h2>
        <p>CLI 现在只保留和剪辑 / 字幕有关的命令。</p>
        <pre><code>autoedit asr audio.mp3 --format srt
autoedit asr audio.mp3 --format json -o result.json
autoedit asr-split audio.lines.json --line 10 --after "理解"
autoedit cut
autoedit config --show</code></pre>
        <p><code>autoedit cut</code> 现在会直接打开新项目工作流入口，不再暴露旧的单视频 cut 页面。</p>
      </section>

      <section id="exports">
        <h2>导出</h2>
        <ul>
          <li>导出视频：最终成片</li>
          <li>导出工程：Premiere / Resolve XML、EDL、剪映 SRT</li>
          <li>导出完整工程包：XML / EDL / SRT + 原视频素材 + manifest</li>
        </ul>
      </section>

      <section id="config">
        <h2>配置</h2>
        <p>当前配置围绕 ASR、Agent 和 workspace：</p>
        <ul>
          <li><code>asr_model_size</code></li>
          <li><code>asr_language</code></li>
          <li><code>workspace_dir</code></li>
          <li><code>dashboard_port</code> / <code>api_port</code></li>
          <li><code>siliconflow_api_key</code></li>
          <li><code>agent_llm_provider</code> / <code>agent_llm_model</code></li>
        </ul>
        <p>默认主配置文件：<code>.autoedit/config.json</code></p>
      </section>
    </main>
  </div>
</template>

<style scoped>
.docs {
  display: grid;
  grid-template-columns: 240px 1fr;
  min-height: 100vh;
  background: #0a0e13;
  color: #edf3f9;
}

.sidebar {
  border-right: 1px solid #243140;
  padding: 24px 18px;
  position: sticky;
  top: 0;
  height: 100vh;
  background: #0d1218;
}

.sidebar-title {
  font-size: 18px;
  font-weight: 700;
  margin-bottom: 16px;
}

.sidebar a {
  display: block;
  color: #a7b7c9;
  text-decoration: none;
  padding: 7px 0;
}

.sidebar a:hover {
  color: #fff;
}

.content {
  padding: 40px;
}

section {
  margin-bottom: 34px;
}

h1 {
  font-size: 40px;
  margin-bottom: 12px;
}

h2 {
  font-size: 24px;
  margin-bottom: 12px;
}

p,
li {
  color: #d5dfeb;
  line-height: 1.8;
}

pre {
  margin: 12px 0 0;
  padding: 16px;
  background: #10161d;
  border: 1px solid #243140;
  overflow: auto;
}

code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

@media (max-width: 900px) {
  .docs {
    grid-template-columns: 1fr;
  }

  .sidebar {
    position: static;
    height: auto;
    border-right: none;
    border-bottom: 1px solid #243140;
  }

  .content {
    padding: 24px;
  }
}
</style>
