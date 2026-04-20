<template>
  <div class="landing">
    <section class="hero">
      <div class="hero-copy">
        <div class="eyebrow">VIBEEDIT</div>
        <h1>只做 Agent 剪辑与字幕</h1>
        <p>
          这是一个本地优先的视频剪辑工作台。它不再追求语音合成、设备播放、声音克隆这些分散能力，
          现在只围绕一条主链路：<strong>识别字幕 → 编辑时间线 → 聊天式 Agent 剪辑 → 导出成片与交换文件</strong>。
        </p>
        <div class="cta-row">
          <router-link class="btn primary" to="/projects">进入项目系统</router-link>
          <router-link class="btn" to="/library">打开素材库</router-link>
          <router-link class="btn" to="/docs">查看文档</router-link>
        </div>
      </div>

      <div class="hero-panel">
        <div class="panel-title">当前产品边界</div>
        <ul>
          <li>保留：Agent 剪辑</li>
          <li>保留：字幕生成 / 编辑 / 导出</li>
          <li>保留：多项目、素材库、视频导出与工程交换</li>
          <li>删除：TTS、设备发现、声音克隆、声音设计</li>
        </ul>
      </div>
    </section>

    <section class="grid">
      <div class="card">
        <h2>工作流</h2>
        <p>素材先进入全局素材库，再被引用到项目中；项目内由多视频时间线、字幕段落和右侧 Agent 一起驱动剪辑。</p>
      </div>
      <div class="card">
        <h2>交互方式</h2>
        <p>你既可以手工删词、删停顿，也可以直接说“压成 60 秒”“只保留 AI 相关内容”“把空白停顿剪掉”。</p>
      </div>
      <div class="card">
        <h2>预览与导出</h2>
        <p>实时预览负责快速反馈，精确预览负责接近最终成片；导出支持视频，以及 XML / EDL / SRT 这类外部软件交换文件。</p>
      </div>
      <div class="card">
        <h2>模型策略</h2>
        <p>当前默认走 Claude Agent SDK + GLM Claude-compatible 主链，同时保留显式备援能力，不把未来锁死在单一模型上。</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.landing {
  min-height: 100vh;
  padding: 48px;
  background:
    radial-gradient(circle at top right, rgba(88, 219, 255, 0.16), transparent 28%),
    radial-gradient(circle at left center, rgba(117, 162, 255, 0.09), transparent 22%),
    linear-gradient(180deg, #081017 0%, #0b0f14 100%);
  color: var(--app-copy);
}

.hero {
  display: grid;
  grid-template-columns: 1.5fr 0.9fr;
  gap: 24px;
  margin-bottom: 24px;
}

.hero-copy,
.hero-panel,
.card {
  background: rgba(16, 21, 28, 0.92);
  border: 1px solid var(--app-border);
  padding: 26px;
  box-shadow: var(--app-shadow);
}

.eyebrow {
  color: var(--app-accent-strong);
  font-size: 12px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  margin-bottom: 14px;
  font-family: var(--font-mono);
}

h1 {
  font-size: 56px;
  line-height: 1.05;
  margin-bottom: 18px;
}

p {
  color: var(--app-copy-muted);
  line-height: 1.8;
}

.cta-row {
  display: flex;
  gap: 12px;
  margin-top: 22px;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 11px 16px;
  border: 1px solid var(--app-border-strong);
  color: var(--app-copy);
  text-decoration: none;
  background: rgba(10, 18, 27, 0.92);
}

.btn.primary {
  background: linear-gradient(135deg, #58dbff, #7fe9ff);
  border-color: transparent;
  color: #071018;
  font-weight: 600;
}

.panel-title {
  font-size: 14px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--app-copy-soft);
  margin-bottom: 12px;
  font-family: var(--font-mono);
}

.hero-panel ul {
  margin: 0;
  padding-left: 18px;
  color: var(--app-copy);
}

.hero-panel li {
  margin-bottom: 10px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
}

.card h2 {
  font-size: 22px;
  margin-bottom: 10px;
}

@media (max-width: 980px) {
  .landing {
    padding: 24px;
  }

  .hero,
  .grid {
    grid-template-columns: 1fr;
  }

  h1 {
    font-size: 38px;
  }
}
</style>
