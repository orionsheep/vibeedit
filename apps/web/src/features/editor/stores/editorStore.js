/**
 * Editor Pinia Store
 *
 * Central state for the subtitle + timeline editing workspace:
 * - word and gap management
 * - selection, deletion, and history
 * - video playback state
 * - export-related derived data
 */

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

const HISTORY_LIMIT = 80;

function roundTime(value) {
  return Number(value.toFixed(3));
}

function repairCollapsedWordTimings(words, totalDuration) {
  if (!Array.isArray(words) || words.length < 2 || !Number.isFinite(totalDuration) || totalDuration <= 0) {
    return {
      words: Array.isArray(words) ? words : [],
      applied: false
    };
  }

  const repaired = words.map(word => ({ ...word }));
  const epsilon = 1e-6;
  let collapsedStart = -1;

  for (let i = 1; i < repaired.length; i += 1) {
    const prevEnd = Number(repaired[i - 1].end_time || 0);
    const currentStart = Number(repaired[i].start_time || 0);
    const currentEnd = Number(repaired[i].end_time || 0);

    if (currentStart <= prevEnd + epsilon && currentEnd <= prevEnd + epsilon) {
      const anchorTime = Math.max(prevEnd, Number(repaired[i - 1].start_time || 0));
      const remainingDuration = totalDuration - anchorTime;
      const collapsedCount = repaired.length - i;

      if (collapsedCount < 50 || remainingDuration < 10) {
        continue;
      }

      // Only treat it as collapsed if a large tail is compressed into a tiny
      // span near the same timestamp. Legitimate ASR often has some zero-length
      // words or equal boundaries and should not trigger a full re-timing.
      let clusteredWords = 0;
      const clusterWindow = Math.min(0.25, Math.max(0.05, remainingDuration * 0.002));

      for (let j = i; j < repaired.length; j += 1) {
        const start = Number(repaired[j].start_time || 0);
        const end = Number(repaired[j].end_time || 0);
        if (start <= anchorTime + clusterWindow && end <= anchorTime + clusterWindow) {
          clusteredWords += 1;
        }
      }

      if (clusteredWords < 50) {
        continue;
      }

      collapsedStart = i;
      break;
    }
  }

  if (collapsedStart === -1) {
    return {
      words: repaired,
      applied: false
    };
  }

  const collapsedCount = repaired.length - collapsedStart;
  const previousWord = repaired[collapsedStart - 1];
  const anchorTime = Math.max(
    Number(previousWord?.end_time || 0),
    Number(previousWord?.start_time || 0)
  );
  const remainingDuration = totalDuration - anchorTime;

  if (collapsedCount < 50 || remainingDuration < 10) {
    return {
      words: repaired,
      applied: false
    };
  }

  const step = remainingDuration / collapsedCount;
  const tailPadding = Math.min(0.01, Math.max(0.002, step * 0.15));

  console.warn(
    `[Editor Store] Repairing collapsed word timings from index ${collapsedStart}, count=${collapsedCount}, anchor=${anchorTime.toFixed(3)}, duration=${totalDuration.toFixed(3)}`
  );

  for (let i = collapsedStart; i < repaired.length; i += 1) {
    const offset = i - collapsedStart;
    const start = anchorTime + step * offset;
    const nextStart = anchorTime + step * (offset + 1);
    const end = Math.max(start + 0.01, nextStart - tailPadding);

    repaired[i].start_time = roundTime(start);
    repaired[i].end_time = roundTime(Math.min(totalDuration, end));
  }

  return {
    words: repaired,
    applied: true
  };
}

export const useEditorStore = defineStore('editor', () => {
  // State
  const words = ref([]);
  const gaps = ref([]);
  const deletedWords = ref(new Set());
  const deletedGaps = ref(new Set());
  const selectedWords = ref(new Set());
  const selectedGaps = ref(new Set());
  const config = ref({
    gapThreshold: 0.5
  });
  const isPlaying = ref(false);
  const currentTime = ref(0);
  const duration = ref(0);
  const currentWordIndex = ref(-1);
  const isLoading = ref(false);
  const error = ref(null);
  const timingRepairApplied = ref(false);
  const undoStack = ref([]);
  const redoStack = ref([]);
  const isApplyingHistory = ref(false);

  // Computed
  const totalWords = computed(() => words.value.length);
  const deletedWordCount = computed(() => deletedWords.value.size);
  const deletedGapCount = computed(() => deletedGaps.value.size);
  const keptWords = computed(() => totalWords.value - deletedWordCount.value);
  const hasSelection = computed(() => selectedWords.value.size > 0 || selectedGaps.value.size > 0);

  const totalGapDuration = computed(() => {
    return gaps.value.reduce((sum, g) => sum + g.duration, 0);
  });

  const deletedGapDuration = computed(() => {
    return gaps.value
      .filter(g => deletedGaps.value.has(g.index))
      .reduce((sum, g) => sum + g.duration, 0);
  });
  const keepRanges = computed(() => {
    const allWords = words.value.map((word, index) => ({ ...word, index }));
    const ranges = [];
    let segStart = null;

    for (let index = 0; index < allWords.length; index += 1) {
      const word = allWords[index];
      const kept = !deletedWords.value.has(word.index);

      if (kept) {
        if (segStart === null) segStart = index;
        const nextWordDeleted = index === allWords.length - 1 || deletedWords.value.has(allWords[index + 1].index);
        const deletedGapAfterWord = deletedGaps.value.has(word.index);

        if (nextWordDeleted || deletedGapAfterWord) {
          ranges.push({
            start: Number(allWords[segStart].start_time || 0),
            end: Number(word.end_time || allWords[segStart].start_time || 0)
          });
          segStart = null;
        }
      } else if (segStart !== null) {
        ranges.push({
          start: Number(allWords[segStart].start_time || 0),
          end: Number(allWords[index - 1].end_time || allWords[segStart].start_time || 0)
        });
        segStart = null;
      }
    }

    return ranges;
  });
  const editedDuration = computed(() => {
    return keepRanges.value.reduce((sum, range) => sum + Math.max(0, Number(range.end || 0) - Number(range.start || 0)), 0);
  });
  const editedCurrentTime = computed(() => {
    const current = Number(currentTime.value || 0);
    let cursor = 0;

    for (const range of keepRanges.value) {
      const start = Number(range.start || 0);
      const end = Number(range.end || start);
      const segmentDuration = Math.max(0, end - start);

      if (current <= start) {
        return cursor;
      }
      if (current >= end) {
        cursor += segmentDuration;
        continue;
      }
      return cursor + Math.max(0, current - start);
    }

    return cursor;
  });
  const canUndo = computed(() => undoStack.value.length > 0);
  const canRedo = computed(() => redoStack.value.length > 0);

  function cloneWords(sourceWords) {
    return sourceWords.map(word => ({ ...word }));
  }

  function normalizeIndexArray(indices) {
    return [...indices].sort((a, b) => a - b);
  }

  function createHistorySnapshot() {
    return {
      words: cloneWords(words.value),
      deletedWords: normalizeIndexArray(deletedWords.value),
      deletedGaps: normalizeIndexArray(deletedGaps.value),
      config: { ...config.value },
      timingRepairApplied: timingRepairApplied.value
    };
  }

  function arraysEqual(a = [], b = []) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  function wordsEqual(a = [], b = []) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (
        a[i]?.text !== b[i]?.text ||
        Number(a[i]?.start_time) !== Number(b[i]?.start_time) ||
        Number(a[i]?.end_time) !== Number(b[i]?.end_time)
      ) {
        return false;
      }
    }
    return true;
  }

  function configsEqual(a = {}, b = {}) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const key of keys) {
      if (a[key] !== b[key]) {
        return false;
      }
    }
    return true;
  }

  function snapshotsEqual(a, b) {
    if (!a || !b) return false;
    return (
      wordsEqual(a.words, b.words) &&
      arraysEqual(a.deletedWords, b.deletedWords) &&
      arraysEqual(a.deletedGaps, b.deletedGaps) &&
      configsEqual(a.config, b.config) &&
      Boolean(a.timingRepairApplied) === Boolean(b.timingRepairApplied)
    );
  }

  function clearSelectionState() {
    selectedWords.value.clear();
    selectedGaps.value.clear();
  }

  function clearHistory() {
    undoStack.value = [];
    redoStack.value = [];
  }

  function pushUndoSnapshot(snapshot) {
    undoStack.value.push(snapshot);
    if (undoStack.value.length > HISTORY_LIMIT) {
      undoStack.value.shift();
    }
  }

  function applySnapshot(snapshot) {
    if (!snapshot) return;

    isApplyingHistory.value = true;
    try {
      words.value = cloneWords(snapshot.words || []);
      deletedWords.value = new Set(snapshot.deletedWords || []);
      deletedGaps.value = new Set(snapshot.deletedGaps || []);
      config.value = { ...config.value, ...(snapshot.config || {}) };
      timingRepairApplied.value = Boolean(snapshot.timingRepairApplied);
      clearSelectionState();
      detectGaps();
      sanitizeDeletedGaps();
      updateCurrentWordIndex();
    } finally {
      isApplyingHistory.value = false;
    }
  }

  function commitHistoryMutation(mutator) {
    if (isApplyingHistory.value) {
      mutator();
      return false;
    }

    const before = createHistorySnapshot();
    mutator();
    const after = createHistorySnapshot();

    if (snapshotsEqual(before, after)) {
      return false;
    }

    pushUndoSnapshot(before);
    redoStack.value = [];
    return true;
  }

  function setDeletedWordsState(indices = [], replace = false) {
    const next = replace ? new Set() : new Set(deletedWords.value);

    indices.forEach(index => {
      if (Number.isInteger(index) && index >= 0 && index < words.value.length) {
        next.add(index);
      }
    });

    deletedWords.value = next;
    clearSelectionState();
    detectGaps();
    sanitizeDeletedGaps();
  }

  function setDeletedGapsState(indices = [], replace = false) {
    const validGapIndices = new Set(gaps.value.map(gap => gap.index));
    const next = replace ? new Set() : new Set(deletedGaps.value);

    indices.forEach(index => {
      if (Number.isInteger(index) && validGapIndices.has(index)) {
        next.add(index);
      }
    });

    deletedGaps.value = next;
    clearSelectionState();
    sanitizeDeletedGaps();
  }

  function setKeepRangesState(ranges = []) {
    const nextDeleted = new Set();
    const normalizedRanges = ranges
      .filter(range => typeof range?.start === 'number' && typeof range?.end === 'number' && range.end > range.start)
      .map(range => ({ start: range.start, end: range.end }));

    words.value.forEach((word, index) => {
      const keep = normalizedRanges.some(range =>
        (word.start_time || 0) < range.end && (word.end_time || 0) > range.start
      );
      if (!keep) {
        nextDeleted.add(index);
      }
    });

    deletedWords.value = nextDeleted;
    deletedGaps.value.clear();
    clearSelectionState();
    detectGaps();
    sanitizeDeletedGaps();
  }

  /**
   * Load words and detect gaps from ASR result
   */
  function loadWordsFromASR(asrResult) {
    let loadedWords = [];

    // Merge words from all segments into a flat array
    if (asrResult.segments && asrResult.segments.length > 0) {
      loadedWords = asrResult.segments.flatMap(seg => seg.words || []);
    } else if (asrResult.words) {
      loadedWords = asrResult.words;
    } else {
      loadedWords = [];
    }

    if (asrResult.duration) {
      duration.value = asrResult.duration;
    }

    const repaired = repairCollapsedWordTimings(loadedWords, duration.value || asrResult.duration || 0);
    words.value = repaired.words;
    timingRepairApplied.value = repaired.applied;
    detectGaps();
    deletedWords.value.clear();
    deletedGaps.value.clear();
    clearSelectionState();
    clearHistory();
  }

  function loadExternalWords(payload = {}) {
    const loadedWords = Array.isArray(payload.words)
      ? payload.words.map((word) => ({ ...word }))
      : [];

    duration.value = Number(payload.duration || 0);
    words.value = loadedWords;
    timingRepairApplied.value = false;
    detectGaps();
    deletedWords.value.clear();
    deletedGaps.value.clear();
    if (Array.isArray(payload.deletedWordIndices)) {
      setDeletedWordsState(payload.deletedWordIndices, true);
    } else if (Array.isArray(payload.keepRanges) && payload.keepRanges.length) {
      setKeepRangesState(payload.keepRanges);
    }
    if (Array.isArray(payload.deletedGapIndices)) {
      setDeletedGapsState(payload.deletedGapIndices, true);
    }
    clearSelectionState();
    clearHistory();
    const requestedCurrentTime = Number(payload.currentTime);
    if (Number.isFinite(requestedCurrentTime)) {
      currentTime.value = Math.max(0, Math.min(requestedCurrentTime, Number(duration.value || 0)));
      updateCurrentWordIndex();
    } else {
      currentTime.value = 0;
      currentWordIndex.value = -1;
    }
  }

  /**
   * Detect silence gaps between words based on threshold
   */
  function detectGaps() {
    const detectedGaps = [];
    const threshold = config.value.gapThreshold;

    for (let i = 0; i < words.value.length - 1; i++) {
      const currentEnd = words.value[i].end_time;
      const nextStart = words.value[i + 1].start_time;
      const gapDuration = nextStart - currentEnd;

      if (gapDuration >= threshold) {
        detectedGaps.push({
          index: i,
          start: currentEnd,
          end: nextStart,
          duration: gapDuration,
          afterWord: i,
          beforeWord: i + 1
        });
      }
    }

    gaps.value = detectedGaps;
  }

  function sanitizeDeletedGaps() {
    const validGapIndices = new Set(gaps.value.map(g => g.index));
    deletedGaps.value = new Set([...deletedGaps.value].filter(index => validGapIndices.has(index)));
  }

  /**
   * Select a range of words (no auto-expansion, just the exact range)
   */
  function selectWordRange(startIdx, endIdx) {
    const min = Math.min(startIdx, endIdx);
    const max = Math.max(startIdx, endIdx);

    // Clear previous selection and set new range (exact range, no auto-expansion)
    selectedWords.value.clear();
    selectedGaps.value.clear();
    for (let i = min; i <= max; i++) {
      selectedWords.value.add(i);
    }

    // Also select gaps within the range
    for (let i = min; i < max; i++) {
      const gapAfter = gaps.value.find(g => g.afterWord === i && g.beforeWord <= max);
      if (gapAfter) {
        selectedGaps.value.add(gapAfter.index);
      }
    }
  }

  /**
   * Toggle word selection (with shift/meta support)
   */
  function toggleWordSelection(index, shiftKey, metaKey, ctrlKey) {
    if (!shiftKey && !metaKey && !ctrlKey) {
      selectedWords.value.clear();
      selectedGaps.value.clear();
    }
    selectedWords.value.add(index);
  }

  /**
   * Toggle gap selection
   */
  function toggleGapSelection(gapIndex, shiftKey, metaKey, ctrlKey) {
    if (!shiftKey && !metaKey && !ctrlKey) {
      selectedWords.value.clear();
      selectedGaps.value.clear();
    }
    selectedGaps.value.add(gapIndex);
  }

  /**
   * Delete selected words and gaps
   */
  function deleteSelected() {
    commitHistoryMutation(() => {
      selectedWords.value.forEach(index => {
        deletedWords.value.add(index);
      });
      selectedGaps.value.forEach(gapIndex => {
        deletedGaps.value.add(gapIndex);
      });
      clearSelectionState();

      detectGaps();
      sanitizeDeletedGaps();
    });
  }

  /**
   * Restore selected words and gaps
   */
  function restoreSelected() {
    commitHistoryMutation(() => {
      selectedWords.value.forEach(index => {
        deletedWords.value.delete(index);
      });
      selectedGaps.value.forEach(gapIndex => {
        deletedGaps.value.delete(gapIndex);
      });
      clearSelectionState();

      detectGaps();
    });
  }

  /**
   * Toggle delete state of a single word
   */
  function toggleDeleteWord(index) {
    commitHistoryMutation(() => {
      if (deletedWords.value.has(index)) {
        deletedWords.value.delete(index);
      } else {
        deletedWords.value.add(index);
      }
      detectGaps();
      sanitizeDeletedGaps();
    });
  }

  /**
   * Toggle delete state of a single gap
   */
  function toggleDeleteGap(gapIndex) {
    commitHistoryMutation(() => {
      if (deletedGaps.value.has(gapIndex)) {
        deletedGaps.value.delete(gapIndex);
      } else {
        deletedGaps.value.add(gapIndex);
      }
    });
  }

  /**
   * Clear all deleted items permanently
   */
  function clearDeleted() {
    commitHistoryMutation(() => {
      deletedWords.value.clear();
      deletedGaps.value.clear();
      clearSelectionState();
      detectGaps();
    });
  }

  /**
   * Apply deleted word indices from AI or bulk operations
   */
  function applyDeletedWords(indices = [], replace = false) {
    commitHistoryMutation(() => {
      setDeletedWordsState(indices, replace);
    });
  }

  /**
   * Replace current selection with keep ranges returned by AI highlight analysis
   */
  function applyKeepRanges(ranges = []) {
    commitHistoryMutation(() => {
      setKeepRangesState(ranges);
    });
  }

  function applyAiEditResult({
    keepRanges = null,
    deletedWordIndices = null,
    deletedGapIndices = null,
    replaceDeletedWords = false,
    replaceDeletedGaps = false
  } = {}) {
    commitHistoryMutation(() => {
      if (Array.isArray(keepRanges)) {
        setKeepRangesState(keepRanges);
      }

      if (Array.isArray(deletedWordIndices)) {
        setDeletedWordsState(deletedWordIndices, replaceDeletedWords);
      }

      if (Array.isArray(deletedGapIndices)) {
        setDeletedGapsState(deletedGapIndices, replaceDeletedGaps);
      }
    });
  }

  /**
   * Clear selection
   */
  function clearSelection() {
    clearSelectionState();
  }

  /**
   * Update video playback time
   */
  function setCurrentTime(time) {
    currentTime.value = time;
    updateCurrentWordIndex();
  }

  /**
   * Update current word index based on time
   */
  function updateCurrentWordIndex() {
    const newIndex = words.value.findIndex(w =>
      currentTime.value >= w.start_time && currentTime.value <= w.end_time
    );
    currentWordIndex.value = newIndex;
  }

  /**
   * Update config value
   */
  function updateConfig(key, value) {
    commitHistoryMutation(() => {
      config.value[key] = value;
      if (key === 'gapThreshold') {
        detectGaps();
      }
    });
  }

  function undo() {
    if (!undoStack.value.length) return false;

    const previous = undoStack.value.pop();
    redoStack.value.push(createHistorySnapshot());
    applySnapshot(previous);
    return true;
  }

  function redo() {
    if (!redoStack.value.length) return false;

    const next = redoStack.value.pop();
    pushUndoSnapshot(createHistorySnapshot());
    applySnapshot(next);
    return true;
  }

  /**
   * Reset store to initial state
   */
  function reset() {
    words.value = [];
    gaps.value = [];
    deletedWords.value.clear();
    deletedGaps.value.clear();
    selectedWords.value.clear();
    selectedGaps.value.clear();
    isPlaying.value = false;
    currentTime.value = 0;
    duration.value = 0;
    currentWordIndex.value = -1;
    error.value = null;
    timingRepairApplied.value = false;
    clearHistory();
  }

  return {
    // State
    words,
    gaps,
    deletedWords,
    deletedGaps,
    selectedWords,
    selectedGaps,
    config,
    isPlaying,
    currentTime,
    duration,
    currentWordIndex,
    isLoading,
    error,

    // Computed
    totalWords,
    deletedWordCount,
    deletedGapCount,
    keptWords,
    hasSelection,
    totalGapDuration,
    deletedGapDuration,
    keepRanges,
    editedDuration,
    editedCurrentTime,
    canUndo,
    canRedo,

    // Actions
    selectWordRange,
    toggleWordSelection,
    toggleGapSelection,
    deleteSelected,
    restoreSelected,
    toggleDeleteWord,
    toggleDeleteGap,
    clearDeleted,
    applyDeletedWords,
    applyKeepRanges,
    applyAiEditResult,
    clearSelection,
    setCurrentTime,
    updateCurrentWordIndex,
    updateConfig,
    undo,
    redo,
    loadWordsFromASR,
    loadExternalWords,
    reset
  };
});
