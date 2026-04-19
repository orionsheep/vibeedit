<template>
  <div class="subtitle-editor">
    <AppConfirmDialog
      :visible="confirmDialog.visible"
      :title="confirmDialog.title"
      :message="confirmDialog.message"
      :confirm-text="confirmDialog.confirmText"
      :cancel-text="confirmDialog.cancelText"
      :danger="confirmDialog.danger"
      @confirm="handleConfirmDialogConfirm"
      @cancel="closeConfirmDialog"
    />
    <div v-if="words.length === 0" class="upload-area">
      <i class="fas fa-cloud-upload-alt"></i>
      <p>当前还没有可编辑字幕内容</p>
      <p style="font-size: 12px; margin-top: 8px; opacity: 0.6;">请先在左侧项目素材区上传视频，或把素材加入当前项目</p>
    </div>

    <template v-else>
      <div class="editor-topbar">
        <div class="editor-topbar-main">
          <div class="editor-header">
            <span class="panel-title">字幕编辑</span>
            <span class="panel-stats">{{ keptWords }}/{{ totalWords }} 字</span>
          </div>
          <div class="editor-toolbar">
            <button
              class="editor-btn danger"
              :disabled="!hasSelection"
              @click="deleteSelected"
              title="删除选中 (Delete/Backspace)"
            >
              <i class="fas fa-trash"></i>
              删除
            </button>
            <button
              class="editor-btn"
              :disabled="!hasSelection"
              @click="restoreSelected"
              title="恢复选中"
            >
              <i class="fas fa-undo"></i>
              恢复
            </button>
            <div class="toolbar-divider"></div>
            <button class="editor-btn danger" @click="confirmClearDeleted">
              <i class="fas fa-broom"></i>
              清除已删除
            </button>
            <div class="toolbar-divider"></div>
            <div class="config-item">
              <label for="gapThreshold">间隙阈值 (秒):</label>
              <input
                id="gapThreshold"
                type="number"
                :value="config.gapThreshold"
                @change="updateGapThreshold"
                step="0.1"
                min="0.1"
                max="5"
                style="width: 60px;"
              />
            </div>
            <div class="toolbar-divider"></div>
          </div>
          <div class="editor-mode-switch">
            <button
              class="mode-switch-btn"
              :class="{ active: props.workspaceMode === 'assemble_script' }"
              @click="$emit('update:workspaceMode', 'assemble_script')"
            >
              口播剪稿
            </button>
            <button
              class="mode-switch-btn"
              :class="{ active: props.workspaceMode === 'live_slicing' }"
              @click="$emit('update:workspaceMode', 'live_slicing')"
            >
              直播切片
            </button>
          </div>
        </div>

        <div v-if="props.workspaceMode === 'live_slicing'" class="slice-inline-toolbar">
          <div class="slice-inline-actions">
            <button
              class="editor-btn"
              :disabled="!props.canCreateSliceFromSelection || props.sliceActionBusy"
              @click="$emit('createSliceFromSelection')"
            >
              新建切片
            </button>
            <button
              class="editor-btn"
              :disabled="!props.canAppendSelectionToSlice || props.sliceActionBusy"
              @click="$emit('appendSelectionToSlice')"
            >
              加入当前切片
            </button>
            <button
              class="editor-btn"
              :disabled="!props.canRemoveSelectionFromSlice || props.sliceActionBusy"
              @click="$emit('removeSelectionFromSlice')"
            >
              从当前切片移出
            </button>
            <button
              class="editor-btn danger"
              :disabled="!props.canDeleteSelectedSlice || props.sliceActionBusy"
              @click="$emit('deleteSelectedSlice')"
            >
              删除当前切片
            </button>
            <span class="slice-inline-hint">{{ props.sliceSelectionHint }}</span>
          </div>

          <div v-if="props.projectSlices.length" class="slice-inline-rail">
            <button
              v-for="slice in props.projectSlices"
              :key="slice.id"
              class="slice-inline-chip"
              :class="{ active: props.selectedSliceId === slice.id }"
              :style="{ '--slice-inline-color': slice.color || '#4cc2ff' }"
              @click="$emit('selectSlice', slice.id)"
            >
              <span class="slice-inline-chip-kicker">{{ slice.total_duration ? formatTime(slice.total_duration) : '00:00' }}</span>
              <strong>{{ slice.title }}</strong>
            </button>
          </div>
        </div>
      </div>

      <div class="editor-container" ref="editorContainer" @mousedown="handleContainerMouseDown">
        <div class="text-content">
          <template v-for="(word, index) in words" :key="index">
            <span
              class="word"
              :class="{
                deleted: isWordDeleted(index),
                selected: isWordSelected(index),
                current: index === currentWordIndex,
                'in-active-slice': Boolean(word.slice_active),
                'has-slice-fill': Boolean(word.slice_markers?.length)
              }"
              :style="getWordStyle(word)"
              :data-index="index"
              :data-start="word.start_time"
              :data-end="word.end_time"
              @mousedown="handleWordMouseDown($event, index)"
              @mouseenter="handleWordMouseEnter($event, index)"
              @mouseup="handleWordMouseUp($event, index)"
              @dblclick="toggleDeleteWord(index)"
              @contextmenu.prevent.stop="openWordContextMenu($event, index)"
            >
              {{ word.text }}
              <span class="time-hint">{{ formatTime(word.start_time) }}</span>
            </span>

            <!-- Render gap after this word if exists -->
            <span
              v-if="getGapAfterWord(index)"
              class="gap"
              :class="{
                deleted: isGapDeleted(getGapAfterWord(index).index),
                selected: isGapSelected(getGapAfterWord(index).index),
                'cross-asset': isCrossAssetGap(getGapAfterWord(index))
              }"
              :style="getGapStyle(getGapAfterWord(index))"
              :data-gap-index="getGapAfterWord(index).index"
              :title="`间隙 ${formatTime(getGapAfterWord(index).duration)}`"
              @mousedown="handleGapMouseDown($event, getGapAfterWord(index).index)"
              @click="handleGapClick($event, getGapAfterWord(index))"
              @dblclick="toggleDeleteGap(getGapAfterWord(index).index)"
              @contextmenu.prevent.stop="openGapContextMenu($event, getGapAfterWord(index).index)"
            >
              <span class="gap-line"></span>
              <span class="gap-label">{{ getGapAfterWord(index).duration.toFixed(1) }}s</span>
            </span>
          </template>
        </div>
      </div>

      <div
        v-if="contextMenu.visible"
        class="subtitle-context-menu"
        :style="contextMenuStyle"
        @contextmenu.prevent
      >
        <button class="context-menu-item danger" @click="handleContextDelete">删除</button>
        <button class="context-menu-item" @click="handleContextRestore">恢复</button>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { storeToRefs } from 'pinia';
import AppConfirmDialog from '../../../components/AppConfirmDialog.vue';
import { useEditorStore } from '../stores/editorStore';

const editorStore = useEditorStore();
const { words, gaps, config, currentWordIndex, totalWords, keptWords, hasSelection } = storeToRefs(editorStore);

// Helper functions to check if a word/gap is deleted or selected
// Access store properties directly to preserve reactivity
function isWordDeleted(index) {
  return editorStore.deletedWords.has(index);
}

function isWordSelected(index) {
  return editorStore.selectedWords.has(index);
}

function isGapDeleted(gapIndex) {
  return editorStore.deletedGaps.has(gapIndex);
}

function isGapSelected(gapIndex) {
  return editorStore.selectedGaps.has(gapIndex);
}

const editorContainer = ref(null);
const contextMenu = ref({
  visible: false,
  x: 0,
  y: 0,
  targetType: '',
  targetIndex: -1
});
const confirmDialog = ref({
  visible: false,
  title: '',
  message: '',
  confirmText: '确认',
  cancelText: '取消',
  danger: false
});
let confirmDialogAction = null;

// Drag selection state
const isDragging = ref(false);
const dragStartIndex = ref(-1);
const isGapDrag = ref(false);
const contextMenuStyle = computed(() => ({
  left: `${contextMenu.value.x}px`,
  top: `${contextMenu.value.y}px`
}));

// Methods
function formatTime(seconds) {
  if (!seconds) return '00:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function getGapAfterWord(index) {
  if (!gaps.value || gaps.value.length === 0) return null;
  return gaps.value.find(g => g.afterWord === index);
}

function buildSliceFill(markers = []) {
  const palette = (Array.isArray(markers) ? markers : [])
    .map((marker) => String(marker?.color || '').trim())
    .filter(Boolean)
    .slice(0, 4);

  if (!palette.length) return '';
  if (palette.length === 1) {
    return `linear-gradient(90deg, color-mix(in srgb, ${palette[0]} 22%, transparent) 0%, color-mix(in srgb, ${palette[0]} 22%, transparent) 100%)`;
  }

  const step = 100 / palette.length;
  const stops = [];
  palette.forEach((color, index) => {
    const start = (step * index).toFixed(3);
    const end = (step * (index + 1)).toFixed(3);
    const tone = `color-mix(in srgb, ${color} 20%, transparent)`;
    stops.push(`${tone} ${start}%`, `${tone} ${end}%`);
  });
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

function getWordStyle(word) {
  const sliceFill = buildSliceFill(word?.slice_markers || []);
  const style = {
    '--word-asset-color': word.asset_color || 'transparent',
    '--word-asset-soft': word.asset_soft || 'transparent',
    '--word-slice-color': word?.slice_active_color || (word?.slice_markers?.[0]?.color || 'transparent'),
    '--word-slice-fill': sliceFill || 'none'
  };

  if (sliceFill) {
    style.backgroundImage = `${sliceFill}, linear-gradient(to bottom, var(--word-asset-color, transparent), var(--word-asset-color, transparent))`;
    style.backgroundRepeat = 'no-repeat, no-repeat';
    style.backgroundPosition = 'left top, left calc(100% - 1px)';
    style.backgroundSize = '100% 100%, 100% 1px';
  }

  if (!word?.asset_color && !word?.asset_soft && !sliceFill && !word?.slice_active_color) return null;
  return style;
}

function isCrossAssetGap(gap) {
  if (!gap) return false;
  const left = words.value[gap.afterWord];
  const right = words.value[gap.beforeWord];
  return Boolean(left?.asset_id && right?.asset_id && left.asset_id !== right.asset_id);
}

function getGapStyle(gap) {
  if (!gap) return null;
  const left = words.value[gap.afterWord];
  const right = words.value[gap.beforeWord];
  const color = right?.asset_color || left?.asset_color;
  const soft = right?.asset_soft || left?.asset_soft;

  if (!color && !soft) return null;

  return {
    '--gap-asset-color': color || 'transparent',
    '--gap-asset-soft': soft || 'transparent'
  };
}

function handleWordMouseDown(event, index) {
  event.preventDefault();
  isDragging.value = true;
  isGapDrag.value = false;
  dragStartIndex.value = index;

  // Don't select on mousedown - wait for mouseup or drag
  // This prevents the initial selection from conflicting with drag selection
}

function handleWordMouseEnter(event, index) {
  if (isDragging.value && !isGapDrag.value) {
    // If dragging started from empty area (-1), start selection from this word
    const startIdx = dragStartIndex.value === -1 ? index : dragStartIndex.value;
    editorStore.selectWordRange(startIdx, index);
  }
}

function handleWordMouseUp(event, index) {
  // End of drag - selection is already set by mouseEnter
  isDragging.value = false;

  // If not dragging (just a click), seek to this word
  if (dragStartIndex.value === index) {
    emit('seekTo', words.value[index].start_time);
  }
}

function handleContainerMouseDown(event) {
  closeContextMenu();
  // Click on empty area - clear selection and prepare for drag selection
  if (event.target === editorContainer.value || event.target.classList.contains('text-content')) {
    editorStore.clearSelection();
    // Set up for drag selection from this point
    isDragging.value = true;
    isGapDrag.value = false;
    dragStartIndex.value = -1; // -1 means dragging started from empty area
  }
}

function handleGapMouseDown(event, gapIndex) {
  event.preventDefault();
  event.stopPropagation();
  isDragging.value = false;
  isGapDrag.value = true;

  const { shiftKey, metaKey, ctrlKey } = event;
  editorStore.toggleGapSelection(gapIndex, shiftKey, metaKey, ctrlKey);
}

function handleGapClick(event, gap) {
  event.stopPropagation();
  // Seek to gap start - handled by parent component
}

function closeContextMenu() {
  contextMenu.value.visible = false;
}

function primeSelectionForContext(targetType, targetIndex) {
  if (hasSelection.value) return;

  if (targetType === 'word') {
    editorStore.toggleWordSelection(targetIndex, false, false, false);
  } else if (targetType === 'gap') {
    editorStore.toggleGapSelection(targetIndex, false, false, false);
  }
}

function openWordContextMenu(event, index) {
  primeSelectionForContext('word', index);
  contextMenu.value = {
    visible: true,
    x: event.clientX,
    y: event.clientY,
    targetType: 'word',
    targetIndex: index
  };
}

function openGapContextMenu(event, gapIndex) {
  primeSelectionForContext('gap', gapIndex);
  contextMenu.value = {
    visible: true,
    x: event.clientX,
    y: event.clientY,
    targetType: 'gap',
    targetIndex: gapIndex
  };
}

function toggleDeleteWord(index) {
  editorStore.toggleDeleteWord(index);
}

function toggleDeleteGap(gapIndex) {
  editorStore.toggleDeleteGap(gapIndex);
}

function deleteSelected() {
  closeContextMenu();
  editorStore.deleteSelected();
}

function restoreSelected() {
  closeContextMenu();
  editorStore.restoreSelected();
}

function handleContextDelete() {
  if (!hasSelection.value) {
    primeSelectionForContext(contextMenu.value.targetType, contextMenu.value.targetIndex);
  }
  deleteSelected();
}

function handleContextRestore() {
  if (!hasSelection.value) {
    primeSelectionForContext(contextMenu.value.targetType, contextMenu.value.targetIndex);
  }
  restoreSelected();
}

function confirmClearDeleted() {
  closeContextMenu();
  openConfirmDialog({
    title: '清除已删除',
    message: '确定要清除所有已删除的字和间隙吗？\n此操作不可撤销。',
    confirmText: '清除',
    danger: true,
    onConfirm: () => {
      editorStore.clearDeleted();
    }
  });
}

function openConfirmDialog(options = {}) {
  confirmDialogAction = typeof options.onConfirm === 'function' ? options.onConfirm : null;
  confirmDialog.value = {
    visible: true,
    title: options.title || '请确认',
    message: options.message || '确定继续吗？',
    confirmText: options.confirmText || '确认',
    cancelText: options.cancelText || '取消',
    danger: Boolean(options.danger)
  };
}

function closeConfirmDialog() {
  confirmDialog.value.visible = false;
  confirmDialogAction = null;
}

async function handleConfirmDialogConfirm() {
  const action = confirmDialogAction;
  closeConfirmDialog();
  if (action) {
    await action();
  }
}

function updateGapThreshold(event) {
  const value = parseFloat(event.target.value) || 0.5;
  editorStore.updateConfig('gapThreshold', value);
}

// Global mouse events for drag selection
function handleMouseUp() {
  isDragging.value = false;
  isGapDrag.value = false;
  dragStartIndex.value = -1;
}

function handleDocumentClick() {
  closeContextMenu();
}

function handleEditorScroll() {
  closeContextMenu();
}

// Keyboard shortcuts
function handleKeyDown(event) {
  const targetTag = String(event.target?.tagName || '').toLowerCase();
  if (targetTag === 'input' || targetTag === 'textarea') {
    return;
  }

  const isUndo = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !event.shiftKey;
  const isRedo =
    ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'z') ||
    (event.ctrlKey && event.key.toLowerCase() === 'y');

  if (isUndo) {
    event.preventDefault();
    editorStore.undo();
    return;
  }

  if (isRedo) {
    event.preventDefault();
    editorStore.redo();
    return;
  }

  if (event.key === 'Delete' || event.key === 'Backspace') {
    if (hasSelection.value) {
      event.preventDefault();
      deleteSelected();
    }
  } else if (event.key === 'Escape') {
    if (contextMenu.value.visible) {
      closeContextMenu();
      return;
    }
    editorStore.clearSelection();
  }
}

onMounted(() => {
  document.addEventListener('mouseup', handleMouseUp);
  document.addEventListener('click', handleDocumentClick);
  document.addEventListener('keydown', handleKeyDown);
  editorContainer.value?.addEventListener('scroll', handleEditorScroll, { passive: true });
});

onUnmounted(() => {
  document.removeEventListener('mouseup', handleMouseUp);
  document.removeEventListener('click', handleDocumentClick);
  document.removeEventListener('keydown', handleKeyDown);
  editorContainer.value?.removeEventListener('scroll', handleEditorScroll);
});

watch(currentWordIndex, (newIndex) => {
  if (newIndex < 0) return;
  requestAnimationFrame(() => {
    keepCurrentWordInView(newIndex);
  });
});

// Emit current word click for video seeking
const emit = defineEmits([
  'seekTo',
  'update:workspaceMode',
  'createSliceFromSelection',
  'appendSelectionToSlice',
  'removeSelectionFromSlice',
  'deleteSelectedSlice',
  'selectSlice'
]);
const props = defineProps({
  workspaceMode: {
    type: String,
    default: 'assemble_script'
  },
  projectSlices: {
    type: Array,
    default: () => []
  },
  selectedSliceId: {
    type: String,
    default: ''
  },
  sliceSelectionHint: {
    type: String,
    default: '先在字幕里框选一段内容，再新建切片或加入当前切片。'
  },
  canCreateSliceFromSelection: {
    type: Boolean,
    default: false
  },
  canAppendSelectionToSlice: {
    type: Boolean,
    default: false
  },
  canRemoveSelectionFromSlice: {
    type: Boolean,
    default: false
  },
  canDeleteSelectedSlice: {
    type: Boolean,
    default: false
  },
  sliceActionBusy: {
    type: Boolean,
    default: false
  }
});

function seekToWord(word) {
  emit('seekTo', word.start_time);
}

function keepCurrentWordInView(index) {
  const container = editorContainer.value;
  if (!container) return;

  const wordEl = container.querySelector(`.word[data-index="${index}"]`);
  if (!wordEl) return;

  const containerRect = container.getBoundingClientRect();
  const wordRect = wordEl.getBoundingClientRect();
  const upperBound = containerRect.top + containerRect.height * 0.25;
  const lowerBound = containerRect.top + containerRect.height * 0.75;
  const needsScroll = wordRect.top < upperBound || wordRect.bottom > lowerBound;

  if (!needsScroll) return;

  const offsetWithinContainer = wordRect.top - containerRect.top;
  const targetTop = container.scrollTop + offsetWithinContainer - container.clientHeight * 0.4;
  container.scrollTo({
    top: Math.max(0, targetTop),
    behavior: 'auto'
  });
}
</script>

<script>
export default {
  name: 'SubtitlePanel',
  emits: [
    'seekTo',
    'update:workspaceMode',
    'createSliceFromSelection',
    'appendSelectionToSlice',
    'removeSelectionFromSlice',
    'deleteSelectedSlice',
    'selectSlice'
  ]
};
</script>

<style scoped>
.subtitle-editor {
  width: 50%;
  min-width: 400px;
  background: var(--bg-secondary, #141414);
  border-right: 1px solid var(--border, #2a2a2a);
  display: flex;
  flex-direction: column;
}

:root {
  --bg-primary: #0a0a0a;
  --bg-secondary: #141414;
  --bg-tertiary: #1f1f1f;
  --bg-hover: #2a2a2a;
  --text-primary: #ffffff;
  --text-secondary: #a0a0a0;
  --text-muted: #666666;
  --accent: #00d4ff;
  --accent-hover: #00b8e6;
  --danger: #ff4757;
  --success: #2ed573;
  --warning: #ffa502;
  --border: #2a2a2a;
  --selected: rgba(0, 212, 255, 0.3);
  --deleted: rgba(255, 71, 87, 0.3);
}

.editor-topbar {
  display: grid;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border, #2a2a2a);
  background: var(--bg-tertiary, #1f1f1f);
}

.editor-topbar-main {
  display: flex;
  align-items: center;
  gap: 12px;
}

.editor-header {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 0 0 auto;
  min-width: 0;
  padding-right: 4px;
}

.editor-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 auto;
  min-width: 0;
  flex-wrap: nowrap;
  overflow-x: auto;
  padding-bottom: 2px;
}

.editor-mode-switch {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--border, #2a2a2a);
  background: var(--bg-primary, #0a0a0a);
  margin-left: auto;
  flex: 0 0 auto;
}

.mode-switch-btn {
  border: none;
  background: transparent;
  color: var(--text-secondary, #a0a0a0);
  padding: 6px 10px;
  font-size: 11px;
  cursor: pointer;
}

.mode-switch-btn.active {
  background: rgba(0, 212, 255, 0.14);
  color: var(--text-primary, #ffffff);
  box-shadow: inset 0 0 0 1px var(--accent, #00d4ff);
}

.slice-inline-toolbar {
  display: grid;
  gap: 8px;
}

.slice-inline-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.slice-inline-hint {
  font-size: 11px;
  color: var(--text-secondary, #a0a0a0);
  min-width: 0;
}

.slice-inline-rail {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 2px;
}

.slice-inline-chip {
  flex: 0 0 auto;
  min-width: 132px;
  padding: 7px 10px;
  border: 1px solid color-mix(in srgb, var(--slice-inline-color) 58%, var(--border, #2a2a2a));
  background: color-mix(in srgb, var(--slice-inline-color) 12%, var(--bg-primary, #0a0a0a));
  color: var(--text-primary, #ffffff);
  text-align: left;
  display: grid;
  gap: 2px;
  cursor: pointer;
  box-shadow: inset 2px 0 0 var(--slice-inline-color);
}

.slice-inline-chip.active {
  border-color: var(--slice-inline-color);
  background: color-mix(in srgb, var(--slice-inline-color) 18%, var(--bg-primary, #0a0a0a));
}

.slice-inline-chip-kicker {
  font-size: 9px;
  letter-spacing: 0.08em;
  color: var(--text-secondary, #a0a0a0);
  text-transform: uppercase;
}

.slice-inline-chip strong {
  font-size: 11px;
  line-height: 1.4;
}

.panel-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary, #a0a0a0);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  white-space: nowrap;
}

.panel-stats {
  font-size: 12px;
  color: var(--text-muted, #666666);
  white-space: nowrap;
}

.upload-area {
  padding: 60px 40px;
  border: 2px dashed var(--border, #2a2a2a);
  border-radius: 12px;
  margin: 20px;
  text-align: center;
  cursor: pointer;
  transition: all 0.2s;
}

.upload-area:hover {
  border-color: var(--accent, #00d4ff);
  background: rgba(0, 212, 255, 0.05);
}

.upload-area i {
  font-size: 48px;
  color: var(--text-secondary, #a0a0a0);
  margin-bottom: 16px;
}

.upload-area p {
  color: var(--text-secondary, #a0a0a0);
  font-size: 14px;
}

.toolbar-divider {
  width: 1px;
  height: 20px;
  background: var(--border, #2a2a2a);
  margin: 0 4px;
}

.editor-btn {
  padding: 6px 12px;
  background: transparent;
  border: 1px solid transparent;
  color: var(--text-secondary, #a0a0a0);
  cursor: pointer;
  border-radius: 4px;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 4px;
  transition: all 0.15s;
}

.editor-btn:hover {
  background: var(--bg-hover, #2a2a2a);
  color: var(--text-primary, #ffffff);
}

.editor-btn.danger:hover {
  background: var(--danger, #ff4757);
  color: white;
}

.editor-btn.active {
  background: var(--accent, #00d4ff);
  color: #000;
}

.editor-btn:disabled {
  opacity: 0.82;
  color: rgba(255, 255, 255, 0.5);
  border-color: rgba(255, 255, 255, 0.08);
  cursor: not-allowed;
}

.config-item {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: 4px;
  white-space: nowrap;
}

.config-item label {
  font-size: 12px;
  color: var(--text-secondary, #a0a0a0);
}

.config-item input {
  padding: 4px 8px;
  background: var(--bg-primary, #0a0a0a);
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 4px;
  color: var(--text-primary, #ffffff);
  font-size: 12px;
}

.config-item input:focus {
  outline: none;
  border-color: var(--accent, #00d4ff);
}

.editor-container {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  user-select: none;
}

@media (max-width: 1280px) {
  .editor-topbar-main {
    flex-wrap: wrap;
  }

  .editor-mode-switch {
    margin-left: 0;
  }
}

.text-content {
  line-height: 2.2;
  font-size: 16px;
  white-space: pre-wrap;
  word-wrap: break-word;
  user-select: none;
}

.word {
  display: inline-block;
  padding: 5px 0 3px;
  margin: 0 1px;
  border-radius: 0;
  cursor: pointer;
  transition: background-color 0.1s, opacity 0.1s, box-shadow 0.1s;
  position: relative;
  background-image: linear-gradient(
    to bottom,
    var(--word-asset-color, transparent),
    var(--word-asset-color, transparent)
  );
  background-repeat: no-repeat;
  background-position: left calc(100% - 1px);
  background-size: 100% 1px;
}

.word.has-slice-fill:not(.selected):not(.deleted) {
  box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--word-slice-color, transparent) 38%, transparent);
}

.word.in-active-slice:not(.selected):not(.deleted) {
  box-shadow:
    inset 0 -3px 0 var(--word-slice-color, transparent),
    inset 0 0 0 1px color-mix(in srgb, var(--word-slice-color, transparent) 18%, transparent);
}

.word:hover:not(.selected) {
  background: var(--bg-hover, #2a2a2a);
}

.word.selected {
  background: var(--selected, rgba(0, 212, 255, 0.3)) !important;
  box-shadow: inset 0 -1px 0 var(--word-asset-color, transparent), 0 0 0 1px var(--accent, #00d4ff);
}

.word.deleted {
  background: var(--deleted, rgba(255, 71, 87, 0.3));
  text-decoration: line-through;
  opacity: 0.5;
}

.word.current:not(.selected) {
  background: rgba(0, 212, 255, 0.15);
  background-size: 100% 2px;
}

.word .time-hint {
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%);
  background: var(--bg-tertiary, #1f1f1f);
  color: var(--text-secondary, #a0a0a0);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 10px;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s;
  z-index: 100;
  border: 1px solid var(--border, #2a2a2a);
}

.word:hover .time-hint {
  opacity: 1;
}

.gap {
  display: inline-flex;
  align-items: center;
  vertical-align: middle;
  margin: 0 4px;
  padding: 2px 6px;
  background: var(--bg-tertiary, #1f1f1f);
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
  transition: all 0.15s;
  border: 1px dashed var(--border, #2a2a2a);
}

.gap:hover {
  background: var(--bg-hover, #2a2a2a);
  border-color: var(--accent, #00d4ff);
}

.gap.cross-asset:not(.selected):not(.deleted) {
  border-color: var(--gap-asset-color, var(--accent, #00d4ff));
  background: var(--gap-asset-soft, var(--bg-tertiary, #1f1f1f));
}

.gap.selected {
  background: var(--selected, rgba(0, 212, 255, 0.3));
  border-color: var(--accent, #00d4ff);
  border-style: solid;
}

.gap.deleted {
  opacity: 0.3;
  background: var(--danger, #ff4757);
  border-color: var(--danger, #ff4757);
}

.gap-line {
  width: 20px;
  height: 2px;
  background: var(--text-muted, #666666);
  margin-right: 4px;
}

.gap.cross-asset .gap-line {
  background: var(--gap-asset-color, var(--text-muted, #666666));
}

.gap.selected .gap-line {
  background: var(--accent, #00d4ff);
}

.gap.deleted .gap-line {
  background: var(--danger, #ff4757);
}

.gap-label {
  font-size: 10px;
  color: var(--text-muted, #666666);
  font-variant-numeric: tabular-nums;
}

.gap:hover .gap-label {
  color: var(--accent, #00d4ff);
}

.subtitle-context-menu {
  position: fixed;
  z-index: 40;
  min-width: 132px;
  border: 1px solid var(--border, #2a2a2a);
  background: rgba(10, 10, 10, 0.98);
  box-shadow: 0 14px 32px rgba(0, 0, 0, 0.48);
  overflow: hidden;
}

.context-menu-item {
  width: 100%;
  border: none;
  border-bottom: 1px solid var(--border, #2a2a2a);
  background: transparent;
  color: var(--text-primary, #ffffff);
  padding: 10px 12px;
  text-align: left;
  font-size: 12px;
  cursor: pointer;
}

.context-menu-item:last-child {
  border-bottom: none;
}

.context-menu-item:hover {
  background: rgba(0, 212, 255, 0.12);
}

.context-menu-item.danger {
  color: #ff9a9a;
}
</style>
