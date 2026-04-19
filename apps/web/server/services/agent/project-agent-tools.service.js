import { withDatabase } from '../core/database.service.js';
import { createTimelineSnapshot } from '../projects/timeline.service.js';
import { exportProjectPackage, exportProjectTimelineVideo } from '../projects/project-export.service.js';
import { getProjectById, removeAssetFromProject, reorderProjectAssets } from '../projects/project.service.js';
import {
  createProjectSlice,
  deleteProjectSlice,
  getProjectSlice,
  listProjectSlices,
  suggestProjectSlices
} from '../projects/project-slice.service.js';
import { getProjectTimeline, listAssetWords } from '../projects/timeline.service.js';
import { recordProjectEditHistory } from '../projects/project-edit-history.service.js';
import {
  buildDeletedGapKeysFromSet,
  buildDeletedWordKeysFromMask,
  buildDeletedGapKeySet,
  buildDeletedWordKeySet,
  getProjectEditState,
  loadProjectEditSource,
  realignProjectEditState,
  saveProjectEditState
} from '../projects/project-edit-state.service.js';

function roundTime(value) {
  return Number(Number(value || 0).toFixed(3));
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/[，。！？、,.!?：:；;"'“”‘’（）()\[\]【】<>《》\-—]/g, '')
    .trim()
    .toLowerCase();
}

function tokenizeSegmentText(text = '') {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return [];
  if (/\s/.test(value)) {
    return value.split(/\s+/).filter(Boolean);
  }
  return Array.from(value).filter((char) => /\S/.test(char));
}

function rangesOverlap(left = {}, right = {}) {
  return Number(left.startWordIndex) <= Number(right.endWordIndex) && Number(right.startWordIndex) <= Number(left.endWordIndex);
}

function mergeProjectTextReplacements(existing = [], incoming = []) {
  if (!incoming.length) return Array.isArray(existing) ? [...existing] : [];

  const filtered = (Array.isArray(existing) ? existing : []).filter((item) => {
    return !incoming.some((candidate) => item.assetId === candidate.assetId && rangesOverlap(item, candidate));
  });

  return [...filtered, ...incoming].sort((left, right) => {
    if (left.assetId !== right.assetId) {
      return String(left.assetId).localeCompare(String(right.assetId));
    }
    return Number(left.startWordIndex || 0) - Number(right.startWordIndex || 0);
  });
}

const SAFE_LEADING_FILLER_PHRASES = ['嗯', '啊', '呃', '额', '诶', '欸', '嗯啊', '啊嗯'];
const BROAD_FILLER_NOISE_PHRASES = [
  '嗯',
  '啊',
  '呃',
  '额',
  '诶',
  '欸',
  '然后',
  '然后呢',
  '就是',
  '就是说',
  '那个',
  '那个呢',
  '这个',
  '这个呢'
];
const SAFE_LEADING_FILLER_TOKENS = SAFE_LEADING_FILLER_PHRASES.map((item) => tokenizeSegmentText(item));
const SAFE_INLINE_FILLER_PHRASES = Array.from(new Set([
  ...SAFE_LEADING_FILLER_PHRASES,
  ...BROAD_FILLER_NOISE_PHRASES,
  '对吧',
  '是吧',
  '好吧',
  '嗯呢',
  '啊哈'
].map((item) => normalizeText(item)).filter(Boolean)));

function normalizeAssembleScriptText(text = '') {
  let value = normalizeText(text);
  for (const phrase of BROAD_FILLER_NOISE_PHRASES) {
    const normalized = normalizeText(phrase);
    if (normalized) {
      value = value.split(normalized).join('');
    }
  }
  return value.trim();
}

function countFillerPhraseHits(text = '') {
  const normalized = normalizeText(text);
  return BROAD_FILLER_NOISE_PHRASES.reduce((count, phrase) => {
    const needle = normalizeText(phrase);
    if (!needle) return count;
    return count + normalized.split(needle).length - 1;
  }, 0);
}

function buildCharacterBigrams(text = '') {
  const value = String(text || '').trim();
  if (!value) return [];
  if (value.length === 1) return [value];

  const grams = [];
  for (let index = 0; index < value.length - 1; index += 1) {
    grams.push(value.slice(index, index + 2));
  }
  return grams;
}

function diceSimilarity(leftText = '', rightText = '') {
  const left = buildCharacterBigrams(leftText);
  const right = buildCharacterBigrams(rightText);
  if (!left.length || !right.length) return 0;

  const leftCounts = new Map();
  for (const gram of left) {
    leftCounts.set(gram, (leftCounts.get(gram) || 0) + 1);
  }

  let overlap = 0;
  for (const gram of right) {
    const current = leftCounts.get(gram) || 0;
    if (current > 0) {
      overlap += 1;
      leftCounts.set(gram, current - 1);
    }
  }

  return (2 * overlap) / (left.length + right.length);
}

function buildStableSegmentId(prefix, assetId = '', startIndex = 0, endIndex = 0) {
  const safeAssetId = String(assetId || 'global').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${prefix}_${safeAssetId}_${Number(startIndex || 0)}_${Number(endIndex || 0)}`;
}

function buildAgentEditHistoryContext(toolName, args = {}, context = {}, note = '') {
  const requestContext = context?.requestContext || {};
  return {
    source: 'agent',
    actorType: 'agent',
    operationType: toolName,
    note: String(note || `Agent ${toolName}`).trim(),
    sessionId: String(requestContext.sessionId || '').trim(),
    runId: String(requestContext.runId || '').trim(),
    metadata: {
      mode: requestContext.mode || '',
      prompt: requestContext.prompt || '',
      topic: requestContext.topic || '',
      target_minutes: Number(requestContext.targetMinutes || 0),
      llm_provider: context?.llm_provider || context?.llmProvider || '',
      llm_model: context?.llm_model || context?.llmModel || '',
      args
    }
  };
}

function buildActiveWordsWithOriginalIndices(state) {
  return state.words.flatMap((word, index) => (
    state.keptMask[index]
      ? [{
          ...word,
          original_index: index
        }]
      : []
  ));
}

function matchLeadingFillerAt(words = [], startIndex = 0, maxIndex = 0) {
  for (const tokens of SAFE_LEADING_FILLER_TOKENS.sort((left, right) => right.length - left.length)) {
    const endIndex = startIndex + tokens.length - 1;
    if (endIndex > maxIndex) continue;

    let matches = true;
    for (let offset = 0; offset < tokens.length; offset += 1) {
      if (String(words[startIndex + offset]?.text || '') !== String(tokens[offset] || '')) {
        matches = false;
        break;
      }
    }

    if (matches) {
      return tokens.length;
    }
  }
  return 0;
}

function isAssembleSentencePureFiller(text = '') {
  return normalizeAssembleScriptText(text).length < 2;
}

function scoreAssembleSentence(sentence = {}) {
  const coreText = normalizeAssembleScriptText(sentence.text || '');
  const fillerHits = countFillerPhraseHits(sentence.text || '');
  let score = coreText.length * 2 - fillerHits * 3;

  if (/[。！？!?；;]/.test(String(sentence.text || ''))) score += 2;
  if (Number(sentence.duration || 0) >= 1 && Number(sentence.duration || 0) <= 12) score += 1;
  if (coreText.length >= 12) score += 2;
  if (coreText.length >= 20) score += 1;

  return score;
}

function shouldCompareAssembleSentences(left = {}, right = {}) {
  if (!left || !right) return false;
  if (left.id === right.id) return false;
  if (left.asset_id !== right.asset_id) return true;
  return Math.abs(Number(left.sequence_index || 0) - Number(right.sequence_index || 0)) <= 6;
}

function areLikelyDuplicateAssembleSentences(left = {}, right = {}) {
  if (!shouldCompareAssembleSentences(left, right)) return false;

  const normalizedLeft = normalizeAssembleScriptText(left.text || '');
  const normalizedRight = normalizeAssembleScriptText(right.text || '');
  if (normalizedLeft.length < 4 || normalizedRight.length < 4) return false;

  if (normalizedLeft === normalizedRight) return true;

  const shorter = normalizedLeft.length <= normalizedRight.length ? normalizedLeft : normalizedRight;
  const longer = normalizedLeft.length > normalizedRight.length ? normalizedLeft : normalizedRight;
  if (longer.includes(shorter) && (shorter.length / longer.length) >= 0.78) {
    return true;
  }

  return diceSimilarity(normalizedLeft, normalizedRight) >= 0.9;
}

function buildDuplicateSentenceClusters(sentences = []) {
  return buildDuplicateClusters(sentences, (left, right) => areLikelyDuplicateAssembleSentences(left, right))
    .map((cluster) => cluster.sort((left, right) => Number(left.start || 0) - Number(right.start || 0)))
    .filter((cluster) => cluster.length > 1);
}

function buildDuplicateClusters(items = [], comparator = () => false) {
  const parent = items.map((_, index) => index);

  const find = (index) => {
    if (parent[index] !== index) {
      parent[index] = find(parent[index]);
    }
    return parent[index];
  };

  const union = (leftIndex, rightIndex) => {
    const leftRoot = find(leftIndex);
    const rightRoot = find(rightIndex);
    if (leftRoot !== rightRoot) {
      parent[rightRoot] = leftRoot;
    }
  };

  for (let leftIndex = 0; leftIndex < items.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < items.length; rightIndex += 1) {
      if (comparator(items[leftIndex], items[rightIndex])) {
        union(leftIndex, rightIndex);
      }
    }
  }

  const groups = new Map();
  items.forEach((item, index) => {
    const root = find(index);
    const list = groups.get(root) || [];
    list.push(item);
    groups.set(root, list);
  });

  return [...groups.values()].filter((cluster) => cluster.length > 1);
}

function scoreAssembleBlock(block = {}) {
  const normalizedText = normalizeAssembleScriptText(block.text || '');
  const fillerHits = countFillerPhraseHits(block.text || '');
  const duration = Number(block.duration || 0);
  const sentenceCount = Number(block.sentence_count || 0);
  let score = normalizedText.length * 1.6 + sentenceCount * 4 - fillerHits * 4;

  if (/[。！？!?；;]/.test(String(block.text || ''))) score += 2;
  if (duration >= 2 && duration <= 24) score += 2;
  if (duration > 36) score -= 1;
  if (normalizedText.length >= 24) score += 2;
  if (normalizedText.length >= 40) score += 1;

  return score;
}

function buildProjectScriptBlocks(sentences = [], options = {}) {
  if (!sentences.length) return [];

  const gapThreshold = Number(options.gapThreshold || 1.2);
  const maxSentences = Number(options.maxSentences || 6);
  const maxDuration = Number(options.maxDuration || 22);
  const blocks = [];
  let startIndex = 0;

  for (let index = 0; index < sentences.length; index += 1) {
    const blockStart = sentences[startIndex];
    const current = sentences[index];
    const next = sentences[index + 1];
    const gap = Math.max(0, Number(next?.start || current.end || 0) - Number(current.end || current.start || 0));
    const sentenceCount = index - startIndex + 1;
    const duration = Number(current.end || current.start || 0) - Number(blockStart.start || 0);
    const assetChanged = normalizeText(current.asset_id) !== normalizeText(next?.asset_id);
    const shouldBreak =
      index === sentences.length - 1 ||
      assetChanged ||
      gap >= gapThreshold ||
      sentenceCount >= maxSentences ||
      duration >= maxDuration;

    if (!shouldBreak) continue;

    const chunk = sentences.slice(startIndex, index + 1);
    const text = chunk.map((sentence) => sentence.text || '').join('');
    const originalWordStart = Number(chunk[0]?.original_word_start ?? chunk[0]?.word_start ?? 0);
    const originalWordEnd = Number(chunk[chunk.length - 1]?.original_word_end ?? chunk[chunk.length - 1]?.word_end ?? 0);
    const assetId = chunk[0]?.asset_id || '';
    blocks.push({
      id: buildStableSegmentId('block', assetId, originalWordStart, originalWordEnd),
      start: roundTime(Number(chunk[0]?.start || 0)),
      end: roundTime(Number(chunk[chunk.length - 1]?.end || chunk[0]?.start || 0)),
      duration: roundTime(Math.max(0.04, Number(chunk[chunk.length - 1]?.end || 0) - Number(chunk[0]?.start || 0))),
      text,
      normalized_text: normalizeAssembleScriptText(text),
      sentence_count: chunk.length,
      sentence_start_index: startIndex,
      sentence_end_index: index,
      sentence_ids: chunk.map((sentence) => sentence.id),
      original_word_start: originalWordStart,
      original_word_end: originalWordEnd,
      asset_id: assetId,
      asset_title: chunk[0]?.asset_title || ''
    });
    startIndex = index + 1;
  }

  return blocks;
}

function buildProjectSentenceWindows(sentences = [], options = {}) {
  if (!sentences.length) return [];

  const minLength = Number(options.minLength || 2);
  const maxLength = Number(options.maxLength || 5);
  const maxDuration = Number(options.maxDuration || 26);
  const windows = [];

  for (let start = 0; start < sentences.length; start += 1) {
    const baseAssetId = sentences[start]?.asset_id || '';
    let text = '';

    for (let end = start; end < Math.min(sentences.length, start + maxLength); end += 1) {
      const sentence = sentences[end];
      if (!sentence || normalizeText(sentence.asset_id) !== normalizeText(baseAssetId)) break;

      text += sentence.text || '';
      const length = end - start + 1;
      const duration = Number(sentence.end || 0) - Number(sentences[start]?.start || 0);

      if (duration > maxDuration) break;
      if (length < minLength) continue;

      const chunk = sentences.slice(start, end + 1);
      const originalWordStart = Number(chunk[0]?.original_word_start ?? chunk[0]?.word_start ?? 0);
      const originalWordEnd = Number(chunk[chunk.length - 1]?.original_word_end ?? chunk[chunk.length - 1]?.word_end ?? 0);
      windows.push({
        id: buildStableSegmentId('window', baseAssetId, originalWordStart, originalWordEnd),
        start: roundTime(Number(chunk[0]?.start || 0)),
        end: roundTime(Number(chunk[chunk.length - 1]?.end || chunk[0]?.start || 0)),
        duration: roundTime(Math.max(0.04, Number(chunk[chunk.length - 1]?.end || 0) - Number(chunk[0]?.start || 0))),
        text,
        normalized_text: normalizeAssembleScriptText(text),
        sentence_count: chunk.length,
        sentence_start_index: start,
        sentence_end_index: end,
        sentence_ids: chunk.map((item) => item.id),
        original_word_start: originalWordStart,
        original_word_end: originalWordEnd,
        asset_id: baseAssetId,
        asset_title: chunk[0]?.asset_title || ''
      });
    }
  }

  return windows;
}

function buildSentenceSignatureList(texts = []) {
  return texts
    .map((item) => normalizeAssembleScriptText(item))
    .filter((item) => item.length >= 2);
}

function longestCommonSubsequenceLength(left = [], right = []) {
  if (!left.length || !right.length) return 0;
  const width = right.length + 1;
  const matrix = Array.from({ length: left.length + 1 }, () => Array(width).fill(0));

  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      if (left[row - 1] === right[column - 1]) {
        matrix[row][column] = matrix[row - 1][column - 1] + 1;
      } else {
        matrix[row][column] = Math.max(matrix[row - 1][column], matrix[row][column - 1]);
      }
    }
  }

  return matrix[left.length][right.length];
}

function sentenceSequenceCoverage(left = [], right = []) {
  if (!left.length || !right.length) return 0;
  const lcsLength = longestCommonSubsequenceLength(left, right);
  return lcsLength / Math.max(1, Math.min(left.length, right.length));
}

function buildProjectTakeBlocks(sentences = [], options = {}) {
  if (!sentences.length) return [];

  const largeGapThreshold = Number(options.largeGapThreshold || 1.35);
  const maxSentences = Number(options.maxSentences || 20);
  const maxDuration = Number(options.maxDuration || 110);
  const blocks = [];
  let startIndex = 0;

  for (let index = 0; index < sentences.length; index += 1) {
    const current = sentences[index];
    const next = sentences[index + 1];
    const blockStart = sentences[startIndex];
    const currentEnd = Number(current?.end || current?.start || 0);
    const nextStart = Number(next?.start || currentEnd);
    const gap = Math.max(0, nextStart - currentEnd);
    const sentenceCount = index - startIndex + 1;
    const duration = currentEnd - Number(blockStart?.start || 0);
    const assetChanged = normalizeText(current?.asset_id) !== normalizeText(next?.asset_id);
    const shouldBreak =
      index === sentences.length - 1 ||
      assetChanged ||
      gap >= largeGapThreshold ||
      sentenceCount >= maxSentences ||
      duration >= maxDuration;

    if (!shouldBreak) continue;

    const chunk = sentences.slice(startIndex, index + 1);
    const text = chunk.map((sentence) => sentence.text || '').join('');
    const sentenceSignatures = buildSentenceSignatureList(chunk.map((sentence) => sentence.text || ''));
    const pauseSeconds = chunk.slice(0, -1).reduce((sum, sentence, sentenceIndex) => {
      const leftEnd = Number(sentence?.end || sentence?.start || 0);
      const rightStart = Number(chunk[sentenceIndex + 1]?.start || leftEnd);
      return sum + Math.max(0, rightStart - leftEnd);
    }, 0);
    const longPauseCount = chunk.slice(0, -1).reduce((count, sentence, sentenceIndex) => {
      const leftEnd = Number(sentence?.end || sentence?.start || 0);
      const rightStart = Number(chunk[sentenceIndex + 1]?.start || leftEnd);
      return count + (Math.max(0, rightStart - leftEnd) >= 0.65 ? 1 : 0);
    }, 0);
    const normalizedText = normalizeAssembleScriptText(text);
    const originalWordStart = Number(chunk[0]?.original_word_start ?? chunk[0]?.word_start ?? 0);
    const originalWordEnd = Number(chunk[chunk.length - 1]?.original_word_end ?? chunk[chunk.length - 1]?.word_end ?? 0);
    const assetId = chunk[0]?.asset_id || '';

    if (normalizedText.length >= 20) {
      blocks.push({
        id: buildStableSegmentId('take', assetId, originalWordStart, originalWordEnd),
        type: 'take_block',
        start: roundTime(Number(chunk[0]?.start || 0)),
        end: roundTime(Number(chunk[chunk.length - 1]?.end || chunk[0]?.start || 0)),
        duration: roundTime(Math.max(0.04, Number(chunk[chunk.length - 1]?.end || 0) - Number(chunk[0]?.start || 0))),
        text,
        normalized_text: normalizedText,
        sentence_count: chunk.length,
        sentence_start_index: startIndex,
        sentence_end_index: index,
        sentence_ids: chunk.map((sentence) => sentence.id),
        sentence_signatures: sentenceSignatures,
        original_word_start: originalWordStart,
        original_word_end: originalWordEnd,
        asset_id: assetId,
        asset_title: chunk[0]?.asset_title || '',
        pause_seconds: roundTime(pauseSeconds),
        long_pause_count: longPauseCount,
        filler_hits: countFillerPhraseHits(text)
      });
    }

    startIndex = index + 1;
  }

  return blocks;
}

function buildProjectTakeWindows(sentences = [], options = {}) {
  if (!sentences.length) return [];

  const minLength = Number(options.minLength || 3);
  const maxLength = Number(options.maxLength || 12);
  const maxDuration = Number(options.maxDuration || 75);
  const windows = [];

  for (let start = 0; start < sentences.length; start += 1) {
    const baseAssetId = sentences[start]?.asset_id || '';
    let text = '';

    for (let end = start; end < Math.min(sentences.length, start + maxLength); end += 1) {
      const sentence = sentences[end];
      if (!sentence || normalizeText(sentence.asset_id) !== normalizeText(baseAssetId)) break;

      text += sentence.text || '';
      const length = end - start + 1;
      const duration = Number(sentence.end || 0) - Number(sentences[start]?.start || 0);
      if (duration > maxDuration) break;
      if (length < minLength) continue;

      const chunk = sentences.slice(start, end + 1);
      const normalizedText = normalizeAssembleScriptText(text);
      if (normalizedText.length < 18) continue;
      const sentenceSignatures = buildSentenceSignatureList(chunk.map((item) => item.text || ''));
      if (sentenceSignatures.length < 2) continue;

      const pauseSeconds = chunk.slice(0, -1).reduce((sum, item, itemIndex) => {
        const leftEnd = Number(item?.end || item?.start || 0);
        const rightStart = Number(chunk[itemIndex + 1]?.start || leftEnd);
        return sum + Math.max(0, rightStart - leftEnd);
      }, 0);

      windows.push({
        id: `take_window_${String(windows.length + 1).padStart(4, '0')}`,
        type: 'take_window',
        start: roundTime(Number(chunk[0]?.start || 0)),
        end: roundTime(Number(chunk[chunk.length - 1]?.end || chunk[0]?.start || 0)),
        duration: roundTime(Math.max(0.04, Number(chunk[chunk.length - 1]?.end || 0) - Number(chunk[0]?.start || 0))),
        text,
        normalized_text: normalizedText,
        sentence_count: chunk.length,
        sentence_start_index: start,
        sentence_end_index: end,
        sentence_ids: chunk.map((item) => item.id),
        sentence_signatures: sentenceSignatures,
        original_word_start: Number(chunk[0]?.original_word_start ?? chunk[0]?.word_start ?? 0),
        original_word_end: Number(chunk[chunk.length - 1]?.original_word_end ?? chunk[chunk.length - 1]?.word_end ?? 0),
        asset_id: baseAssetId,
        asset_title: chunk[0]?.asset_title || '',
        pause_seconds: roundTime(pauseSeconds),
        long_pause_count: chunk.slice(0, -1).reduce((count, item, itemIndex) => {
          const leftEnd = Number(item?.end || item?.start || 0);
          const rightStart = Number(chunk[itemIndex + 1]?.start || leftEnd);
          return count + (Math.max(0, rightStart - leftEnd) >= 0.65 ? 1 : 0);
        }, 0),
        filler_hits: countFillerPhraseHits(text)
      });
    }
  }

  return windows;
}

function buildTakeBlockFromSentenceSlice(sentences = [], startIndex = 0, endIndex = 0, id = 'take_group') {
  const chunk = sentences.slice(startIndex, endIndex + 1);
  if (!chunk.length) return null;

  const text = chunk.map((sentence) => sentence.text || '').join('');
  const sentenceSignatures = buildSentenceSignatureList(chunk.map((sentence) => sentence.text || ''));
  const pauseSeconds = chunk.slice(0, -1).reduce((sum, sentence, sentenceIndex) => {
    const leftEnd = Number(sentence?.end || sentence?.start || 0);
    const rightStart = Number(chunk[sentenceIndex + 1]?.start || leftEnd);
    return sum + Math.max(0, rightStart - leftEnd);
  }, 0);

  return {
    id,
    type: 'take_group',
    start: roundTime(Number(chunk[0]?.start || 0)),
    end: roundTime(Number(chunk[chunk.length - 1]?.end || chunk[0]?.start || 0)),
    duration: roundTime(Math.max(0.04, Number(chunk[chunk.length - 1]?.end || 0) - Number(chunk[0]?.start || 0))),
    text,
    normalized_text: normalizeAssembleScriptText(text),
    sentence_count: chunk.length,
    sentence_start_index: startIndex,
    sentence_end_index: endIndex,
    sentence_ids: chunk.map((sentence) => sentence.id),
    sentence_signatures: sentenceSignatures,
    original_word_start: Number(chunk[0]?.original_word_start ?? chunk[0]?.word_start ?? 0),
    original_word_end: Number(chunk[chunk.length - 1]?.original_word_end ?? chunk[chunk.length - 1]?.word_end ?? 0),
    asset_id: chunk[0]?.asset_id || '',
    asset_title: chunk[0]?.asset_title || '',
    pause_seconds: roundTime(pauseSeconds),
    long_pause_count: chunk.slice(0, -1).reduce((count, sentence, sentenceIndex) => {
      const leftEnd = Number(sentence?.end || sentence?.start || 0);
      const rightStart = Number(chunk[sentenceIndex + 1]?.start || leftEnd);
      return count + (Math.max(0, rightStart - leftEnd) >= 0.65 ? 1 : 0);
    }, 0),
    filler_hits: countFillerPhraseHits(text)
  };
}

function collapseDuplicateTakeCluster(cluster = [], sentences = []) {
  const sorted = [...cluster].sort((left, right) => {
    const assetGap = String(left.asset_id || '').localeCompare(String(right.asset_id || ''));
    if (assetGap !== 0) return assetGap;
    return Number(left.sentence_start_index || 0) - Number(right.sentence_start_index || 0);
  });

  const spans = [];
  for (const item of sorted) {
    const current = spans[spans.length - 1];
    if (
      current &&
      normalizeText(current.asset_id) === normalizeText(item.asset_id) &&
      Number(item.sentence_start_index || 0) <= Number(current.sentence_end_index || 0) + 2
    ) {
      current.sentence_end_index = Math.max(Number(current.sentence_end_index || 0), Number(item.sentence_end_index || 0));
      continue;
    }
    spans.push({
      asset_id: item.asset_id,
      sentence_start_index: Number(item.sentence_start_index || 0),
      sentence_end_index: Number(item.sentence_end_index || 0)
    });
  }

  return spans
    .map((span, spanIndex) => buildTakeBlockFromSentenceSlice(
      sentences,
      span.sentence_start_index,
      span.sentence_end_index,
      `take_group_${spanIndex + 1}`
    ))
    .filter(Boolean);
}

function buildDuplicateTakeClustersFromSentences(sentences = []) {
  const windows = buildProjectTakeWindows(sentences);
  const rawClusters = buildDuplicateClusters(windows, (left, right) => areLikelyDuplicateTakeBlocks(left, right));
  const seen = new Set();
  const clusters = [];

  for (const cluster of rawClusters) {
    const versions = collapseDuplicateTakeCluster(cluster, sentences)
      .filter((item) => String(item.normalized_text || '').length >= 20)
      .sort((left, right) => Number(left.start || 0) - Number(right.start || 0));
    if (versions.length <= 1) continue;

    const signature = versions
      .map((item) => `${item.asset_id}:${item.sentence_start_index}-${item.sentence_end_index}`)
      .join('|');
    if (seen.has(signature)) continue;
    seen.add(signature);
    clusters.push(versions);
  }

  return clusters;
}

function shouldCompareTakeBlocks(left = {}, right = {}) {
  if (!left || !right || left.id === right.id) return false;

  const sameAsset = normalizeText(left.asset_id) === normalizeText(right.asset_id);
  if (sameAsset) {
    const overlaps = Math.max(
      0,
      Math.min(Number(left.sentence_end_index || 0), Number(right.sentence_end_index || 0)) -
        Math.max(Number(left.sentence_start_index || 0), Number(right.sentence_start_index || 0)) + 1
    );
    if (overlaps > 0) return false;
  }

  return true;
}

function areLikelyDuplicateTakeBlocks(left = {}, right = {}) {
  if (!shouldCompareTakeBlocks(left, right)) return false;

  const normalizedLeft = String(left.normalized_text || normalizeAssembleScriptText(left.text || ''));
  const normalizedRight = String(right.normalized_text || normalizeAssembleScriptText(right.text || ''));
  if (normalizedLeft.length < 24 || normalizedRight.length < 24) return false;

  if (normalizedLeft === normalizedRight) return true;

  const shorter = normalizedLeft.length <= normalizedRight.length ? normalizedLeft : normalizedRight;
  const longer = normalizedLeft.length > normalizedRight.length ? normalizedLeft : normalizedRight;
  const lengthRatio = shorter.length / Math.max(longer.length, 1);
  const textSimilarity = diceSimilarity(normalizedLeft, normalizedRight);
  const sentenceCoverage = sentenceSequenceCoverage(
    Array.isArray(left.sentence_signatures) ? left.sentence_signatures : [],
    Array.isArray(right.sentence_signatures) ? right.sentence_signatures : []
  );

  if (longer.includes(shorter) && lengthRatio >= 0.66) {
    return true;
  }

  if (sentenceCoverage >= 0.75 && textSimilarity >= 0.68) {
    return true;
  }

  if (sentenceCoverage >= 0.6 && textSimilarity >= 0.82 && lengthRatio >= 0.72) {
    return true;
  }

  return false;
}

function buildDuplicateTakeClusters(blocks = []) {
  return buildDuplicateClusters(blocks, (left, right) => areLikelyDuplicateTakeBlocks(left, right))
    .map((cluster) => cluster.sort((left, right) => Number(left.start || 0) - Number(right.start || 0)));
}

function scoreAssembleTakeBlock(block = {}) {
  const normalizedText = String(block.normalized_text || normalizeAssembleScriptText(block.text || ''));
  const duration = Number(block.duration || 0);
  const sentenceCount = Number(block.sentence_count || 0);
  const fillerHits = Number(block.filler_hits || countFillerPhraseHits(block.text || ''));
  const pauseSeconds = Number(block.pause_seconds || 0);
  const longPauseCount = Number(block.long_pause_count || 0);

  let score = normalizedText.length * 1.35 + sentenceCount * 5 + Math.min(duration, 90) * 0.35;
  score -= fillerHits * 4.5;
  score -= pauseSeconds * 1.2;
  score -= longPauseCount * 5;

  if (/[。！？!?；;]/.test(String(block.text || ''))) score += 2;
  if (normalizedText.length >= 36) score += 3;
  if (normalizedText.length >= 60) score += 2;
  if (duration >= 4 && duration <= 80) score += 2;

  return score;
}

function chooseBestAssembleTakeBlock(cluster = []) {
  const sorted = [...cluster].sort((left, right) => {
    const scoreGap = scoreAssembleTakeBlock(right) - scoreAssembleTakeBlock(left);
    if (scoreGap !== 0) return scoreGap;
    const completenessGap = String(right.normalized_text || '').length - String(left.normalized_text || '').length;
    if (completenessGap !== 0) return completenessGap;
    return Number(left.start || 0) - Number(right.start || 0);
  });
  return sorted[0] || null;
}

function shouldCompareAssembleBlocks(left = {}, right = {}) {
  if (!left || !right || left.id === right.id) return false;

  const sameAsset = normalizeText(left.asset_id) === normalizeText(right.asset_id);
  if (sameAsset) {
    const distance = Math.abs(Number(left.sentence_start_index || 0) - Number(right.sentence_start_index || 0));
    const minWindow = Math.max(1, Math.min(Number(left.sentence_count || 1), Number(right.sentence_count || 1)));
    if (distance < minWindow) return false;
  }

  return true;
}

function areLikelyDuplicateAssembleBlocks(left = {}, right = {}, options = {}) {
  if (!shouldCompareAssembleBlocks(left, right)) return false;

  const threshold = Number(options.threshold || 0.84);
  const minLength = Number(options.minLength || 16);
  const normalizedLeft = String(left.normalized_text || normalizeAssembleScriptText(left.text || ''));
  const normalizedRight = String(right.normalized_text || normalizeAssembleScriptText(right.text || ''));
  if (normalizedLeft.length < minLength || normalizedRight.length < minLength) return false;

  if (normalizedLeft === normalizedRight) return true;

  const shorter = normalizedLeft.length <= normalizedRight.length ? normalizedLeft : normalizedRight;
  const longer = normalizedLeft.length > normalizedRight.length ? normalizedLeft : normalizedRight;
  const lengthRatio = shorter.length / Math.max(longer.length, 1);

  if (longer.includes(shorter) && lengthRatio >= 0.72) {
    return true;
  }

  return diceSimilarity(normalizedLeft, normalizedRight) >= threshold && lengthRatio >= 0.65;
}

function buildDuplicateBlockClusters(blocks = []) {
  return buildDuplicateClusters(blocks, (left, right) => areLikelyDuplicateAssembleBlocks(left, right, {
    threshold: 0.84,
    minLength: 16
  }))
    .map((cluster) => cluster.sort((left, right) => Number(left.start || 0) - Number(right.start || 0)));
}

function buildDuplicateWindowClusters(windows = []) {
  return buildDuplicateClusters(windows, (left, right) => areLikelyDuplicateAssembleBlocks(left, right, {
    threshold: 0.88,
    minLength: 12
  }))
    .map((cluster) => cluster.sort((left, right) => Number(left.start || 0) - Number(right.start || 0)));
}

function chooseBestAssembleBlock(cluster = []) {
  const sorted = [...cluster].sort((left, right) => {
    const scoreGap = scoreAssembleBlock(right) - scoreAssembleBlock(left);
    if (scoreGap !== 0) return scoreGap;
    const durationGap = Number(right.duration || 0) - Number(left.duration || 0);
    if (durationGap !== 0) return durationGap;
    return Number(left.start || 0) - Number(right.start || 0);
  });
  return sorted[0] || null;
}

function isWordRangeFullyDeleted(keptMask = [], startIndex = 0, endIndex = 0) {
  for (let index = startIndex; index <= endIndex; index += 1) {
    if (keptMask[index]) return false;
  }
  return true;
}

function restoreWordRange(keptMask = [], startIndex = 0, endIndex = 0) {
  for (let index = startIndex; index <= endIndex; index += 1) {
    keptMask[index] = true;
  }
}

function sumRangeDuration(ranges = []) {
  return roundTime(ranges.reduce((sum, range) => sum + Math.max(0, Number(range.end || 0) - Number(range.start || 0)), 0));
}

function buildRemovedBlockCandidates(state) {
  const fullWords = state.words.map((word, index) => ({
    ...word,
    original_index: index
  }));
  const fullSentences = buildProjectSentenceUnits(fullWords, 0.65);
  const fullBlocks = buildProjectScriptBlocks(fullSentences);
  return fullBlocks.filter((block) => isWordRangeFullyDeleted(state.keptMask, block.original_word_start, block.original_word_end));
}

function buildRemovedSubtitleCandidates(state) {
  const fullWords = state.words.map((word, index) => ({
    ...word,
    original_index: index
  }));
  const fullSentences = buildProjectSentenceUnits(fullWords, 0.65);
  return fullSentences.filter((sentence) => isWordRangeFullyDeleted(state.keptMask, sentence.original_word_start, sentence.original_word_end));
}

function buildRemovedTakeCandidates(state) {
  const fullWords = state.words.map((word, index) => ({
    ...word,
    original_index: index
  }));
  const fullSentences = buildProjectSentenceUnits(fullWords, 0.65);
  const fullBlocks = buildProjectTakeBlocks(fullSentences);
  return fullBlocks.filter((block) => isWordRangeFullyDeleted(state.keptMask, block.original_word_start, block.original_word_end));
}

function buildCurrentKeptBlocks(state) {
  const activeWords = buildActiveWordsWithOriginalIndices(state);
  const sentences = buildProjectSentenceUnits(activeWords, 0.65);
  return buildProjectScriptBlocks(sentences);
}

function buildCurrentKeptTakeBlocks(state) {
  const activeWords = buildActiveWordsWithOriginalIndices(state);
  const sentences = buildProjectSentenceUnits(activeWords, 0.65);
  return buildProjectTakeBlocks(sentences);
}

function markWordRangeDeleted(keptMask = [], startIndex = 0, endIndex = 0) {
  for (let index = startIndex; index <= endIndex; index += 1) {
    keptMask[index] = false;
  }
}

function stripLeadingFillerWordsFromSentences(sentences = [], words = [], keptMask = []) {
  let removedWordCount = 0;

  for (const sentence of sentences) {
    let cursor = Number(sentence.word_start || 0);
    let matchedAny = false;

    while (cursor <= Number(sentence.word_end || 0)) {
      const matchLength = matchLeadingFillerAt(words, cursor, Number(sentence.word_end || 0));
      if (!matchLength) break;

      for (let offset = 0; offset < matchLength; offset += 1) {
        const word = words[cursor + offset];
        if (!word) continue;
        markWordRangeDeleted(keptMask, Number(word.original_index || 0), Number(word.original_index || 0));
        removedWordCount += 1;
      }
      cursor += matchLength;
      matchedAny = true;
    }

    if (matchedAny && cursor > Number(sentence.word_end || 0)) {
      markWordRangeDeleted(
        keptMask,
        Number(sentence.original_word_start || sentence.word_start || 0),
        Number(sentence.original_word_end || sentence.word_end || 0)
      );
    }
  }

  return removedWordCount;
}

function flattenCaptionWords(asrResult = {}) {
  if (Array.isArray(asrResult.words)) return asrResult.words;
  if (Array.isArray(asrResult.segments)) {
    const nestedWords = asrResult.segments.flatMap((segment) => segment?.words || []);
    if (nestedWords.length) {
      return nestedWords;
    }

    return asrResult.segments.flatMap((segment, segmentIndex) => {
      const tokens = tokenizeSegmentText(segment?.text || segment?.transcript || '');
      if (!tokens.length) return [];

      const start = Number(segment?.start ?? segment?.start_time ?? 0);
      const end = Number(segment?.end ?? segment?.end_time ?? start + Math.max(tokens.length * 0.12, 0.4));
      const safeEnd = Math.max(start + 0.04, end);
      const unit = Math.max(0.04, (safeEnd - start) / tokens.length);

      return tokens.map((token, tokenIndex) => ({
        id: `${segment?.id || segmentIndex}:synthetic:${tokenIndex}`,
        text: token,
        start_time: roundTime(start + unit * tokenIndex),
        end_time: roundTime(tokenIndex === tokens.length - 1 ? safeEnd : start + unit * (tokenIndex + 1))
      }));
    });
  }
  return [];
}

function formatDuration(seconds) {
  const value = Number(seconds || 0);
  const mins = Math.floor(value / 60);
  const secs = Math.floor(value % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

async function loadProjectAssetWords(projectId, project) {
  const map = {};
  for (const relation of project.projectAssets || []) {
    map[relation.asset.id] = await listAssetWords(relation.asset.id, { projectId });
  }
  return map;
}

function orderProjectAssetsForBaseline(projectAssets = [], timeline = null) {
  const relations = Array.isArray(projectAssets) ? projectAssets : [];
  if (!relations.length) return [];

  const relationByAssetId = new Map(relations.map((relation) => [relation.asset?.id, relation]));
  const ordered = [];
  const used = new Set();

  const clips = Array.isArray(timeline?.clips) ? timeline.clips : [];
  for (const clip of clips) {
    const assetId = clip?.asset_id;
    if (!assetId || used.has(assetId)) continue;
    const relation = relationByAssetId.get(assetId);
    if (!relation) continue;
    ordered.push(relation);
    used.add(assetId);
  }

  for (const relation of relations) {
    const assetId = relation?.asset?.id;
    if (!assetId || used.has(assetId)) continue;
    ordered.push(relation);
    used.add(assetId);
  }

  return ordered;
}

function buildAssetTimelineRanges(projectAssets = []) {
  let cursor = 0;
  return projectAssets.map((relation, index) => {
    const duration = Number(relation.asset.duration_seconds || 0);
    const start = cursor;
    const end = start + duration;
    cursor = end;
    return {
      kind: 'asset',
      clip_id: `asset_${index + 1}`,
      asset_id: relation.asset.id,
      asset_title: relation.asset.title,
      label: relation.asset.title || '',
      source_start: 0,
      source_end: roundTime(duration),
      timeline_start: roundTime(start),
      timeline_end: roundTime(end),
      duration: roundTime(duration),
      sort_order: index + 1
    };
  });
}

function buildClipTimelineRanges(project, timeline = null) {
  const clips = Array.isArray(timeline?.clips) ? timeline.clips : [];
  if (!clips.length) {
    return buildAssetTimelineRanges(project.projectAssets || []);
  }

  return clips.map((clip, index) => ({
    kind: 'clip',
    clip_id: clip.id || `clip_${index + 1}`,
    asset_id: clip.asset_id,
    asset_title: clip.asset_title || '',
    label: clip.label || clip.asset_title || '',
    source_start: roundTime(Number(clip.source_start || 0)),
    source_end: roundTime(Number(clip.source_end || clip.source_start || 0)),
    timeline_start: roundTime(Number(clip.timeline_start || 0)),
    timeline_end: roundTime(Number(clip.timeline_end || clip.timeline_start || 0)),
    duration: roundTime(Number(clip.duration || 0)),
    sort_order: Number(clip.sort_order || index + 1)
  })).filter((clip) => clip.source_end > clip.source_start);
}

function buildFullProjectWordStream(assetTimelineRanges, assetWordsMap) {
  const words = [];

  for (const range of assetTimelineRanges) {
    const assetWords = assetWordsMap[range.asset_id] || [];
    for (let assetWordIndex = 0; assetWordIndex < assetWords.length; assetWordIndex += 1) {
      const word = assetWords[assetWordIndex];
      const sourceStart = Number(word.start_time || 0);
      const sourceEnd = Math.max(sourceStart + 0.01, Number(word.end_time || sourceStart + 0.01));
      const clippedSourceStart = Math.max(sourceStart, Number(range.source_start ?? 0));
      const clippedSourceEnd = Math.min(sourceEnd, Number(range.source_end ?? sourceEnd));
      if (clippedSourceEnd - clippedSourceStart <= 0.001) continue;
      words.push({
        id: `${range.clip_id}:${word.id}`,
        text: String(word.text || ''),
        asset_id: range.asset_id,
        asset_title: range.asset_title,
        clip_id: range.clip_id,
        clip_label: range.label,
        start_time: roundTime(Number(range.timeline_start || 0) + (clippedSourceStart - Number(range.source_start || 0))),
        end_time: roundTime(Number(range.timeline_start || 0) + (clippedSourceEnd - Number(range.source_start || 0))),
        source_start_time: roundTime(clippedSourceStart),
        source_end_time: roundTime(clippedSourceEnd),
        asset_word_index: assetWordIndex,
        clip_sort_order: range.sort_order
      });
    }
  }

  return words;
}

function buildKeepRangesFromProjectTimeline(timelineClips = [], assetTimelineRanges = []) {
  if (!Array.isArray(timelineClips) || !timelineClips.length) {
    return assetTimelineRanges
      .filter((range) => range.timeline_end > range.timeline_start)
      .map((range) => ({
        start: range.timeline_start,
        end: range.timeline_end
      }));
  }

  const assetBaseMap = new Map(assetTimelineRanges.map((range) => [range.asset_id, range]));
  return timelineClips
    .map((clip) => {
      const baseRange = assetBaseMap.get(clip.asset_id);
      if (!baseRange) return null;
      const sourceStart = Number(clip.source_start || 0);
      const sourceEnd = Number(clip.source_end || sourceStart || 0);
      if (sourceEnd <= sourceStart) return null;
      return {
        start: roundTime(Number(baseRange.timeline_start || 0) + sourceStart),
        end: roundTime(Number(baseRange.timeline_start || 0) + sourceEnd)
      };
    })
    .filter(Boolean);
}

function isWordKept(word, keepRanges) {
  const middle = Number(word.start_time || 0) + (Number(word.end_time || 0) - Number(word.start_time || 0)) / 2;
  return keepRanges.some((range) => middle >= Number(range.start || 0) && middle <= Number(range.end || 0));
}

function buildEditableProjectState(project, assetWordsMap) {
  const timeline = project.currentTimeline || null;
  const currentTimelineRanges = buildClipTimelineRanges(project, timeline);
  const assetTimelineRanges = currentTimelineRanges.length
    ? currentTimelineRanges
    : buildAssetTimelineRanges(project.projectAssets || []);
  const words = buildFullProjectWordStream(assetTimelineRanges, assetWordsMap);
  const keepRanges = assetTimelineRanges
    .filter((range) => Number(range.timeline_end || 0) > Number(range.timeline_start || 0))
    .map((range) => ({
      start: roundTime(Number(range.timeline_start || 0)),
      end: roundTime(Number(range.timeline_end || 0))
    }));
  const keptMask = words.map(() => true);
  return {
    timeline,
    assetTimelineRanges,
    currentTimelineRanges,
    words,
    keepRanges,
    keptMask
  };
}

function buildKeepRangesFromMask(words, keptMask, breakAfterWordIndices = new Set()) {
  const ranges = [];
  let segmentStart = null;

  for (let index = 0; index < words.length; index += 1) {
    if (!keptMask[index]) {
      if (segmentStart !== null) {
        ranges.push({
          start: roundTime(words[segmentStart].start_time),
          end: roundTime(words[index - 1].end_time)
        });
        segmentStart = null;
      }
      continue;
    }

    if (segmentStart === null) {
      segmentStart = index;
    }

    const nextKept = index < words.length - 1 ? keptMask[index + 1] : false;
    if (!nextKept || breakAfterWordIndices.has(index)) {
      ranges.push({
        start: roundTime(words[segmentStart].start_time),
        end: roundTime(words[index].end_time)
      });
      segmentStart = null;
    }
  }

  return ranges;
}

function buildTimelinePayloadFromRanges(ranges, assetTimelineRanges) {
  const payload = [];

  for (const range of ranges) {
    for (const assetRange of assetTimelineRanges) {
      const overlapStart = Math.max(Number(range.start || 0), Number(assetRange.timeline_start || 0));
      const overlapEnd = Math.min(Number(range.end || 0), Number(assetRange.timeline_end || 0));
      if (overlapEnd - overlapStart <= 0.001) continue;

      payload.push({
        asset_id: assetRange.asset_id,
        source_start: roundTime(Number(assetRange.source_start || 0) + (overlapStart - Number(assetRange.timeline_start || 0))),
        source_end: roundTime(Number(assetRange.source_start || 0) + (overlapEnd - Number(assetRange.timeline_start || 0))),
        label: assetRange.label || assetRange.asset_title || ''
      });
    }
  }

  const merged = [];
  for (const clip of payload) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.asset_id === clip.asset_id &&
      Math.abs(Number(previous.source_end || 0) - Number(clip.source_start || 0)) <= 0.02
    ) {
      previous.source_end = clip.source_end;
    } else {
      merged.push({ ...clip });
    }
  }

  return merged;
}

async function persistEditableProjectState(projectId, state, { deletedGapKeys = null, audit = null } = {}) {
  const result = await saveProjectEditState(projectId, {
    assetOrder: state.editState?.asset_order || [],
    deletedWordKeys: buildDeletedWordKeysFromMask(state.words, state.keptMask),
    deletedGapKeys: deletedGapKeys || buildDeletedGapKeysFromSet(state.words, new Set()),
    textReplacements: state.editState?.text_replacements || [],
    ...(audit || {})
  });
  return result.timeline;
}

function buildProjectAsrResult(words = []) {
  const safeWords = [...words]
    .map((word, index) => ({
      id: word.id || `project_word_${index}`,
      text: String(word.text || ''),
      start_time: roundTime(Number(word.start_time || 0)),
      end_time: roundTime(Math.max(Number(word.start_time || 0) + 0.01, Number(word.end_time || word.start_time || 0)))
    }))
    .sort((left, right) => left.start_time - right.start_time);

  return {
    language: 'Chinese',
    duration: safeWords.length ? Number(safeWords[safeWords.length - 1].end_time || 0) : 0,
    words: safeWords
  };
}

function buildProjectSentenceUnits(words = [], gapThreshold = 0.8) {
  if (!words.length) return [];

  const sentences = [];
  let startIndex = 0;

  for (let index = 0; index < words.length; index += 1) {
    const current = words[index];
    const next = words[index + 1];
    const currentText = String(current.text || '');
    const currentEnd = Number(current.end_time || current.start_time || 0);
    const nextStart = Number(next?.start_time || currentEnd);
    const gap = Math.max(0, nextStart - currentEnd);
    const shouldBreak =
      index === words.length - 1 ||
      normalizeText(current.asset_id) !== normalizeText(next?.asset_id) ||
      /[。！？!?；;]/.test(currentText) ||
      gap >= gapThreshold ||
      index - startIndex >= 24;

    if (!shouldBreak) continue;

    const chunk = words.slice(startIndex, index + 1);
    const text = chunk.map((word) => word.text || '').join('');
    const originalWordStart = Number(chunk[0]?.original_index ?? startIndex);
    const originalWordEnd = Number(chunk[chunk.length - 1]?.original_index ?? index);
    const assetId = chunk[0]?.asset_id || '';
    sentences.push({
      id: buildStableSegmentId('sent', assetId, originalWordStart, originalWordEnd),
      sequence_index: sentences.length,
      start: roundTime(Number(chunk[0]?.start_time || 0)),
      end: roundTime(Number(chunk[chunk.length - 1]?.end_time || chunk[0]?.start_time || 0)),
      duration: roundTime(Math.max(0.04, Number(chunk[chunk.length - 1]?.end_time || 0) - Number(chunk[0]?.start_time || 0))),
      text,
      word_start: startIndex,
      word_end: index,
      original_word_start: originalWordStart,
      original_word_end: originalWordEnd,
      asset_id: assetId,
      asset_title: chunk[0]?.asset_title || ''
    });
    startIndex = index + 1;
  }

  return sentences;
}

function buildAllProjectSentenceUnits(state, gapThreshold = 0.65) {
  return buildProjectSentenceUnits(
    state.words.map((word, index) => ({
      ...word,
      original_index: index
    })),
    gapThreshold
  );
}

function parseTagContent(text, tagName) {
  const match = String(text || '').match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  return match ? match[1].trim() : '';
}

function parseKeepSentenceIds(text) {
  return parseTagContent(text, 'KEEP')
    .split(/[,\n]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function mergeAdjacentSentenceRanges(sentences = [], keepIdSet = new Set()) {
  const kept = sentences.filter((sentence) => keepIdSet.has(sentence.id));
  if (!kept.length) return [];

  const ranges = [{ start: kept[0].start, end: kept[0].end }];
  for (let index = 1; index < kept.length; index += 1) {
    const current = kept[index];
    const previous = ranges[ranges.length - 1];
    if (current.start <= previous.end + 0.35) {
      previous.end = roundTime(Math.max(previous.end, current.end));
    } else {
      ranges.push({ start: current.start, end: current.end });
    }
  }
  return ranges;
}

function buildHeuristicSentenceSelection(sentences = [], {
  mode = 'highlights',
  topic = '',
  targetMinutes = 0,
  customInstruction = ''
} = {}) {
  const normalizedTopic = normalizeText(topic);
  const normalizedInstruction = normalizeText(customInstruction);
  const scored = sentences.map((sentence) => {
    const text = String(sentence.text || '');
    let score = 1;

    if (/[。！？!?]/.test(text)) score += 1;
    if (/(方法|步骤|原因|关键|重点|总结|结论|建议|比如|例如|因为|所以|问题|解决)/.test(text)) score += 2;
    if (/(嗯|啊|呃|这个|那个|就是|然后)/.test(text)) score -= 1;
    if (text.length >= 10 && text.length <= 48) score += 1;

    if (mode === 'extract' && normalizedTopic) {
      score += normalizeText(text).includes(normalizedTopic) ? 4 : -2;
    }

    if (mode === 'clean') {
      if (/(听到吗|声音|麦克风|测试|喂)/.test(text)) score -= 4;
    }

    if (mode === 'assemble_script' && normalizedInstruction) {
      if (normalizeText(text).includes(normalizedInstruction)) score += 1;
    }

    return { ...sentence, score };
  });

  const sorted = [...scored].sort((left, right) => right.score - left.score || left.start - right.start);
  let budgetSeconds = 0;
  if (mode === 'trim' && Number(targetMinutes || 0) > 0) {
    budgetSeconds = Number(targetMinutes) * 60;
  } else if (mode === 'highlights') {
    budgetSeconds = Math.max(25, scored.reduce((sum, item) => sum + item.duration, 0) * 0.4);
  } else if (mode === 'extract') {
    budgetSeconds = Math.max(20, scored.reduce((sum, item) => sum + item.duration, 0) * 0.5);
  }

  const keep = [];
  let used = 0;
  for (const sentence of sorted) {
    if (sentence.score <= 0) continue;
    if (budgetSeconds > 0 && used >= budgetSeconds) break;
    keep.push(sentence.id);
    used += sentence.duration;
  }

  if (!keep.length && sorted.length) {
    keep.push(sorted[0].id);
  }

  return new Set(keep);
}

function findPhraseMatches(words, keptMask, phrase, assetTitle = '') {
  const needle = normalizeText(phrase);
  const assetNeedle = normalizeText(assetTitle);
  if (!needle) return [];

  const matches = [];

  for (let start = 0; start < words.length; start += 1) {
    if (!keptMask[start]) continue;
    if (assetNeedle && normalizeText(words[start].asset_title) !== assetNeedle) continue;

    let combined = '';
    for (let end = start; end < words.length && end < start + 80; end += 1) {
      if (!keptMask[end]) break;
      if (assetNeedle && normalizeText(words[end].asset_title) !== assetNeedle) break;

      combined += normalizeText(words[end].text);

      if (combined === needle) {
        matches.push({ start, end });
        break;
      }

      if (!needle.startsWith(combined)) {
        break;
      }
    }
  }

  return matches;
}

function isPhraseBoundaryToken(text = '') {
  return /[，。！？、,.!?：:；;"'“”‘’（）()\[\]【】<>《》\-—]/.test(String(text || ''));
}

function isStandalonePhraseMatch(words = [], match = {}) {
  const start = Number(match.start || 0);
  const end = Number(match.end || 0);
  const first = words[start];
  const last = words[end];
  if (!first || !last) return false;

  const previous = words[start - 1] || null;
  const next = words[end + 1] || null;
  const gapBefore = previous && previous.asset_id === first.asset_id
    ? Number(first.start_time || 0) - Number(previous.end_time || 0)
    : Infinity;
  const gapAfter = next && next.asset_id === last.asset_id
    ? Number(next.start_time || 0) - Number(last.end_time || 0)
    : Infinity;

  const startBoundary = !previous ||
    previous.asset_id !== first.asset_id ||
    gapBefore >= 0.18 ||
    isPhraseBoundaryToken(previous.text);
  const endBoundary = !next ||
    next.asset_id !== last.asset_id ||
    gapAfter >= 0.18 ||
    isPhraseBoundaryToken(next.text) ||
    isPhraseBoundaryToken(last.text);

  return startBoundary && endBoundary;
}

function isSafeInlineFillerPhrase(phrase = '') {
  const needle = normalizeText(phrase);
  if (!needle) return false;
  if (needle.length > 4) return false;
  return SAFE_INLINE_FILLER_PHRASES.includes(needle);
}

function filterSafePhraseMatches(words = [], matches = [], phrase = '', { strictAssemble = false } = {}) {
  if (!strictAssemble) return matches;
  if (!isSafeInlineFillerPhrase(phrase)) return [];
  return matches.filter((match) => isStandalonePhraseMatch(words, match));
}

function buildPausePreview(words = [], startIndex = 0, endIndex = 0, { trimStart = false, trimEnd = false } = {}) {
  const text = words
    .slice(Math.max(0, startIndex), Math.min(words.length, endIndex + 1))
    .map((word) => String(word?.text || ''))
    .join('')
    .trim();
  if (!text) return '';
  if (trimStart && text.length > 18) return `…${text.slice(-18)}`;
  if (trimEnd && text.length > 18) return `${text.slice(0, 18)}…`;
  return text;
}

function buildPauseCandidateAlias(candidate = {}) {
  const assetPart = String(candidate.asset_title || candidate.asset_id || 'gap').trim() || 'gap';
  return `${assetPart}::${roundTime(candidate.start)}-${roundTime(candidate.end)}`;
}

function buildPauseCandidates(state, {
  minGapSeconds = 0.35,
  assetTitle = '',
  limit = null,
  includeDeleted = false,
  gapKeys = []
} = {}) {
  const words = Array.isArray(state?.words) ? state.words : [];
  const keptMask = Array.isArray(state?.keptMask) ? state.keptMask : [];
  const deletedGapKeys = new Set(state?.editState?.deleted_gap_keys || []);
  const safeMinGap = Math.max(0, Number(minGapSeconds || 0));
  const assetNeedle = normalizeText(assetTitle);
  const requestedGapKeys = new Set((Array.isArray(gapKeys) ? gapKeys : []).map((value) => String(value || '').trim()).filter(Boolean));
  const keptIndices = words.flatMap((word, index) => (keptMask[index] ? [index] : []));
  const candidates = [];

  for (let position = 0; position < keptIndices.length - 1; position += 1) {
    const leftIndex = keptIndices[position];
    const rightIndex = keptIndices[position + 1];
    const left = words[leftIndex];
    const right = words[rightIndex];
    if (!left || !right) continue;
    if (String(left.asset_id || '') !== String(right.asset_id || '')) continue;
    if (assetNeedle && normalizeText(left.asset_title) !== assetNeedle) continue;

    const gapKey = String(left.gap_key_after || '').trim();
    if (!gapKey) continue;
    if (requestedGapKeys.size && !requestedGapKeys.has(gapKey)) continue;

    const alreadyDeleted = deletedGapKeys.has(gapKey);
    if (alreadyDeleted && !includeDeleted) continue;

    const leftSentenceBoundary = /[。！？!?；;]/.test(String(left.text || ''));
    const rightStartsWithFiller = isSafeInlineFillerPhrase(right.text || '');
    const leftEndsWithFiller = isSafeInlineFillerPhrase(left.text || '');
    const gapSeconds = roundTime(Math.max(0, Number(right.start_time || 0) - Number(left.end_time || 0)));
    const effectiveMinGap = safeMinGap <= 0.35 && (leftSentenceBoundary || rightStartsWithFiller || leftEndsWithFiller)
      ? 0.25
      : safeMinGap;
    if (gapSeconds < effectiveMinGap) continue;

    const suggestionReasons = [];
    let priorityScore = gapSeconds * 10;
    if (gapSeconds >= 0.9) priorityScore += 3;
    if (gapSeconds >= 0.6) priorityScore += 1;
    if (rightStartsWithFiller) priorityScore += 1;
    if (leftEndsWithFiller) priorityScore += 0.5;
    if (leftSentenceBoundary && gapSeconds < 0.45) priorityScore -= 1;

    if (gapSeconds >= 1.2) suggestionReasons.push('长停顿');
    else if (gapSeconds >= 0.75) suggestionReasons.push('明显停顿');
    else if (gapSeconds >= 0.35) suggestionReasons.push('微停顿');
    if (leftSentenceBoundary) suggestionReasons.push('句间停顿');
    if (rightStartsWithFiller || leftEndsWithFiller) suggestionReasons.push('口头禅边界');

    let safetyLevel = 'low';
    let recommended = false;
    if (gapSeconds >= 0.9 || ((rightStartsWithFiller || leftEndsWithFiller) && gapSeconds >= 0.25)) {
      safetyLevel = 'high';
      recommended = true;
      priorityScore += 3;
    } else if (gapSeconds >= 0.45 || (leftSentenceBoundary && gapSeconds >= 0.35)) {
      safetyLevel = 'medium';
      recommended = true;
      priorityScore += 1.5;
    }

    const candidate = {
      gap_key: gapKey,
      asset_id: left.asset_id,
      asset_title: left.asset_title,
      start: roundTime(Number(left.end_time || 0)),
      end: roundTime(Number(right.start_time || 0)),
      gap_seconds: gapSeconds,
      left_word_index: Number(left.asset_word_index || 0),
      right_word_index: Number(right.asset_word_index || 0),
      left_preview: buildPausePreview(words, leftIndex - 5, leftIndex, { trimStart: true }),
      right_preview: buildPausePreview(words, rightIndex, rightIndex + 5, { trimEnd: true }),
      left_sentence_boundary: leftSentenceBoundary,
      right_starts_with_filler: rightStartsWithFiller,
      already_deleted: alreadyDeleted,
      safety_level: safetyLevel,
      recommended,
      suggestion_reasons: suggestionReasons,
      priority_score: roundTime(priorityScore)
    };
    candidate.gap_alias = buildPauseCandidateAlias(candidate);
    candidates.push(candidate);
  }

  const sorted = candidates.sort((left, right) => {
    if (Boolean(right.recommended) !== Boolean(left.recommended)) {
      return Number(Boolean(right.recommended)) - Number(Boolean(left.recommended));
    }
    const priorityGap = Number(right.priority_score || 0) - Number(left.priority_score || 0);
    if (priorityGap !== 0) return priorityGap;
    const durationGap = Number(right.gap_seconds || 0) - Number(left.gap_seconds || 0);
    if (durationGap !== 0) return durationGap;
    return Number(left.start || 0) - Number(right.start || 0);
  });

  if (limit == null) return sorted;
  return sorted.slice(0, Math.max(1, Number(limit || 1)));
}

function findDeletedPhraseMatches(words, keptMask, phrase, assetTitle = '') {
  const needle = normalizeText(phrase);
  const assetNeedle = normalizeText(assetTitle);
  if (!needle) return [];

  const matches = [];

  for (let start = 0; start < words.length; start += 1) {
    if (keptMask[start]) continue;
    if (assetNeedle && normalizeText(words[start].asset_title) !== assetNeedle) continue;

    let combined = '';
    for (let end = start; end < words.length && end < start + 80; end += 1) {
      if (keptMask[end]) break;
      if (assetNeedle && normalizeText(words[end].asset_title) !== assetNeedle) break;

      combined += normalizeText(words[end].text);

      if (combined === needle) {
        matches.push({ start, end });
        break;
      }

      if (!needle.startsWith(combined)) {
        break;
      }
    }
  }

  return matches;
}

async function loadProjectEditableState(projectId) {
  const project = await getProjectById(projectId);
  if (!project) {
    throw new Error('Project not found');
  }
  const currentTimeline = await getProjectTimeline(projectId);
  project.currentTimeline = currentTimeline;
  const sourceState = await loadProjectEditSource(projectId);
  const deletedWordKeys = buildDeletedWordKeySet(sourceState);
  const deletedGapKeys = buildDeletedGapKeySet(sourceState);
  const keptMask = sourceState.words.map((word) => !deletedWordKeys.has(String(word.word_key || word.id || '')));
  const editable = {
    timeline: currentTimeline,
    assetTimelineRanges: sourceState.asset_timeline_ranges,
    currentTimelineRanges: currentTimeline?.clips || [],
    words: sourceState.words,
    keepRanges: buildKeepRangesFromMask(
      sourceState.words,
      keptMask,
      new Set(
        sourceState.words
          .flatMap((word, index) => (deletedGapKeys.has(String(word.gap_key_after || '')) ? [index] : []))
      )
    ),
    keptMask,
    editState: sourceState
  };
  return {
    project,
    currentTimeline,
    assetWordsMap: {},
    ...editable
  };
}

function mapAssembleCandidateVersion(version = {}) {
  return {
    id: version.id,
    asset_id: version.asset_id,
    asset_title: version.asset_title,
    start: version.start,
    end: version.end,
    duration: version.duration,
    text: version.text,
    sentence_ids: Array.isArray(version.sentence_ids) ? version.sentence_ids : [],
    sentence_count: Number(version.sentence_count || 0),
    filler_hits: Number(version.filler_hits || 0),
    pause_seconds: Number(version.pause_seconds || 0),
    long_pause_count: Number(version.long_pause_count || 0)
  };
}

export async function toolGetAssembleCandidates(
  projectId,
  {
    take_limit: takeLimit = 12,
    sentence_limit: sentenceLimit = 12,
    pause_limit: pauseLimit = 12,
    min_pause_seconds: minPauseSeconds = 0.35
  } = {}
) {
  const state = await loadProjectEditableState(projectId);
  const activeWords = buildActiveWordsWithOriginalIndices(state);
  const activeSentences = buildProjectSentenceUnits(activeWords, 0.65);
  const scriptBlocks = buildProjectScriptBlocks(activeSentences);
  const pauseCandidates = buildPauseCandidates(state, {
    minGapSeconds: minPauseSeconds,
    limit: Math.max(1, Number(pauseLimit || 12))
  });

  const rawTakeGroups = buildDuplicateTakeClustersFromSentences(activeSentences)
    .map((cluster, index) => ({
      id: `take_group_${index + 1}`,
      versions: cluster.map((version) => mapAssembleCandidateVersion(version)),
      score: cluster.reduce((sum, version) => sum + scoreAssembleTakeBlock(version), 0)
    }))
    .filter((group) => group.versions.length > 1)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, Number(takeLimit || 12)));

  const rawSentenceGroups = buildDuplicateSentenceClusters(activeSentences)
    .map((cluster, index) => ({
      id: `sentence_group_${index + 1}`,
      versions: cluster.map((version) => mapAssembleCandidateVersion(version)),
      score: cluster.reduce((sum, version) => sum + scoreAssembleSentence(version), 0)
    }))
    .filter((group) => group.versions.length > 1)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, Number(sentenceLimit || 12)));

  return {
    success: true,
    change: 'get_assemble_candidates',
    summary: `识别到 ${rawTakeGroups.length} 组重复 take 候选、${rawSentenceGroups.length} 组重复句候选、${pauseCandidates.length} 个明显停顿候选（其中 ${pauseCandidates.filter((candidate) => candidate.recommended).length} 个推荐优先处理）。`,
    script_block_count: scriptBlocks.length,
    take_group_count: rawTakeGroups.length,
    sentence_group_count: rawSentenceGroups.length,
    pause_candidate_count: pauseCandidates.length,
    recommended_pause_candidate_count: pauseCandidates.filter((candidate) => candidate.recommended).length,
    take_groups: rawTakeGroups,
    sentence_groups: rawSentenceGroups,
    pause_candidates: pauseCandidates
  };
}

export async function toolGetPauseCandidates(projectId, { min_gap_seconds: minGapSeconds = 0.35, limit = 24, asset_title: assetTitle = '' } = {}) {
  const state = await loadProjectEditableState(projectId);
  const candidates = buildPauseCandidates(state, {
    minGapSeconds,
    assetTitle,
    limit: Math.min(120, Math.max(1, Number(limit || 24)))
  });

  return {
    success: true,
    change: 'get_pause_candidates',
    summary: candidates.length
      ? `识别到 ${candidates.length} 个明显停顿候选，其中 ${candidates.filter((candidate) => candidate.recommended).length} 个推荐优先处理。`
      : '当前没有达到阈值的明显停顿候选。',
    total: candidates.length,
    min_gap_seconds: Number(minGapSeconds || 0.35),
    recommended_count: candidates.filter((candidate) => candidate.recommended).length,
    candidates
  };
}

export async function toolListProjectAssets(projectId) {
  const project = await getProjectById(projectId);
  if (!project) {
    throw new Error('Project not found');
  }

  const timeline = await getProjectTimeline(projectId);
  const orderedProjectAssets = orderProjectAssetsForBaseline(project.projectAssets || [], timeline);

  return {
    success: true,
    change: 'list_project_assets',
    summary: `当前项目共有 ${(project.projectAssets || []).length} 个素材（按当前时间线顺序）：${orderedProjectAssets.map((relation) => relation.asset.title).join('、')}`,
    assets: orderedProjectAssets.map((relation) => ({
      id: relation.asset.id,
      title: relation.asset.title,
      duration_seconds: relation.asset.duration_seconds,
      sort_order: relation.sort_order ?? relation.sortOrder ?? 0
    }))
  };
}

export async function toolGetTimelineDetail(projectId, { offset = 0, limit = 50 } = {}) {
  const timeline = await getProjectTimeline(projectId);
  const clips = timeline?.clips || [];
  const totalDurationSeconds = clips.reduce((sum, clip) => sum + Number(clip.duration || 0), 0);
  const safeOffset = Math.max(0, Number(offset || 0));
  const safeLimit = Math.min(200, Math.max(1, Number(limit || 50)));
  const page = clips.slice(safeOffset, safeOffset + safeLimit);

  return {
    success: true,
    change: 'get_timeline_detail',
    summary: `当前时间线共有 ${clips.length} 个片段，当前成片时长 ${formatDuration(totalDurationSeconds)}。`,
    clip_count: clips.length,
    current_cut_duration_seconds: roundTime(totalDurationSeconds),
    offset: safeOffset,
    has_more: safeOffset + safeLimit < clips.length,
    next_offset: safeOffset + safeLimit < clips.length ? safeOffset + safeLimit : null,
    clips: page.map((clip, index) => ({
      id: clip.id,
      order: safeOffset + index + 1,
      asset_id: clip.asset_id,
      asset_title: clip.asset_title,
      label: clip.label,
      source_start: clip.source_start,
      source_end: clip.source_end,
      timeline_start: clip.timeline_start,
      timeline_end: clip.timeline_end,
      duration: clip.duration
    }))
  };
}

export async function toolSearchProjectSubtitles(projectId, { query = '', limit = 12 } = {}) {
  const state = await loadProjectEditableState(projectId);
  const needle = normalizeText(query);
  if (!needle) {
    return {
      success: false,
      change: 'search_project_subtitles',
      summary: '搜索词不能为空。'
    };
  }

  const sentences = buildProjectSentenceUnits(buildActiveWordsWithOriginalIndices(state), 0.65);
  const hits = sentences
    .filter((sentence) => normalizeText(sentence.text).includes(needle))
    .slice(0, Math.max(1, Number(limit || 12)))
    .map((sentence) => ({
      id: sentence.id,
      asset_id: sentence.asset_id,
      asset_title: sentence.asset_title,
      start: sentence.start,
      end: sentence.end,
      text: sentence.text
    }));

  return {
    success: true,
    change: 'search_project_subtitles',
    summary: hits.length ? `找到 ${hits.length} 段匹配字幕。` : '没有找到匹配字幕。',
    matches: hits
  };
}

export async function toolGetSubtitleBlocks(projectId, { offset = 0, limit = null } = {}) {
  const state = await loadProjectEditableState(projectId);
  const sentences = buildProjectSentenceUnits(buildActiveWordsWithOriginalIndices(state), 0.65);
  const safeOffset = Math.max(0, Number(offset || 0));
  const fallbackLimit = Math.max(1, sentences.length || 1);
  const safeLimit = Math.min(200, Math.max(1, Number(limit ?? fallbackLimit)));
  const blocks = sentences.slice(safeOffset, safeOffset + safeLimit).map((sentence, index) => ({
    id: sentence.id,
    order: safeOffset + index + 1,
    asset_id: sentence.asset_id,
    asset_title: sentence.asset_title,
    start: sentence.start,
    end: sentence.end,
    text: sentence.text
  }));

  return {
    success: true,
    change: 'get_subtitle_blocks',
    summary: `返回 ${blocks.length} 个字幕块（共 ${sentences.length} 个）。`,
    total: sentences.length,
    offset: safeOffset,
    limit: safeLimit,
    has_more: safeOffset + blocks.length < sentences.length,
    next_offset: safeOffset + blocks.length < sentences.length ? safeOffset + blocks.length : null,
    blocks
  };
}

export async function toolGetScriptBlocks(projectId, { offset = 0, limit = null } = {}) {
  const state = await loadProjectEditableState(projectId);
  const scriptBlocks = buildProjectScriptBlocks(buildProjectSentenceUnits(buildActiveWordsWithOriginalIndices(state), 0.65));
  const safeOffset = Math.max(0, Number(offset || 0));
  const fallbackLimit = Math.max(1, scriptBlocks.length || 1);
  const safeLimit = Math.min(200, Math.max(1, Number(limit ?? fallbackLimit)));
  const blocks = scriptBlocks.slice(safeOffset, safeOffset + safeLimit).map((block, index) => ({
    id: block.id,
    order: safeOffset + index + 1,
    asset_id: block.asset_id,
    asset_title: block.asset_title,
    start: block.start,
    end: block.end,
    duration: block.duration,
    sentence_count: block.sentence_count,
    sentence_ids: block.sentence_ids,
    text: block.text
  }));

  return {
    success: true,
    change: 'get_script_blocks',
    summary: `返回 ${blocks.length} 个口播块（共 ${scriptBlocks.length} 个）。`,
    total: scriptBlocks.length,
    offset: safeOffset,
    limit: safeLimit,
    has_more: safeOffset + blocks.length < scriptBlocks.length,
    next_offset: safeOffset + blocks.length < scriptBlocks.length ? safeOffset + blocks.length : null,
    blocks
  };
}

export async function toolGetDeletedSubtitleBlocks(projectId, { offset = 0, limit = 20 } = {}) {
  const state = await loadProjectEditableState(projectId);
  const deletedBlocks = buildRemovedSubtitleCandidates(state);
  const safeOffset = Math.max(0, Number(offset || 0));
  const safeLimit = Math.min(20, Math.max(1, Number(limit || 20)));
  const blocks = deletedBlocks.slice(safeOffset, safeOffset + safeLimit).map((block, index) => ({
    id: block.id,
    order: safeOffset + index + 1,
    asset_id: block.asset_id,
    asset_title: block.asset_title,
    start: block.start,
    end: block.end,
    duration: block.duration,
    sentence_count: block.sentence_count,
    sentence_ids: block.sentence_ids,
    text: block.text
  }));

  return {
    success: true,
    change: 'get_deleted_subtitle_blocks',
    summary: blocks.length ? `返回 ${blocks.length} 个已删除字幕块。` : '当前没有已删除字幕块。',
    total: deletedBlocks.length,
    offset: safeOffset,
    limit: safeLimit,
    has_more: safeOffset + blocks.length < deletedBlocks.length,
    next_offset: safeOffset + blocks.length < deletedBlocks.length ? safeOffset + blocks.length : null,
    blocks
  };
}

export async function toolDeleteSubtitleBlocks(projectId, { block_ids: blockIds = [], orders = [] } = {}, context = {}) {
  const state = await loadProjectEditableState(projectId);
  const activeSentences = buildProjectSentenceUnits(buildActiveWordsWithOriginalIndices(state), 0.65);
  const idSet = new Set((Array.isArray(blockIds) ? blockIds : []).map((item) => String(item || '').trim()).filter(Boolean));
  const orderSet = new Set((Array.isArray(orders) ? orders : []).map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0));
  const targets = activeSentences.filter((sentence, index) => idSet.has(sentence.id) || orderSet.has(index + 1));

  if (!targets.length) {
    return {
      success: false,
      change: 'delete_subtitle_blocks',
      summary: '没有找到要删除的字幕块。'
    };
  }

  for (const target of targets) {
    for (let index = Number(target.original_word_start || 0); index <= Number(target.original_word_end || 0); index += 1) {
      state.keptMask[index] = false;
    }
  }

  const timeline = await persistEditableProjectState(projectId, state, {
    deletedGapKeys: state.editState?.deleted_gap_keys || [],
    audit: buildAgentEditHistoryContext('delete_subtitle_blocks', { block_ids: blockIds, orders }, context, `Agent 删除 ${targets.length} 个字幕块`)
  });

  return {
    success: true,
    changed: true,
    change: 'delete_subtitle_blocks',
    summary: `已删除 ${targets.length} 个字幕块。`,
    deleted_block_ids: targets.map((item) => item.id),
    timeline: {
      clip_count: (timeline?.clips || []).length,
      total_duration: timeline?.total_duration || 0
    }
  };
}

export async function toolRestoreSubtitleBlocks(projectId, { block_ids: blockIds = [], orders = [] } = {}, context = {}) {
  const state = await loadProjectEditableState(projectId);
  const allBlocks = buildRemovedSubtitleCandidates(state);
  const idSet = new Set((Array.isArray(blockIds) ? blockIds : []).map((item) => String(item || '').trim()).filter(Boolean));
  const orderSet = new Set((Array.isArray(orders) ? orders : []).map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0));
  const targets = allBlocks.filter((block, index) => idSet.has(block.id) || orderSet.has(index + 1));

  if (!targets.length) {
    return {
      success: false,
      change: 'restore_subtitle_blocks',
      summary: '没有找到要恢复的字幕块。'
    };
  }

  for (const target of targets) {
    for (let index = Number(target.original_word_start || 0); index <= Number(target.original_word_end || 0); index += 1) {
      state.keptMask[index] = true;
    }
  }

  const timeline = await persistEditableProjectState(projectId, state, {
    deletedGapKeys: state.editState?.deleted_gap_keys || [],
    audit: buildAgentEditHistoryContext('restore_subtitle_blocks', { block_ids: blockIds, orders }, context, `Agent 恢复 ${targets.length} 个字幕块`)
  });

  return {
    success: true,
    changed: true,
    change: 'restore_subtitle_blocks',
    summary: `已恢复 ${targets.length} 个字幕块。`,
    restored_block_ids: targets.map((item) => item.id),
    timeline: {
      clip_count: (timeline?.clips || []).length,
      total_duration: timeline?.total_duration || 0
    }
  };
}

export async function toolRemoveProjectAsset(projectId, { asset_id: assetId = '', asset_title: assetTitle = '' } = {}, context = {}) {
  const [beforeEditState, beforeTimeline] = await Promise.all([
    getProjectEditState(projectId),
    getProjectTimeline(projectId)
  ]);
  const project = await getProjectById(projectId);
  if (!project) throw new Error('Project not found');

  const target = (project.projectAssets || []).find((relation) => {
    if (assetId && relation.asset.id === assetId) return true;
    if (assetTitle && normalizeText(relation.asset.title).includes(normalizeText(assetTitle))) return true;
    return false;
  });

  if (!target) {
    return {
      success: false,
      change: 'remove_project_asset',
      summary: '没有找到要移除的素材。'
    };
  }

  await removeAssetFromProject(projectId, target.asset.id);
  const realigned = await realignProjectEditState(projectId);
  await recordProjectEditHistory({
    projectId,
    ...buildAgentEditHistoryContext('remove_project_asset', { asset_id: assetId, asset_title: assetTitle }, context, `Agent 删除素材 ${target.asset.title}`),
    beforeEditState,
    afterEditState: realigned.edit_state,
    beforeTimeline,
    afterTimeline: realigned.timeline
  });

  return {
    success: true,
    changed: true,
    change: 'remove_project_asset',
    summary: `已从项目中删除素材 ${target.asset.title}。`,
    asset_id: target.asset.id,
    asset_title: target.asset.title
  };
}

export async function toolReorderProjectAssets(projectId, { asset_titles: assetTitles = [], ordered_titles: orderedTitles = [] } = {}, context = {}) {
  const [beforeEditState, beforeTimeline] = await Promise.all([
    getProjectEditState(projectId),
    getProjectTimeline(projectId)
  ]);
  const project = await getProjectById(projectId);
  if (!project) throw new Error('Project not found');

  const requestedTitles = (orderedTitles.length ? orderedTitles : assetTitles).map(normalizeText).filter(Boolean);
  if (!requestedTitles.length) {
    return {
      success: false,
      change: 'reorder_project_assets',
      summary: '没有提供新的素材顺序。'
    };
  }

  const current = (project.projectAssets || []).map((relation) => relation.asset);
  const ordered = [];
  const used = new Set();

  for (const wanted of requestedTitles) {
    const hit = current.find((asset) => !used.has(asset.id) && normalizeText(asset.title).includes(wanted));
    if (hit) {
      ordered.push(hit.id);
      used.add(hit.id);
    }
  }

  current.forEach((asset) => {
    if (!used.has(asset.id)) {
      ordered.push(asset.id);
    }
  });

  await reorderProjectAssets(projectId, ordered);
  const realigned = await realignProjectEditState(projectId);
  await recordProjectEditHistory({
    projectId,
    ...buildAgentEditHistoryContext('reorder_project_assets', { asset_titles: assetTitles, ordered_titles: orderedTitles }, context, 'Agent 更新素材顺序'),
    beforeEditState,
    afterEditState: realigned.edit_state,
    beforeTimeline,
    afterTimeline: realigned.timeline
  });

  return {
    success: true,
    changed: true,
    change: 'reorder_project_assets',
    summary: '已更新项目素材顺序。',
    ordered_asset_ids: ordered
  };
}

export async function toolDeleteWordsByPhrase(projectId, { phrase = '', asset_title: assetTitle = '' } = {}, context = {}) {
  const state = await loadProjectEditableState(projectId);
  const strictAssemble = String(context?.requestContext?.mode || '') === 'assemble_script';
  const rawMatches = findPhraseMatches(state.words, state.keptMask, phrase, assetTitle);
  const matches = filterSafePhraseMatches(state.words, rawMatches, phrase, { strictAssemble });

  if (strictAssemble && rawMatches.length && !matches.length) {
    return {
      success: false,
      change: 'delete_words',
      summary: '这段短语不是可安全删除的独立口头禅/语气词。删整句、删半句或删重复表达时请改用 delete_subtitle_blocks。'
    };
  }

  if (!matches.length) {
    return {
      success: false,
      change: 'delete_words',
      summary: '没有找到可删除的字幕片段。'
    };
  }

  matches.forEach((match) => {
    for (let index = match.start; index <= match.end; index += 1) {
      state.keptMask[index] = false;
    }
  });

  const timeline = await persistEditableProjectState(projectId, state, {
    deletedGapKeys: state.editState?.deleted_gap_keys || [],
    audit: buildAgentEditHistoryContext('delete_words_by_phrase', { phrase, asset_title: assetTitle }, context, `Agent 删除短语“${phrase}”`)
  });

  return {
    success: true,
    changed: true,
    change: 'delete_words',
    summary: `已删除 ${matches.length} 处字幕片段。`,
    deleted_match_count: matches.length,
    timeline
  };
}

export async function toolReplaceSubtitleText(
  projectId,
  { find_text: findText = '', replacement_text: replacementText = '', asset_title: assetTitle = '' } = {},
  context = {}
) {
  const state = await loadProjectEditableState(projectId);
  const matches = findPhraseMatches(state.words, state.keptMask.map(() => true), findText, assetTitle);

  if (!matches.length) {
    return {
      success: false,
      change: 'replace_subtitle_text',
      summary: '没有找到要替换的字幕文本。'
    };
  }

  const grouped = new Map();
  for (const match of matches) {
    const startWord = state.words[match.start];
    const endWord = state.words[match.end];
    if (!startWord || !endWord || startWord.asset_id !== endWord.asset_id) {
      continue;
    }
    const list = grouped.get(startWord.asset_id) || [];
    list.push({
      start: startWord.asset_word_index,
      end: endWord.asset_word_index
    });
    grouped.set(startWord.asset_id, list);
  }

  const replacementTokens = tokenizeSegmentText(replacementText);
  if (!replacementTokens.length) {
    return {
      success: false,
      change: 'replace_subtitle_text',
      summary: '替换后的字幕文本不能为空。'
    };
  }

  const incomingReplacements = [...grouped.entries()].flatMap(([assetId, spans]) => (
    spans.map((span) => ({
      assetId,
      startWordIndex: span.start,
      endWordIndex: span.end,
      replacementText
    }))
  ));

  const { timeline, edit_state: nextEditState } = await saveProjectEditState(projectId, {
    deletedWordKeys: state.editState?.deleted_word_keys || [],
    deletedGapKeys: state.editState?.deleted_gap_keys || [],
    textReplacements: mergeProjectTextReplacements(state.editState?.text_replacements || [], incomingReplacements),
    ...buildAgentEditHistoryContext('replace_subtitle_text', { find_text: findText, replacement_text: replacementText, asset_title: assetTitle }, context, `Agent 替换字幕“${findText}”`)
  });

  const persistedReplacements = Array.isArray(nextEditState?.text_replacements) ? nextEditState.text_replacements : [];
  const convertedToDeletedState = incomingReplacements.every((candidate) => (
    !persistedReplacements.some((item) => (
      item.assetId === candidate.assetId &&
      Number(item.startWordIndex) === Number(candidate.startWordIndex) &&
      Number(item.endWordIndex) === Number(candidate.endWordIndex) &&
      String(item.replacementText || '') === String(candidate.replacementText || '')
    ))
  ));

  return {
    success: true,
    changed: true,
    change: 'replace_subtitle_text',
    summary: convertedToDeletedState
      ? `已将 ${matches.length} 处“伪改字剪辑”转换为划线删除态。`
      : `已将 ${matches.length} 处字幕改写为“${replacementText}”。`,
    replacement_text: replacementText,
    replaced_match_count: matches.length,
    converted_to_deleted_state: convertedToDeletedState,
    timeline
  };
}

export async function toolRestoreWordsByPhrase(projectId, { phrase = '', asset_title: assetTitle = '' } = {}, context = {}) {
  const state = await loadProjectEditableState(projectId);
  const matches = findDeletedPhraseMatches(state.words, state.keptMask, phrase, assetTitle);

  if (!matches.length) {
    return {
      success: false,
      change: 'restore_words',
      summary: '没有找到可恢复的字幕片段。'
    };
  }

  matches.forEach((match) => {
    for (let index = match.start; index <= match.end; index += 1) {
      state.keptMask[index] = true;
    }
  });

  const timeline = await persistEditableProjectState(projectId, state, {
    deletedGapKeys: state.editState?.deleted_gap_keys || [],
    audit: buildAgentEditHistoryContext('restore_words_by_phrase', { phrase, asset_title: assetTitle }, context, `Agent 恢复短语“${phrase}”`)
  });

  return {
    success: true,
    changed: true,
    change: 'restore_words',
    summary: `已恢复 ${matches.length} 处字幕片段。`,
    restored_match_count: matches.length,
    timeline
  };
}

export async function toolClearDeleted(projectId, _args = {}, context = {}) {
  const state = await loadProjectEditableState(projectId);
  const result = await saveProjectEditState(projectId, {
    assetOrder: state.editState?.asset_order || [],
    deletedWordKeys: [],
    deletedGapKeys: [],
    textReplacements: state.editState?.text_replacements || [],
    ...buildAgentEditHistoryContext('clear_deleted', {}, context, 'Agent 清空当前删减')
  });
  const updatedTimeline = result.timeline;

  return {
    success: true,
    changed: true,
    change: 'clear_deleted',
    summary: '已恢复整条项目时间线到完整素材状态。',
    timeline: updatedTimeline
  };
}

export async function toolRemovePauses(
  projectId,
  {
    min_gap_seconds: minGapSeconds = 0.4,
    gap_keys: gapKeys = [],
    asset_title: assetTitle = '',
    limit = null
  } = {},
  context = {}
) {
  const state = await loadProjectEditableState(projectId);
  const deletedGapKeys = new Set(state.editState?.deleted_gap_keys || []);
  const strictAssemble = String(context?.requestContext?.mode || '') === 'assemble_script';

  const requestedGapKeys = (Array.isArray(gapKeys) ? gapKeys : []).map((value) => String(value || '').trim()).filter(Boolean);
  if (strictAssemble && !requestedGapKeys.length) {
    const suggestedCandidates = buildPauseCandidates(state, {
      minGapSeconds: Number(minGapSeconds || 0.35),
      assetTitle,
      limit: 8
    });
    return {
      success: false,
      changed: false,
      change: 'remove_pauses',
      summary: '口播拼稿模式下不要直接按阈值整批扫停顿。请先调用 get_pause_candidates / get_assemble_candidates，挑具体 gap_keys 后再定点删除。',
      deleted_gap_count: 0,
      removed_seconds: 0,
      suggested_gap_keys: suggestedCandidates.filter((candidate) => candidate.recommended).map((candidate) => candidate.gap_key),
      suggested_candidates: suggestedCandidates.slice(0, 8)
    };
  }
  const requestedGapKeySet = new Set(requestedGapKeys);
  const selectedCandidates = buildPauseCandidates(state, {
    minGapSeconds: requestedGapKeys.length ? 0 : Number(minGapSeconds || 0.4),
    assetTitle,
    limit: requestedGapKeys.length
      ? Math.max(1, requestedGapKeys.length)
      : (limit == null ? null : Math.min(200, Math.max(1, Number(limit || 1)))),
    gapKeys: []
  }).filter((candidate) => (
    (!requestedGapKeys.length || requestedGapKeySet.has(candidate.gap_key) || requestedGapKeySet.has(buildPauseCandidateAlias(candidate))) &&
    (!requestedGapKeys.length || Number(candidate.gap_seconds || 0) >= Number(minGapSeconds || 0.4))
  ));

  if (!selectedCandidates.length) {
    return {
      success: false,
      changed: false,
      change: 'remove_pauses',
      summary: '没有找到符合条件的明显停顿。',
      deleted_gap_count: 0,
      removed_seconds: 0
    };
  }

  let removedSeconds = 0;
  for (const candidate of selectedCandidates) {
    deletedGapKeys.add(String(candidate.gap_key || ''));
    removedSeconds += Number(candidate.gap_seconds || 0);
  }

  const timeline = await persistEditableProjectState(projectId, state, {
    deletedGapKeys: [...deletedGapKeys].filter(Boolean),
    audit: buildAgentEditHistoryContext(
      'remove_pauses',
      {
        min_gap_seconds: minGapSeconds,
        gap_keys: requestedGapKeys,
        asset_title: assetTitle
      },
      context,
      `Agent 清理停顿阈值 ${Number(minGapSeconds || 0.4).toFixed(1)} 秒`
    )
  });

  return {
    success: true,
    changed: true,
    change: 'remove_pauses',
    summary: `已切掉 ${selectedCandidates.length} 个停顿，总计约 ${removedSeconds.toFixed(1)} 秒。`,
    targeted: requestedGapKeys.length > 0,
    requested_gap_key_count: requestedGapKeys.length,
    deleted_gap_count: selectedCandidates.length,
    deleted_gap_keys: selectedCandidates.map((candidate) => candidate.gap_key),
    removed_seconds: roundTime(removedSeconds),
    timeline
  };
}

export async function toolListProjectSlices(projectId) {
  const slices = await listProjectSlices(projectId);
  return {
    success: true,
    change: 'list_project_slices',
    summary: slices.length ? `当前共有 ${slices.length} 个直播切片。` : '当前还没有直播切片。',
    slice_count: slices.length,
    slices
  };
}

export async function toolSuggestProjectSlices(
  projectId,
  {
    query = '',
    count = 4,
    min_duration = 20,
    max_duration = 75
  } = {}
) {
  const result = await suggestProjectSlices(projectId, {
    query,
    count,
    min_duration,
    max_duration,
    create: false
  });
  const suggestions = Array.isArray(result?.suggestions) ? result.suggestions : [];
  return {
    success: true,
    changed: false,
    change: 'suggest_project_slices',
    summary: suggestions.length
      ? `已给出 ${suggestions.length} 个切片候选。`
      : '当前没有找到合适的切片候选。',
    suggestion_count: suggestions.length,
    suggestions
  };
}

export async function toolGetProjectSliceDetail(projectId, { slice_id: sliceId = '' } = {}) {
  const targetId = String(sliceId || '').trim();
  if (!targetId) {
    return {
      success: false,
      change: 'get_project_slice_detail',
      summary: 'slice_id 不能为空。'
    };
  }
  const slice = await getProjectSlice(projectId, targetId);
  return {
    success: true,
    change: 'get_project_slice_detail',
    summary: `已读取切片《${slice.title}》，当前时长 ${formatDuration(slice.total_duration || 0)}。`,
    slice
  };
}

export async function toolCreateProjectSlice(
  projectId,
  {
    title = '',
    summary = '',
    query = '',
    target_duration_seconds = 0,
    ranges = []
  } = {}
) {
  const slice = await createProjectSlice(projectId, {
    title,
    summary,
    query,
    target_duration_seconds,
    ranges
  });
  return {
    success: true,
    changed: true,
    mutates_project: true,
    change: 'create_project_slice',
    summary: `已创建切片《${slice.title}》，时长 ${formatDuration(slice.total_duration || 0)}。`,
    slice_id: slice.id,
    slice_title: slice.title,
    slice
  };
}

export async function toolDeleteProjectSlice(projectId, { slice_id: sliceId = '' } = {}) {
  const targetId = String(sliceId || '').trim();
  if (!targetId) {
    return {
      success: false,
      change: 'delete_project_slice',
      summary: 'slice_id 不能为空。'
    };
  }
  const removed = await deleteProjectSlice(projectId, targetId);
  return {
    success: true,
    changed: true,
    mutates_project: true,
    change: 'delete_project_slice',
    summary: `已删除切片《${removed.title}》。`,
    slice_id: removed.id,
    slice_title: removed.title
  };
}

export async function toolSaveSnapshot(projectId, { note = 'Agent snapshot' } = {}) {
  const snapshot = await createTimelineSnapshot(projectId, {
    source: 'agent',
    note
  });

  return {
    success: true,
    changed: true,
    change: 'save_snapshot',
    summary: '已保存时间线快照。',
    snapshot_id: snapshot.id
  };
}

export async function toolExportVideo(projectId) {
  const result = await exportProjectTimelineVideo(projectId);
  return {
    success: true,
    change: 'export_video',
    summary: '已触发项目视频导出。',
    output_path: result.outputPath
  };
}

export async function toolExportPackage(projectId) {
  const result = await exportProjectPackage(projectId, {});
  return {
    success: true,
    change: 'export_project_package',
    summary: '已生成项目工程包。',
    zip_path: result.zipPath
  };
}

export async function toolGetProjectContext(projectId) {
  const state = await loadProjectEditableState(projectId);
  const currentTimeline = state.currentTimeline || state.timeline || (await getProjectTimeline(projectId));
  const currentCutDurationSeconds = Number(currentTimeline?.clips?.reduce((sum, clip) => sum + Number(clip.duration || 0), 0) || 0);
  const orderedProjectAssets = orderProjectAssetsForBaseline(state.project.projectAssets || [], currentTimeline);
  const activeAssetSequence = (currentTimeline?.clips || [])
    .map((clip) => String(clip.asset_title || '').trim())
    .filter(Boolean)
    .filter((title, index, list) => index === 0 || list[index - 1] !== title);
  const deletedWordCount = Array.isArray(state.editState?.deleted_word_keys) ? state.editState.deleted_word_keys.length : 0;
  const deletedGapCount = Array.isArray(state.editState?.deleted_gap_keys) ? state.editState.deleted_gap_keys.length : 0;
  return {
    success: true,
    change: 'get_project_context',
    summary: `当前项目《${state.project.name}》共有 ${state.project.projectAssets.length} 个素材，当前时间线 ${currentTimeline?.clips?.length || 0} 个片段，当前成片时长 ${formatDuration(currentCutDurationSeconds)}，当前保留 ${state.keptMask.filter(Boolean).length}/${state.words.length} 个字，已删 ${deletedWordCount} 个字和 ${deletedGapCount} 个停顿。当前成片素材顺序：${activeAssetSequence.join(' → ') || '无'}`,
    project_name: state.project.name,
    project_description: state.project.description || '',
    asset_count: state.project.projectAssets.length,
    clip_count: currentTimeline?.clips?.length || 0,
    kept_word_count: state.keptMask.filter(Boolean).length,
    total_word_count: state.words.length,
    deleted_word_count: deletedWordCount,
    deleted_gap_count: deletedGapCount,
    total_duration: formatDuration(currentCutDurationSeconds),
    current_cut_duration: formatDuration(currentCutDurationSeconds),
    current_cut_duration_seconds: roundTime(currentCutDurationSeconds),
    active_asset_sequence: activeAssetSequence,
    assets: orderedProjectAssets.map((relation) => ({
      id: relation.asset.id,
      title: relation.asset.title,
      duration_seconds: relation.asset.duration_seconds
    }))
  };
}
