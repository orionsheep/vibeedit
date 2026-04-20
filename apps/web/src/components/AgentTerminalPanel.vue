<template>
  <div class="agent-terminal" :class="{ 'performance-mode': props.performanceMode }">
    <div class="terminal-toolbar">
      <button class="terminal-link" :disabled="!canOpenDocument" @click="$emit('open-document')">文稿</button>
      <button class="terminal-link" :disabled="runningAgent" @click="$emit('new-session')">新会话</button>
      <button class="terminal-link" title="隐藏 Agent 栏" @click="$emit('toggle-collapse')">&gt;&gt;</button>
    </div>

    <div ref="scrollRef" class="terminal-scroll">
      <template v-if="pendingConfirmationRun">
        <div class="terminal-entry">
          <div class="entry-label system">$ CONFIRMATION</div>
          <pre class="entry-copy">{{ pendingConfirmationRun.result?.confirmation_prompt || pendingConfirmationRun.result?.reply || '这一步需要你确认后再执行。' }}</pre>
          <div class="confirmation-actions">
            <button class="ghost-btn" :disabled="runningAgent" @click="$emit('confirm', false)">取消</button>
            <button class="primary-btn" :disabled="runningAgent" @click="$emit('confirm', true)">确认执行</button>
          </div>
        </div>
      </template>

      <template v-if="messages.length">
        <div
          v-for="(message, index) in messages"
          :key="message.id"
          class="terminal-entry"
        >
          <div class="entry-label" :class="message.role === 'user' ? 'user' : 'assistant'">
            {{ message.role === 'user' ? '$ USER' : '$ AGENT' }}
          </div>
          <pre v-if="message.role === 'user'" class="entry-copy">{{ message.content }}</pre>
          <div
            v-else
            class="entry-markdown"
            v-html="renderMarkdown(message.content)"
          ></div>
          <div v-if="message.role !== 'user' && canOpenDocument && index === messages.length - 1" class="entry-actions">
            <button class="terminal-link" @click="$emit('open-document')">{{ documentActionLabel }}</button>
          </div>
        </div>
      </template>
      <template v-else>
        <div class="terminal-entry">
          <div class="entry-label system">$ READY</div>
          <pre class="entry-copy">直接输入要求，例如“执行口播拼稿，尽量完整保留，只删重复版本、口头禅和停顿”或“执行直播切片，先给我 4 个候选”。</pre>
        </div>
      </template>

      <div v-if="showThinkingBubble" class="terminal-entry thinking-entry" :class="`tone-${thinkingTone}`">
        <div class="thinking-shell">
          <div class="thinking-hero">
            <div class="thinking-reactor" aria-hidden="true">
              <span class="reactor-ring ring-a"></span>
              <span class="reactor-ring ring-b"></span>
              <span class="reactor-ring ring-c"></span>
              <span class="reactor-core"></span>
            </div>

            <div class="thinking-copy-block">
              <div class="entry-label system">$ {{ statusLabel || 'RUNNING' }}</div>
              <strong class="thinking-title">{{ thinkingTitle }}</strong>
              <p class="thinking-subtitle">{{ thinkingSubtitle }}</p>
            </div>

            <div class="thinking-meter" aria-hidden="true">
              <span v-for="bar in 6" :key="bar" class="meter-bar"></span>
            </div>
          </div>

          <div class="thinking-stage-row">
            <span
              v-for="stage in thinkingStages"
              :key="stage.key"
              class="thinking-stage-pill"
              :class="stage.state"
            >
              {{ stage.label }}
            </span>
          </div>

          <div v-if="thinkingTicker.length" class="thinking-ticker">
            <span class="ticker-label">最近动作</span>
            <div class="ticker-track">
              <span v-for="item in thinkingTicker" :key="item" class="ticker-chip">{{ item }}</span>
            </div>
          </div>

          <template v-if="recentEvents.length">
            <div v-for="event in recentEvents" :key="event.id" class="event-line enriched">
              <span class="event-ping"></span>
              <div class="event-copy">
                <span class="event-step">{{ event.step || event.type }}</span>
                <span class="event-message">{{ event.message }}</span>
              </div>
            </div>
          </template>
          <pre v-else class="entry-copy">正在处理，请稍等…</pre>
        </div>
      </div>
    </div>

    <footer class="terminal-footer">
      <div class="footer-mode-row">
        <span class="prompt-marker">&gt;</span>
        <select :value="modeValue" @change="$emit('update:modeValue', $event.target.value)">
          <option value="assemble_script">口播拼稿</option>
          <option value="live_slicing">直播切片</option>
          <option value="custom">自由指令</option>
        </select>
      </div>
      <textarea
        :value="promptValue"
        :placeholder="placeholder"
        @input="$emit('update:promptValue', $event.target.value)"
        @keydown="handlePromptKeydown"
        @compositionstart="handleCompositionStart"
        @compositionend="handleCompositionEnd"
      ></textarea>
      <div class="footer-actions">
        <button class="primary-btn" :disabled="runningAgent || stoppingAgent" @click="$emit('run')">
          {{ runningAgent ? '处理中...' : '执行' }}
        </button>
        <button class="ghost-btn" :disabled="(!runningAgent && !canStop) || stoppingAgent" @click="$emit('stop')">
          {{ stoppingAgent ? '正在停止...' : '停止' }}
        </button>
      </div>
    </footer>
  </div>
</template>

<script setup>
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { renderAgentMarkdown } from '../utils/agentMarkdown';

const props = defineProps({
  messages: { type: Array, default: () => [] },
  events: { type: Array, default: () => [] },
  pendingConfirmationRun: { type: Object, default: null },
  showThinkingBubble: { type: Boolean, default: false },
  statusLabel: { type: String, default: '' },
  modeValue: { type: String, default: 'assemble_script' },
  promptValue: { type: String, default: '' },
  placeholder: { type: String, default: '' },
  runningAgent: { type: Boolean, default: false },
  stoppingAgent: { type: Boolean, default: false },
  canStop: { type: Boolean, default: false },
  performanceMode: { type: Boolean, default: false },
  canOpenDocument: { type: Boolean, default: false },
  documentActionLabel: { type: String, default: '打开文稿' }
});

const emit = defineEmits([
  'new-session',
  'open-document',
  'toggle-collapse',
  'confirm',
  'run',
  'stop',
  'update:modeValue',
  'update:promptValue'
]);

const scrollRef = ref(null);
const isComposing = ref(false);
let scrollAnimationFrame = null;

const STAGE_DEFINITIONS = [
  { key: 'plan', label: '理解' },
  { key: 'tool', label: '操作' },
  { key: 'review', label: '校验' },
  { key: 'finish', label: '收口' }
];

function renderMarkdown(content = '') {
  return renderAgentMarkdown(content);
}

const recentEvents = computed(() => (Array.isArray(props.events) ? props.events : []).slice(-4));

const latestEvent = computed(() => recentEvents.value[recentEvents.value.length - 1] || null);

const thinkingTone = computed(() => {
  const status = String(props.statusLabel || '');
  if (props.stoppingAgent || /停止|取消|cancell/i.test(status)) return 'warning';
  if (props.pendingConfirmationRun || /确认|等待/.test(status)) return 'hold';
  return 'active';
});

function inferStageKey(event, statusLabel = '') {
  const type = String(event?.type || '').trim();
  const status = String(statusLabel || '').trim();

  if (type === 'complete' || /完成|收口/.test(status)) return 'finish';
  if (['review_start', 'review_fixed', 'review_passed'].includes(type) || /审查|校验/.test(status)) return 'review';
  if (['tool_call', 'tool_result', 'waiting_confirmation'].includes(type) || /确认|工具|停止/.test(status)) return 'tool';
  return 'plan';
}

const currentStageKey = computed(() => inferStageKey(latestEvent.value, props.statusLabel));

const thinkingStages = computed(() => {
  const activeIndex = Math.max(0, STAGE_DEFINITIONS.findIndex((stage) => stage.key === currentStageKey.value));
  return STAGE_DEFINITIONS.map((stage, index) => ({
    ...stage,
    state: index < activeIndex ? 'done' : index === activeIndex ? 'active' : 'idle'
  }));
});

const thinkingTicker = computed(() => recentEvents.value
  .map((event) => String(event.step || event.type || '').trim())
  .filter(Boolean)
  .slice(-3));

const thinkingTitle = computed(() => {
  if (props.stoppingAgent) return '正在安全中断当前运行';
  if (props.pendingConfirmationRun) return '等待确认下一步工具动作';
  if (latestEvent.value?.message) return latestEvent.value.message;
  if (props.statusLabel) return `Agent 正在${props.statusLabel}`;
  return 'Agent 正在处理当前项目';
});

const thinkingSubtitle = computed(() => {
  const eventCount = recentEvents.value.length;
  const latestStep = String(latestEvent.value?.step || latestEvent.value?.type || '').trim();
  if (props.pendingConfirmationRun) {
    return '当前动作需要人工确认；确认前不会继续改动时间线。';
  }
  if (!eventCount) {
    return '正在建立本轮执行上下文，并准备进入工具调用。';
  }
  return latestStep
    ? `当前阶段：${latestStep} · 近期 ${eventCount} 条运行事件`
    : `近期 ${eventCount} 条运行事件正在持续刷新`;
});

function scrollToBottom() {
  if (props.performanceMode) return;
  if (scrollAnimationFrame) return;

  scrollAnimationFrame = requestAnimationFrame(() => {
    scrollAnimationFrame = null;
    nextTick(() => {
      if (!scrollRef.value) return;
      scrollRef.value.scrollTop = scrollRef.value.scrollHeight;
    });
  });
}

watch(
  () => [
    props.messages.length,
    props.events.length,
    props.showThinkingBubble,
    props.pendingConfirmationRun ? 1 : 0
  ],
  scrollToBottom
);

onUnmounted(() => {
  if (scrollAnimationFrame) {
    cancelAnimationFrame(scrollAnimationFrame);
    scrollAnimationFrame = null;
  }
});

function handleCompositionStart() {
  isComposing.value = true;
}

function handleCompositionEnd() {
  isComposing.value = false;
}

function handlePromptKeydown(event) {
  if (event.key !== 'Enter') return;
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.isComposing || isComposing.value) return;
  if (props.runningAgent || props.stoppingAgent) return;
  if (!String(props.promptValue || '').trim()) return;

  event.preventDefault();
  emit('run');
}
</script>

<style scoped>
.agent-terminal {
  height: 100%;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  background: #0a0f14;
  color: #d6e3ef;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Monaco, Consolas, monospace;
}

.terminal-toolbar {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 9px 12px 10px;
  border-bottom: 1px solid #16232d;
  background: linear-gradient(180deg, rgba(8, 14, 20, 0.98) 0%, rgba(7, 12, 18, 0.98) 100%);
}

.terminal-scroll {
  min-height: 0;
  overflow: auto;
  padding: 12px 12px 16px;
  background:
    radial-gradient(circle at top right, rgba(88, 219, 255, 0.06), transparent 24%),
    linear-gradient(180deg, rgba(8, 14, 20, 0.76) 0%, rgba(7, 12, 18, 0.98) 100%);
}

.terminal-link,
.ghost-btn,
.primary-btn,
.footer-mode-row select,
.terminal-footer textarea {
  font: inherit;
}

.terminal-link {
  border: 1px solid rgba(88, 219, 255, 0.08);
  background: rgba(8, 15, 22, 0.78);
  color: #80dfff;
  min-height: 28px;
  padding: 0 9px;
  cursor: pointer;
  font-size: 11px;
  transition: border-color 0.15s, background-color 0.15s, color 0.15s;
}

.terminal-link:hover:not(:disabled) {
  border-color: rgba(88, 219, 255, 0.18);
  background: rgba(10, 18, 27, 0.96);
  color: #dff7ff;
}

.terminal-entry {
  padding: 0 0 12px;
  margin-bottom: 12px;
  border-bottom: 1px solid #16232d;
}

.entry-actions {
  margin-top: 10px;
}

.thinking-entry {
  border-bottom-style: dashed;
}

.thinking-shell {
  position: relative;
  display: grid;
  gap: 10px;
  padding: 11px 12px;
  border: 1px solid #19303f;
  background:
    radial-gradient(circle at top right, rgba(43, 174, 255, 0.14), transparent 34%),
    linear-gradient(180deg, rgba(8, 16, 24, 0.98) 0%, rgba(9, 14, 20, 0.98) 100%);
  overflow: hidden;
}

.thinking-shell::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    linear-gradient(115deg, transparent 0%, transparent 36%, rgba(123, 226, 255, 0.08) 50%, transparent 64%, transparent 100%);
  background-size: 210% 100%;
  animation: thinkingSweep 3.4s linear infinite;
  pointer-events: none;
}

.agent-terminal.performance-mode .thinking-shell::before,
.agent-terminal.performance-mode .meter-bar,
.agent-terminal.performance-mode .reactor-ring,
.agent-terminal.performance-mode .reactor-core {
  animation: none !important;
}

.agent-terminal.performance-mode .thinking-shell,
.agent-terminal.performance-mode .terminal-entry,
.agent-terminal.performance-mode .primary-btn,
.agent-terminal.performance-mode .ghost-btn,
.agent-terminal.performance-mode .terminal-link {
  transition: none !important;
}

.tone-hold .thinking-shell {
  border-color: rgba(214, 174, 92, 0.42);
  background:
    radial-gradient(circle at top right, rgba(214, 174, 92, 0.16), transparent 36%),
    linear-gradient(180deg, rgba(21, 17, 10, 0.98) 0%, rgba(14, 12, 9, 0.98) 100%);
}

.tone-warning .thinking-shell {
  border-color: rgba(255, 139, 90, 0.42);
  background:
    radial-gradient(circle at top right, rgba(255, 139, 90, 0.16), transparent 36%),
    linear-gradient(180deg, rgba(24, 14, 12, 0.98) 0%, rgba(18, 11, 10, 0.98) 100%);
}

.thinking-hero {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
}

.thinking-reactor {
  position: relative;
  width: 36px;
  height: 36px;
}

.reactor-ring,
.reactor-core {
  position: absolute;
  inset: 0;
  border-radius: 999px;
}

.reactor-ring {
  border: 1px solid rgba(118, 220, 255, 0.42);
}

.reactor-ring.ring-a {
  animation: reactorSpin 3.4s linear infinite;
}

.reactor-ring.ring-b {
  inset: 4px;
  border-style: dashed;
  animation: reactorSpinReverse 2.9s linear infinite;
}

.reactor-ring.ring-c {
  inset: 9px;
  border-color: rgba(118, 220, 255, 0.28);
  animation: reactorPulse 1.8s ease-in-out infinite;
}

.reactor-core {
  inset: 12px;
  background: radial-gradient(circle, #95efff 0%, #23c4ff 58%, rgba(35, 196, 255, 0.08) 100%);
  box-shadow: 0 0 18px rgba(35, 196, 255, 0.42);
}

.thinking-copy-block {
  min-width: 0;
  display: grid;
  gap: 4px;
}

.thinking-title {
  display: block;
  font-size: 13px;
  line-height: 1.42;
  color: #f3fbff;
}

.thinking-subtitle {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: #96afc0;
}

.thinking-meter {
  display: inline-flex;
  align-items: flex-end;
  gap: 3px;
  height: 24px;
}

.meter-bar {
  width: 4px;
  border-radius: 999px;
  background: linear-gradient(180deg, rgba(119, 228, 255, 0.92) 0%, rgba(22, 197, 255, 0.18) 100%);
  animation: meterBounce 1.2s ease-in-out infinite;
}

.meter-bar:nth-child(1) { height: 10px; animation-delay: 0.04s; }
.meter-bar:nth-child(2) { height: 16px; animation-delay: 0.12s; }
.meter-bar:nth-child(3) { height: 24px; animation-delay: 0.2s; }
.meter-bar:nth-child(4) { height: 14px; animation-delay: 0.28s; }
.meter-bar:nth-child(5) { height: 21px; animation-delay: 0.36s; }
.meter-bar:nth-child(6) { height: 12px; animation-delay: 0.44s; }

.thinking-stage-row {
  position: relative;
  z-index: 1;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.thinking-stage-pill {
  border: 1px solid #233847;
  background: rgba(12, 20, 28, 0.84);
  color: #688397;
  padding: 3px 7px;
  font-size: 10px;
  letter-spacing: 0.04em;
}

.thinking-stage-pill.done {
  border-color: rgba(97, 216, 255, 0.28);
  color: #99ecff;
  background: rgba(15, 37, 48, 0.82);
}

.thinking-stage-pill.active {
  border-color: #16c5ff;
  color: #f6fcff;
  background: linear-gradient(90deg, rgba(22, 197, 255, 0.24), rgba(14, 29, 38, 0.9));
  box-shadow: inset 0 0 0 1px rgba(22, 197, 255, 0.1);
}

.thinking-ticker {
  position: relative;
  z-index: 1;
  display: grid;
  gap: 6px;
}

.ticker-label {
  font-size: 10px;
  color: #77cfff;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.ticker-track {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.ticker-chip {
  border: 1px solid #223342;
  background: rgba(10, 18, 25, 0.88);
  color: #d8e7f2;
  padding: 4px 7px;
  font-size: 10px;
}

.entry-label {
  margin-bottom: 8px;
  color: #95adbf;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.entry-label.user {
  color: #8fe7ff;
}

.entry-label.assistant {
  color: #d7e6f1;
}

.entry-label.system {
  color: #73c8ff;
}

.entry-copy {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.68;
  font-size: 13px;
  color: #eef7fd;
}

.entry-markdown {
  color: #eef7fd;
  font-size: 13px;
  line-height: 1.68;
  word-break: break-word;
}

.entry-markdown :deep(h1),
.entry-markdown :deep(h2),
.entry-markdown :deep(h3),
.entry-markdown :deep(h4),
.entry-markdown :deep(h5),
.entry-markdown :deep(h6) {
  margin: 0 0 10px;
  font-size: 16px;
  line-height: 1.45;
  color: #f4fbff;
}

.entry-markdown :deep(p),
.entry-markdown :deep(ul),
.entry-markdown :deep(ol),
.entry-markdown :deep(table) {
  margin: 0 0 12px;
}

.entry-markdown :deep(ul),
.entry-markdown :deep(ol) {
  padding-left: 22px;
}

.entry-markdown :deep(li) {
  margin: 4px 0;
}

.entry-markdown :deep(hr) {
  border: 0;
  border-top: 1px solid #1b2b36;
  margin: 12px 0;
}

.entry-markdown :deep(code) {
  background: #101921;
  border: 1px solid #1d2b35;
  border-radius: 4px;
  padding: 1px 5px;
  color: #8fe7ff;
  font-size: 12px;
}

.entry-markdown :deep(table) {
  width: 100%;
  border-collapse: collapse;
  display: block;
  overflow-x: auto;
}

.entry-markdown :deep(th),
.entry-markdown :deep(td) {
  border: 1px solid #1b2b36;
  padding: 6px 8px;
  text-align: left;
  vertical-align: top;
}

.entry-markdown :deep(th) {
  background: #0f1820;
  color: #bfe9ff;
  font-weight: 700;
}

.event-line {
  display: grid;
  gap: 2px;
  margin-bottom: 8px;
}

.event-line.enriched {
  position: relative;
  z-index: 1;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 10px;
  align-items: start;
  margin-bottom: 0;
  padding: 7px 9px;
  border: 1px solid #162734;
  background: rgba(7, 14, 20, 0.76);
}

.event-ping {
  width: 8px;
  height: 8px;
  margin-top: 5px;
  border-radius: 999px;
  background: #7fe2ff;
  box-shadow: 0 0 0 0 rgba(127, 226, 255, 0.5);
  animation: eventPing 1.8s ease-out infinite;
}

.event-copy {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.event-step {
  color: #73c8ff;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.event-message {
  color: #d7e6f1;
  font-size: 12px;
  line-height: 1.5;
}

.tone-warning .reactor-ring,
.tone-warning .event-ping {
  border-color: rgba(255, 160, 107, 0.42);
  background: #ff8b5a;
}

.tone-warning .reactor-core {
  background: radial-gradient(circle, #ffd1bf 0%, #ff8b5a 58%, rgba(255, 139, 90, 0.08) 100%);
  box-shadow: 0 0 18px rgba(255, 139, 90, 0.34);
}

.tone-hold .reactor-ring,
.tone-hold .event-ping {
  border-color: rgba(232, 205, 109, 0.42);
  background: #d7ae5a;
}

.tone-hold .reactor-core {
  background: radial-gradient(circle, #fff1ba 0%, #d7ae5a 58%, rgba(215, 174, 90, 0.08) 100%);
  box-shadow: 0 0 18px rgba(215, 174, 90, 0.34);
}

.terminal-footer {
  border-top: 1px solid #16232d;
  padding: 10px 12px 12px;
  display: grid;
  gap: 8px;
  background: linear-gradient(180deg, rgba(8, 14, 20, 0.98) 0%, rgba(7, 11, 17, 1) 100%);
}

.footer-mode-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.prompt-marker {
  color: #8fe7ff;
  font-size: 16px;
  line-height: 1;
}

.footer-mode-row select,
.terminal-footer textarea {
  width: 100%;
  border: 1px solid #17242f;
  background: #0c1218;
  color: #eef7fd;
}

.footer-mode-row select {
  height: 30px;
  padding: 0 8px;
}

.terminal-footer textarea {
  min-height: 84px;
  resize: none;
  padding: 10px;
  line-height: 1.6;
}

.footer-actions,
.confirmation-actions {
  display: flex;
  gap: 8px;
}

.ghost-btn,
.primary-btn {
  border: 1px solid #20303b;
  background: #0c1218;
  color: #d7e6f1;
  min-height: 32px;
  padding: 7px 12px;
  cursor: pointer;
}

.primary-btn {
  background: #16c5ff;
  color: #071018;
  border-color: #16c5ff;
  font-weight: 700;
}

@keyframes thinkingSweep {
  0% {
    background-position: 200% 0;
  }
  100% {
    background-position: -40% 0;
  }
}

@keyframes reactorSpin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@keyframes reactorSpinReverse {
  from { transform: rotate(360deg); }
  to { transform: rotate(0deg); }
}

@keyframes reactorPulse {
  0%, 100% { transform: scale(0.96); opacity: 0.6; }
  50% { transform: scale(1.02); opacity: 1; }
}

@keyframes meterBounce {
  0%, 100% { transform: scaleY(0.55); opacity: 0.45; }
  50% { transform: scaleY(1); opacity: 1; }
}

@keyframes eventPing {
  0% {
    box-shadow: 0 0 0 0 rgba(127, 226, 255, 0.48);
  }
  70% {
    box-shadow: 0 0 0 8px rgba(127, 226, 255, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(127, 226, 255, 0);
  }
}
</style>
