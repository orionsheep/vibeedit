<template>
  <teleport to="body">
    <div v-if="visible" class="document-modal-backdrop" @click.self="$emit('close')">
      <div class="document-modal-shell">
        <header class="document-modal-header">
          <div class="document-modal-copy">
            <strong>{{ title }}</strong>
            <span>{{ subtitle }}</span>
          </div>
          <button class="document-close-btn" @click="$emit('close')">关闭</button>
        </header>

        <div class="document-modal-body">
          <aside v-if="sections.length > 1" class="document-section-nav">
            <button
              v-for="section in sections"
              :key="section.id"
              class="document-section-chip"
              :class="{ active: section.id === activeSectionId }"
              @click="$emit('select-section', section.id)"
            >
              <span class="document-section-kicker">{{ section.kicker || '文稿' }}</span>
              <strong>{{ section.title }}</strong>
              <small>{{ section.summary || '点击查看内容' }}</small>
            </button>
          </aside>

          <section class="document-content">
            <div v-if="loading" class="document-state">正在整理文稿...</div>
            <div v-else-if="!activeSection" class="document-state">当前还没有可显示的文稿内容。</div>
            <template v-else>
              <header class="document-active-head">
                <div>
                  <strong>{{ activeSection.title }}</strong>
                  <span>{{ activeSection.kicker || '文稿' }}</span>
                </div>
                <p v-if="activeSection.summary" class="document-summary">{{ activeSection.summary }}</p>
              </header>

              <div v-if="activeSection.blocks?.length" class="document-block-list">
                <article
                  v-for="(block, index) in activeSection.blocks"
                  :key="block.id || `${activeSection.id}_${index}`"
                  class="document-block"
                >
                  <div class="document-block-meta">
                    <span>第 {{ index + 1 }} 段</span>
                    <strong>{{ formatTime(block.start) }} - {{ formatTime(block.end) }}</strong>
                  </div>
                  <p>{{ block.text }}</p>
                </article>
              </div>
              <pre v-else-if="activeSection.fullText" class="document-fallback">{{ activeSection.fullText }}</pre>
              <div v-else class="document-state">当前文稿还没有可用段落。</div>
            </template>
          </section>
        </div>
      </div>
    </div>
  </teleport>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  visible: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
  title: { type: String, default: '文稿预览' },
  subtitle: { type: String, default: '' },
  sections: { type: Array, default: () => [] },
  activeSectionId: { type: String, default: '' }
});

defineEmits(['close', 'select-section']);

const activeSection = computed(() => (
  props.sections.find((section) => section.id === props.activeSectionId) || props.sections[0] || null
));

function formatTime(seconds) {
  const safe = Number(seconds || 0);
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}
</script>

<style scoped>
.document-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 80;
  background: rgba(5, 9, 13, 0.78);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.document-modal-shell {
  width: min(1180px, 100%);
  height: min(82vh, 900px);
  background: #0b1218;
  border: 1px solid #1a2933;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  box-shadow: 0 28px 80px rgba(0, 0, 0, 0.45);
}

.document-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 18px;
  border-bottom: 1px solid #18252f;
}

.document-modal-copy {
  display: grid;
  gap: 4px;
}

.document-modal-copy strong {
  color: #eef7fd;
  font-size: 16px;
}

.document-modal-copy span {
  color: #8fa7b8;
  font-size: 12px;
}

.document-close-btn {
  border: 1px solid #29404f;
  background: #101921;
  color: #d8e8f4;
  font: inherit;
  padding: 8px 12px;
  cursor: pointer;
}

.document-modal-body {
  min-height: 0;
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
}

.document-section-nav {
  min-height: 0;
  overflow: auto;
  border-right: 1px solid #18252f;
  background: #091017;
  padding: 12px;
  display: grid;
  align-content: start;
  gap: 8px;
}

.document-section-chip {
  display: grid;
  gap: 4px;
  text-align: left;
  border: 1px solid #18252f;
  background: #0d151c;
  color: #d6e3ef;
  padding: 10px 12px;
  cursor: pointer;
}

.document-section-chip.active {
  border-color: #3dbdff;
  background: rgba(61, 189, 255, 0.12);
}

.document-section-kicker {
  font-size: 11px;
  color: #7db7dc;
}

.document-section-chip strong {
  font-size: 13px;
}

.document-section-chip small {
  font-size: 11px;
  line-height: 1.5;
  color: #90a7b7;
}

.document-content {
  min-height: 0;
  overflow: auto;
  padding: 18px;
  display: grid;
  align-content: start;
  gap: 14px;
}

.document-active-head {
  display: grid;
  gap: 8px;
}

.document-active-head strong {
  color: #f3fbff;
  font-size: 18px;
}

.document-active-head span {
  margin-left: 8px;
  font-size: 12px;
  color: #89aac2;
}

.document-summary {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: #9eb7c8;
}

.document-block-list {
  display: grid;
  gap: 12px;
}

.document-block {
  border: 1px solid #18252f;
  background: #0d151c;
  padding: 12px 14px;
}

.document-block-meta {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
  font-size: 12px;
  color: #7ea9c7;
}

.document-block p,
.document-fallback {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  color: #eef7fd;
  line-height: 1.75;
  font-size: 14px;
}

.document-state {
  color: #8ea6b7;
  font-size: 13px;
}

@media (max-width: 960px) {
  .document-modal-body {
    grid-template-columns: 1fr;
  }

  .document-section-nav {
    border-right: none;
    border-bottom: 1px solid #18252f;
    grid-auto-flow: column;
    grid-auto-columns: minmax(180px, 220px);
  }
}
</style>
