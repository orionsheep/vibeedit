<template>
  <div class="agent-terminal">
    <div class="terminal-toolbar">
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
          v-for="message in messages"
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
        </div>
      </template>
      <template v-else>
        <div class="terminal-entry">
          <div class="entry-label system">$ READY</div>
          <pre class="entry-copy">直接输入要求，例如“执行口播拼稿，尽量完整保留，只删重复版本、口头禅和停顿”或“执行直播切片，先给我 4 个候选”。</pre>
        </div>
      </template>

      <div v-if="showThinkingBubble" class="terminal-entry thinking-entry">
        <div class="entry-label system">$ {{ statusLabel || 'RUNNING' }}</div>
        <template v-if="events.length">
          <div v-for="event in events" :key="event.id" class="event-line">
            <span class="event-step">{{ event.step || event.type }}</span>
            <span class="event-message">{{ event.message }}</span>
          </div>
        </template>
        <pre v-else class="entry-copy">正在处理，请稍等…</pre>
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
import { nextTick, ref, watch } from 'vue';

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
  canStop: { type: Boolean, default: false }
});

const emit = defineEmits([
  'new-session',
  'toggle-collapse',
  'confirm',
  'run',
  'stop',
  'update:modeValue',
  'update:promptValue'
]);

const scrollRef = ref(null);
const isComposing = ref(false);

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderInlineMarkdown(value = '') {
  let text = escapeHtml(value);
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return text;
}

function parseTableRow(line = '') {
  return String(line)
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => renderInlineMarkdown(cell.trim()));
}

function isTableSeparator(line = '') {
  const trimmed = String(line).trim();
  return /^\|?[\s:-|]+\|?\s*$/.test(trimmed);
}

function renderMarkdown(content = '') {
  const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
  const html = [];
  const blocks = [];
  let currentBlock = [];

  for (const rawLine of lines) {
    if (!String(rawLine || '').trim()) {
      if (currentBlock.length) {
        blocks.push(currentBlock);
        currentBlock = [];
      }
      continue;
    }
    currentBlock.push(rawLine);
  }
  if (currentBlock.length) {
    blocks.push(currentBlock);
  }

  for (const block of blocks) {
    const first = String(block[0] || '').trim();

    if (block.length === 1 && (/^---+$/.test(first) || /^\*\*\*+$/.test(first))) {
      html.push('<hr />');
      continue;
    }

    const headingMatch = first.match(/^(#{1,6})\s+(.*)$/);
    if (block.length === 1 && headingMatch) {
      const level = headingMatch[1].length;
      html.push(`<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`);
      continue;
    }

    if (block.length >= 2 && String(block[0] || '').trim().startsWith('|') && isTableSeparator(block[1])) {
      const headerCells = parseTableRow(block[0]);
      const bodyRows = block.slice(2)
        .filter((line) => String(line || '').trim().startsWith('|'))
        .map((line) => parseTableRow(line));
      html.push([
        '<table>',
        `<thead><tr>${headerCells.map((cell) => `<th>${cell}</th>`).join('')}</tr></thead>`,
        bodyRows.length
          ? `<tbody>${bodyRows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody>`
          : '',
        '</table>'
      ].join(''));
      continue;
    }

    const isOrderedList = block.every((line) => /^\d+\.\s+/.test(String(line || '').trim()));
    const isUnorderedList = block.every((line) => /^[-*]\s+/.test(String(line || '').trim()));
    if (isOrderedList || isUnorderedList) {
      const items = block.map((line) => {
        const trimmed = String(line || '').trim();
        const content = isOrderedList
          ? trimmed.replace(/^\d+\.\s+/, '')
          : trimmed.replace(/^[-*]\s+/, '');
        return `<li>${renderInlineMarkdown(content)}</li>`;
      });
      html.push(isOrderedList ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }

    html.push(`<p>${block.map((line) => renderInlineMarkdown(line)).join('<br />')}</p>`);
  }

  return html.join('');
}

function scrollToBottom() {
  nextTick(() => {
    if (!scrollRef.value) return;
    scrollRef.value.scrollTop = scrollRef.value.scrollHeight;
  });
}

watch(() => [props.messages.length, props.events.length, props.showThinkingBubble], scrollToBottom, { deep: true });

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
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid #16232d;
  background: #0a0f14;
}

.terminal-scroll {
  min-height: 0;
  overflow: auto;
  padding: 10px 12px 14px;
}

.terminal-link,
.ghost-btn,
.primary-btn,
.footer-mode-row select,
.terminal-footer textarea {
  font: inherit;
}

.terminal-link {
  border: 0;
  background: transparent;
  color: #80dfff;
  padding: 0;
  cursor: pointer;
}

.terminal-entry {
  padding: 0 0 14px;
  margin-bottom: 14px;
  border-bottom: 1px solid #16232d;
}

.thinking-entry {
  border-bottom-style: dashed;
}

.entry-label {
  margin-bottom: 10px;
  color: #95adbf;
  font-size: 12px;
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
  line-height: 1.7;
  font-size: 14px;
  color: #eef7fd;
}

.entry-markdown {
  color: #eef7fd;
  font-size: 14px;
  line-height: 1.7;
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

.event-step {
  color: #73c8ff;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.event-message {
  color: #d7e6f1;
  font-size: 13px;
  line-height: 1.55;
}

.terminal-footer {
  border-top: 1px solid #16232d;
  padding: 10px 12px 12px;
  display: grid;
  gap: 8px;
  background: #090e12;
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
  min-height: 88px;
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
  padding: 7px 12px;
  cursor: pointer;
}

.primary-btn {
  background: #16c5ff;
  color: #071018;
  border-color: #16c5ff;
  font-weight: 700;
}
</style>
