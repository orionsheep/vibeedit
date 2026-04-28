<template>
  <div class="timeline-container">
    <div class="timeline-header">
      <div class="timeline-title-group">
        <span class="timeline-title">时间轴</span>
        <span class="timeline-runtime">{{ timeDisplay }}</span>
      </div>
      <div class="zoom-control">
        <label for="timelineZoom">缩放:</label>
        <input
          type="range"
          id="timelineZoom"
          :value="zoomLevel"
          @input="handleZoomChange"
          min="1"
          max="10"
          step="0.5"
        />
        <span>{{ zoomLevel }}x</span>
      </div>
    </div>
    <div class="timeline-track-wrapper">
      <div class="timeline-track" ref="trackRef" @click="handleTrackClick">
        <canvas ref="waveformCanvas" class="waveform-canvas"></canvas>
        <!-- Render gaps -->
        <div
          v-for="gap in renderGaps"
          :key="'gap-' + gap.index"
          class="timeline-gap"
          :class="{ deleted: renderDeletedGaps.has(gap.index) }"
          :style="{
            left: (gap.start / safeDuration * 100) + '%',
            width: Math.max(0.3, ((gap.end - gap.start) / safeDuration * 100)) + '%'
          }"
          :title="`间隙 ${formatTime(gap.duration)}`"
          @click.stop="handleGapClick(gap)"
        ></div>
        <!-- Render words -->
        <div
          v-for="(word, index) in renderWords"
          :key="'word-' + index"
          class="timeline-word"
          :class="{ deleted: renderDeletedWords.has(index) }"
          :style="{
            left: (word.start_time / safeDuration * 100) + '%',
            width: Math.max(0.5, ((word.end_time - word.start_time) / safeDuration * 100)) + '%'
          }"
          :title="word.text"
          @click.stop="handleWordClick(word)"
        ></div>
        <!-- Timeline cursor -->
        <div
          class="timeline-cursor"
          :style="{ left: (renderCurrentTime / safeDuration * 100) + '%' }"
        ></div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { storeToRefs } from 'pinia';
import { useEditorStore } from '../stores/editorStore';

const props = defineProps({
  words: {
    type: Array,
    default: null
  },
  gaps: {
    type: Array,
    default: null
  },
  deletedWords: {
    type: [Object, Set],
    default: null
  },
  deletedGaps: {
    type: [Object, Set],
    default: null
  },
  currentTime: {
    type: Number,
    default: null
  },
  duration: {
    type: Number,
    default: null
  }
});

const emit = defineEmits(['seekTo']);

const editorStore = useEditorStore();
const { words, gaps, deletedWords, deletedGaps, currentTime, duration, editedCurrentTime, editedDuration } = storeToRefs(editorStore);

const trackRef = ref(null);
const waveformCanvas = ref(null);
const zoomLevel = ref(1);

// Computed
const isControlled = computed(() => Array.isArray(props.words));
const renderWords = computed(() => (Array.isArray(props.words) ? props.words : words.value));
const renderGaps = computed(() => (Array.isArray(props.gaps) ? props.gaps : gaps.value));
const renderDeletedWords = computed(() => (props.deletedWords instanceof Set ? props.deletedWords : deletedWords.value));
const renderDeletedGaps = computed(() => (props.deletedGaps instanceof Set ? props.deletedGaps : deletedGaps.value));
const renderDuration = computed(() => {
  if (props.duration !== null && Number.isFinite(Number(props.duration))) {
    return Math.max(0, Number(props.duration));
  }
  return Number(duration.value || 0);
});
const safeDuration = computed(() => Math.max(0.001, renderDuration.value));
const renderCurrentTime = computed(() => {
  if (props.currentTime !== null && Number.isFinite(Number(props.currentTime))) {
    return Math.max(0, Math.min(Number(props.currentTime), renderDuration.value || 0));
  }
  return Number(currentTime.value || 0);
});
const timeDisplay = computed(() => {
  if (isControlled.value) {
    return `${formatTime(renderCurrentTime.value)} / ${formatTime(renderDuration.value)}`;
  }
  return `${formatTime(editedCurrentTime.value)} / ${formatTime(editedDuration.value)}`;
});

// Methods
function formatTime(seconds) {
  if (!seconds) return '00:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function handleZoomChange(event) {
  zoomLevel.value = parseFloat(event.target.value);
}

function handleTrackClick(event) {
  const rect = trackRef.value.getBoundingClientRect();
  const percent = (event.clientX - rect.left) / rect.width;
  const time = percent * renderDuration.value;
  if (isControlled.value) {
    emit('seekTo', time);
    return;
  }
  editorStore.setCurrentTime(time);
}

function handleGapClick(gap) {
  if (isControlled.value) {
    emit('seekTo', gap.start);
    return;
  }
  editorStore.setCurrentTime(gap.start);
}

function handleWordClick(word) {
  if (isControlled.value) {
    emit('seekTo', word.start_time);
    return;
  }
  editorStore.setCurrentTime(word.start_time);
}

// Render waveform
function renderWaveform() {
  if (!waveformCanvas.value || !renderDuration.value || renderWords.value.length === 0) return;

  const canvas = waveformCanvas.value;
  const ctx = canvas.getContext('2d');
  const width = canvas.offsetWidth;
  const height = canvas.offsetHeight;

  // Set canvas resolution
  canvas.width = width * 2;
  canvas.height = height * 2;
  ctx.scale(2, 2);

  // Clear canvas
  ctx.fillStyle = '#1f1f1f';
  ctx.fillRect(0, 0, width, height);

  // Draw center line
  ctx.strokeStyle = '#2a2a2a';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();

  // Create gradient for waveform
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, '#00d4ff');
  gradient.addColorStop(1, '#00b8e6');
  ctx.fillStyle = gradient;

  // Draw simulated waveform
  const barWidth = 2;
  const bars = Math.floor(width / barWidth);

  for (let i = 0; i < bars; i++) {
    const t = (i / bars) * renderDuration.value;
    // Simulate amplitude based on word density
    let amplitude = 0.2 + Math.random() * 0.3;

    // Find if there's a word at this time
    const word = renderWords.value.find(w => Math.abs((w.start_time + w.end_time) / 2 - t) < 0.5);
    if (word && !renderDeletedWords.value.has(renderWords.value.indexOf(word))) {
      amplitude = 0.6 + Math.random() * 0.3;
    }

    const barHeight = amplitude * height * 0.4;
    ctx.fillRect(
      i * barWidth,
      (height - barHeight) / 2,
      barWidth - 1,
      barHeight
    );
  }
}

// Watch for changes and re-render
watch([renderDuration, renderWords, renderDeletedWords], () => {
  nextTick(() => {
    renderWaveform();
  });
});

onMounted(() => {
  renderWaveform();

  // Re-render on window resize
  window.addEventListener('resize', renderWaveform);
});

onUnmounted(() => {
  window.removeEventListener('resize', renderWaveform);
});
</script>

<script>
export default {
  name: 'TimelineStrip'
};
</script>

<style scoped>
.timeline-container {
  height: 100px;
  background:
    linear-gradient(180deg, rgba(8, 14, 21, 0.98) 0%, rgba(7, 12, 18, 1) 100%);
  border-top: 1px solid rgba(88, 219, 255, 0.08);
  display: flex;
  flex-direction: column;
}

.timeline-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 8px 16px 6px;
  font-size: 12px;
  color: #9cb4c6;
}

.timeline-title-group {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
}

.timeline-title {
  color: #eff7fc;
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.timeline-runtime {
  color: #77dfff;
  font-family: var(--font-mono);
  font-size: 11px;
}

.zoom-control {
  display: flex;
  align-items: center;
  gap: 8px;
}

.zoom-control label {
  color: #839aac;
}

.zoom-control input[type="range"] {
  width: 100px;
  cursor: pointer;
  accent-color: #58dbff;
}

.zoom-control span {
  color: #8ceaff;
  font-weight: 500;
  min-width: 30px;
  text-align: right;
  font-family: var(--font-mono);
  font-size: 11px;
}

.timeline-track-wrapper {
  flex: 1;
  padding: 0 16px 12px;
  position: relative;
}

.timeline-track {
  height: 100%;
  background:
    linear-gradient(180deg, rgba(12, 20, 28, 0.98) 0%, rgba(8, 14, 20, 0.98) 100%);
  border: 1px solid rgba(88, 219, 255, 0.08);
  position: relative;
  overflow: hidden;
  cursor: pointer;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
}

.timeline-track::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    linear-gradient(90deg, rgba(88, 219, 255, 0.06) 0 1px, transparent 1px 100%),
    linear-gradient(180deg, transparent 0%, transparent 58%, rgba(255, 255, 255, 0.02) 58%, rgba(255, 255, 255, 0.02) 60%, transparent 60%, transparent 100%);
  background-size: 28px 100%, 100% 100%;
  pointer-events: none;
}

.waveform-canvas {
  width: 100%;
  height: 100%;
  position: absolute;
  top: 0;
  left: 0;
}

.timeline-word {
  position: absolute;
  top: 7px;
  height: calc(100% - 14px);
  background: linear-gradient(180deg, rgba(121, 233, 255, 0.86) 0%, rgba(24, 197, 255, 0.56) 100%);
  min-width: 2px;
  cursor: pointer;
  transition: background-color 0.15s, opacity 0.15s;
  z-index: 10;
  box-shadow: inset 0 -1px 0 rgba(255, 255, 255, 0.12);
}

.timeline-word:hover {
  background: linear-gradient(180deg, rgba(165, 241, 255, 0.94) 0%, rgba(50, 210, 255, 0.72) 100%);
}

.timeline-word.deleted {
  background: linear-gradient(180deg, rgba(255, 132, 145, 0.84) 0%, rgba(255, 71, 87, 0.58) 100%);
}

.timeline-gap {
  position: absolute;
  top: 10px;
  height: calc(100% - 20px);
  background: linear-gradient(180deg, rgba(255, 181, 77, 0.52) 0%, rgba(255, 165, 2, 0.24) 100%);
  opacity: 0.9;
  cursor: pointer;
  z-index: 10;
  border-left: 1px solid rgba(255, 192, 92, 0.32);
  border-right: 1px solid rgba(255, 192, 92, 0.18);
}

.timeline-gap:hover {
  background: linear-gradient(180deg, rgba(143, 231, 255, 0.48) 0%, rgba(22, 197, 255, 0.18) 100%);
}

.timeline-gap.deleted {
  opacity: 0.35;
  background: linear-gradient(180deg, rgba(255, 136, 149, 0.42) 0%, rgba(255, 71, 87, 0.16) 100%);
}

.timeline-cursor {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(140, 234, 255, 0.8));
  pointer-events: none;
  z-index: 10;
  box-shadow: 0 0 18px rgba(140, 234, 255, 0.4);
}
</style>
