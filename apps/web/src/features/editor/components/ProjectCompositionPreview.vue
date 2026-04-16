<template>
  <div class="composition-preview">
    <div class="composition-stage">
      <template v-if="hasClips">
        <video
          v-for="slotIndex in [0, 1]"
          :key="slotIndex"
          :ref="(el) => setVideoRef(slotIndex, el)"
          class="composition-video"
          :class="{ active: activeSlotIndex === slotIndex }"
          playsinline
          preload="auto"
          @play="handleVideoPlay(slotIndex)"
          @pause="handleVideoPause(slotIndex)"
          @timeupdate="handleVideoTimeUpdate(slotIndex)"
          @ended="handleVideoEnded(slotIndex)"
        ></video>
        <div v-if="!activeClip" class="empty-block preview-empty preview-loading">正在准备预览...</div>
      </template>
      <div v-else class="empty-block preview-empty">{{ emptyLabel }}</div>
    </div>

    <div v-if="hasClips" class="composition-controls">
      <button class="control-button" type="button" @click="togglePlayback">
        {{ isPlaying ? '暂停' : '播放' }}
      </button>
      <input
        class="control-range"
        type="range"
        :min="0"
        :max="Math.max(duration, 0.01)"
        :step="0.01"
        :value="internalProjectTime"
        @input="handleScrub"
      />
      <div class="control-meta">
        <span>{{ formatDuration(props.displayTime || internalProjectTime) }}</span>
        <span>/</span>
        <span>{{ formatDuration(props.displayDuration || duration) }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';

const props = defineProps({
  clips: {
    type: Array,
    default: () => []
  },
  projectTime: {
    type: Number,
    default: 0
  },
  duration: {
    type: Number,
    default: 0
  },
  displayTime: {
    type: Number,
    default: 0
  },
  displayDuration: {
    type: Number,
    default: 0
  },
  emptyLabel: {
    type: String,
    default: '当前项目时间线上还没有可预览的成片片段。'
  }
});

const emit = defineEmits(['project-time-update', 'clip-change', 'playing-change']);

const videoEls = [null, null];
const activeSlotIndex = ref(0);
const activeClipIndex = ref(-1);
const internalProjectTime = ref(0);
const isPlaying = ref(false);
const playbackIntent = ref(false);
const rafId = ref(null);
const transitionNonce = ref(0);
const slotState = reactive([
  { clipId: '', clipIndex: -1, src: '', ready: false },
  { clipId: '', clipIndex: -1, src: '', ready: false }
]);

const hasClips = computed(() => props.clips.length > 0);
const activeClip = computed(() => props.clips[activeClipIndex.value] || null);

function hasNextClip(index = activeClipIndex.value) {
  return index >= 0 && index < props.clips.length - 1;
}

function roundTime(value) {
  return Number(Number(value || 0).toFixed(3));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatDuration(seconds) {
  const safe = Number(seconds || 0);
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function setVideoRef(index, element) {
  videoEls[index] = element || null;
}

function findClipIndexForProjectTime(projectTime) {
  const current = Number(projectTime || 0);
  let clipIndex = props.clips.findIndex((clip, index) => {
    const start = Number(clip.project_start || 0);
    const end = Number(clip.project_end || start);
    const isLastClip = index === props.clips.length - 1;
    return current >= start && (isLastClip ? current <= end : current < end);
  });
  if (clipIndex !== -1) return clipIndex;

  clipIndex = props.clips.findIndex((clip) => Number(clip.project_start || 0) >= current);
  if (clipIndex !== -1) return clipIndex;

  return props.clips.length ? props.clips.length - 1 : -1;
}

function projectTimeToMediaTime(clip, projectTime) {
  const clipStart = Number(clip?.project_start || 0);
  const sourceStart = Number(clip?.source_start || 0);
  const sourceEnd = Number(clip?.source_end || sourceStart);
  const derived = sourceStart + (Number(projectTime || 0) - clipStart);
  return clamp(roundTime(derived), sourceStart, Math.max(sourceStart, sourceEnd - 0.001));
}

function mediaTimeToProjectTime(clip, mediaTime) {
  const sourceStart = Number(clip?.source_start || 0);
  const sourceEnd = Number(clip?.source_end || sourceStart);
  const clampedMediaTime = clamp(Number(mediaTime || 0), sourceStart, sourceEnd);
  return roundTime(Number(clip?.project_start || 0) + (clampedMediaTime - sourceStart));
}

function waitForVideoReady(video) {
  return new Promise((resolve, reject) => {
    if (!video) {
      reject(new Error('video element missing'));
      return;
    }
    if (video.readyState >= 1) {
      resolve();
      return;
    }

    let settled = false;
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', handleReady);
      video.removeEventListener('canplay', handleReady);
      video.removeEventListener('error', handleError);
    };
    const handleReady = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const handleError = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('video load failed'));
    };

    video.addEventListener('loadedmetadata', handleReady, { once: true });
    video.addEventListener('canplay', handleReady, { once: true });
    video.addEventListener('error', handleError, { once: true });
  });
}

async function ensureSlotPrepared(slotIndex, clipIndex, projectTime) {
  const clip = props.clips[clipIndex];
  const video = videoEls[slotIndex];
  if (!clip || !video) return false;

  if (slotState[slotIndex].src !== clip.asset_source_url) {
    slotState[slotIndex].ready = false;
    slotState[slotIndex].src = clip.asset_source_url || '';
    slotState[slotIndex].clipId = clip.id;
    slotState[slotIndex].clipIndex = clipIndex;
    video.pause();
    video.src = clip.asset_source_url || '';
    video.load();
    await waitForVideoReady(video);
  } else {
    slotState[slotIndex].clipId = clip.id;
    slotState[slotIndex].clipIndex = clipIndex;
  }

  const mediaTime = projectTimeToMediaTime(clip, projectTime);
  if (Math.abs(Number(video.currentTime || 0) - mediaTime) > 0.03) {
    video.currentTime = mediaTime;
  }
  slotState[slotIndex].ready = true;
  return true;
}

async function preloadNextClip(clipIndex) {
  if (clipIndex < 0 || clipIndex >= props.clips.length) return;
  const preloadSlot = 1 - activeSlotIndex.value;
  const nextClip = props.clips[clipIndex];
  if (!nextClip) return;
  if (slotState[preloadSlot].clipId === nextClip.id && slotState[preloadSlot].ready) return;
  try {
    await ensureSlotPrepared(preloadSlot, clipIndex, Number(nextClip.project_start || 0));
  } catch {
    // Preloading should not break the main preview flow.
  }
}

function emitProjectTime(projectTime) {
  internalProjectTime.value = roundTime(projectTime);
  emit('project-time-update', internalProjectTime.value);
}

async function activateClipAtProjectTime(projectTime, { autoplay = false, force = false } = {}) {
  const clipIndex = findClipIndexForProjectTime(projectTime);
  if (clipIndex === -1) {
    pausePlayback();
    activeClipIndex.value = -1;
    emit('clip-change', null);
    return false;
  }

  const clip = props.clips[clipIndex];
  const targetProjectTime = clamp(
    Number(projectTime || 0),
    Number(clip.project_start || 0),
    Number(clip.project_end || clip.project_start || 0)
  );

  if (!force && activeClipIndex.value === clipIndex && videoEls[activeSlotIndex.value]) {
    const activeVideo = videoEls[activeSlotIndex.value];
    const mediaTime = projectTimeToMediaTime(clip, targetProjectTime);
    if (Math.abs(Number(activeVideo.currentTime || 0) - mediaTime) > 0.03) {
      activeVideo.currentTime = mediaTime;
    }
    emitProjectTime(targetProjectTime);
    emit('clip-change', clip);
    if (autoplay && activeVideo.paused) {
      try {
        await activeVideo.play();
      } catch {}
    }
    preloadNextClip(clipIndex + 1);
    return true;
  }

  const targetSlot = 1 - activeSlotIndex.value;
  const token = transitionNonce.value + 1;
  transitionNonce.value = token;
  const ready = await ensureSlotPrepared(targetSlot, clipIndex, targetProjectTime);
  if (!ready || token !== transitionNonce.value) return false;

  const previousSlot = activeSlotIndex.value;
  const previousVideo = videoEls[previousSlot];
  const nextVideo = videoEls[targetSlot];

  activeSlotIndex.value = targetSlot;
  activeClipIndex.value = clipIndex;
  emitProjectTime(targetProjectTime);
  emit('clip-change', clip);

  if (previousVideo) previousVideo.pause();

  if (nextVideo) {
    if (autoplay) {
      try {
        await nextVideo.play();
      } catch {
        isPlaying.value = false;
        emit('playing-change', false);
      }
    } else {
      nextVideo.pause();
      isPlaying.value = false;
      emit('playing-change', false);
    }
  }

  preloadNextClip(clipIndex + 1);
  return true;
}

function syncProjectTimeFromVideo(slotIndex) {
  if (slotIndex !== activeSlotIndex.value) return;
  const clip = activeClip.value;
  const video = videoEls[slotIndex];
  if (!clip || !video) return;

  const clipEnd = Number(clip.source_end || 0);
  const mediaTime = Number(video.currentTime || 0);

  if (mediaTime >= clipEnd - 0.03) {
    const nextIndex = activeClipIndex.value + 1;
    if (nextIndex < props.clips.length) {
      const nextClip = props.clips[nextIndex];
      activateClipAtProjectTime(Number(nextClip.project_start || clip.project_end || 0), {
        autoplay: playbackIntent.value,
        force: true
      }).catch(() => {});
      return;
    }
    emitProjectTime(Number(clip.project_end || 0));
    pausePlayback();
    return;
  }

  emitProjectTime(mediaTimeToProjectTime(clip, mediaTime));
}

function startPlaybackLoop() {
  stopPlaybackLoop();

  const tick = () => {
    if (!isPlaying.value) {
      rafId.value = null;
      return;
    }
    syncProjectTimeFromVideo(activeSlotIndex.value);
    rafId.value = requestAnimationFrame(tick);
  };

  rafId.value = requestAnimationFrame(tick);
}

function stopPlaybackLoop() {
  if (rafId.value) {
    cancelAnimationFrame(rafId.value);
    rafId.value = null;
  }
}

function handleVideoPlay(slotIndex) {
  if (slotIndex !== activeSlotIndex.value) return;
  isPlaying.value = true;
  emit('playing-change', true);
  startPlaybackLoop();
}

function handleVideoPause(slotIndex) {
  if (slotIndex !== activeSlotIndex.value) return;
  const clip = activeClip.value;
  const video = videoEls[slotIndex];
  if (
    playbackIntent.value &&
    hasNextClip() &&
    clip &&
    video &&
    Number(video.currentTime || 0) >= Number(clip.source_end || 0) - 0.08
  ) {
    return;
  }
  isPlaying.value = false;
  emit('playing-change', false);
  stopPlaybackLoop();
}

function handleVideoEnded(slotIndex) {
  if (slotIndex !== activeSlotIndex.value) return;
  const currentClip = activeClip.value;
  const nextIndex = activeClipIndex.value + 1;
  if (currentClip) {
    emitProjectTime(Number(currentClip.project_end || 0));
  }
  if (nextIndex < props.clips.length) {
    const nextClip = props.clips[nextIndex];
    activateClipAtProjectTime(Number(nextClip.project_start || currentClip?.project_end || 0), {
      autoplay: playbackIntent.value,
      force: true
    }).catch(() => {});
    return;
  }
  pausePlayback();
}

function handleVideoTimeUpdate(slotIndex) {
  if (!isPlaying.value) {
    syncProjectTimeFromVideo(slotIndex);
  }
}

async function togglePlayback() {
  if (isPlaying.value) {
    pausePlayback();
    return;
  }
  playbackIntent.value = true;
  await activateClipAtProjectTime(internalProjectTime.value || props.projectTime || 0, {
    autoplay: true,
    force: true
  });
}

function pausePlayback() {
  playbackIntent.value = false;
  const activeVideo = videoEls[activeSlotIndex.value];
  if (activeVideo) activeVideo.pause();
  isPlaying.value = false;
  emit('playing-change', false);
  stopPlaybackLoop();
}

function handleScrub(event) {
  const nextProjectTime = Number(event?.target?.value || 0);
  emitProjectTime(nextProjectTime);
  activateClipAtProjectTime(nextProjectTime, {
    autoplay: playbackIntent.value,
    force: true
  }).catch(() => {});
}

async function seekToProjectTime(projectTime, autoplay = false) {
  await activateClipAtProjectTime(projectTime, { autoplay, force: true });
}

watch(
  () => props.clips,
  async (clips) => {
    if (!clips.length) {
      pausePlayback();
      activeClipIndex.value = -1;
      emit('clip-change', null);
      return;
    }
    await nextTick();
    await activateClipAtProjectTime(props.projectTime || Number(clips[0]?.project_start || 0), {
      autoplay: playbackIntent.value,
      force: true
    });
  },
  { deep: true, immediate: true }
);

watch(
  () => props.projectTime,
  async (projectTime) => {
    const nextTime = Number(projectTime || 0);
    if (Math.abs(nextTime - internalProjectTime.value) <= 0.08) return;
    await activateClipAtProjectTime(nextTime, {
      autoplay: playbackIntent.value,
      force: true
    });
  }
);

onBeforeUnmount(() => {
  stopPlaybackLoop();
});

defineExpose({
  seekToProjectTime,
  pausePlayback,
  togglePlayback,
  isPlaybackActive: () => Boolean(playbackIntent.value || isPlaying.value)
});
</script>

<style scoped>
.composition-preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
}

.composition-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  background: #05080d;
  border: 1px solid rgba(115, 169, 255, 0.18);
  overflow: hidden;
}

.composition-video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #05080d;
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms linear;
}

.composition-video.active {
  opacity: 1;
  pointer-events: auto;
}

.composition-controls {
  display: flex;
  align-items: center;
  gap: 10px;
}

.control-button {
  border: 1px solid rgba(115, 169, 255, 0.28);
  background: #09121d;
  color: #dff1ff;
  height: 30px;
  min-width: 58px;
  padding: 0 12px;
  cursor: pointer;
}

.control-range {
  flex: 1;
  min-width: 0;
}

.control-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  color: #9db2c8;
  font-size: 12px;
  white-space: nowrap;
}

.preview-empty {
  height: 100%;
}

.preview-loading {
  position: absolute;
  inset: 0;
  z-index: 2;
  background: rgba(5, 8, 13, 0.72);
}
</style>
