import { formatDuration, roundTime } from './rangeMath.js';

export function buildTranscriptBlocksFromEditorWords(words = [], {
  deletedWords = new Set(),
  deletedGaps = new Set(),
  hardGapThreshold = 1.1,
  maxBlockChars = 90
} = {}) {
  const sourceWords = Array.isArray(words) ? words : [];
  const blocks = [];
  let current = null;
  let lastKeptIndex = -1;

  const pushCurrent = () => {
    if (!current || !String(current.text || '').trim()) return;
    blocks.push({
      id: `doc_block_${blocks.length + 1}`,
      start: roundTime(current.start),
      end: roundTime(current.end),
      text: current.text
    });
    current = null;
  };

  for (let index = 0; index < sourceWords.length; index += 1) {
    if (deletedWords.has(index)) continue;
    const word = sourceWords[index];
    const previousWord = lastKeptIndex >= 0 ? sourceWords[lastKeptIndex] : null;
    const gapDuration = previousWord
      ? Number(word.start_time || 0) - Number(previousWord.end_time || previousWord.start_time || 0)
      : 0;
    const shouldBreak = Boolean(
      current && (
        deletedGaps.has(lastKeptIndex) ||
        gapDuration >= hardGapThreshold ||
        (/[。！？!?；;]$/.test(String(previousWord?.text || '')) && current.text.length >= 20) ||
        current.text.length >= maxBlockChars
      )
    );

    if (!current || shouldBreak) {
      pushCurrent();
      current = {
        start: Number(word.start_time || 0),
        end: Number(word.end_time || word.start_time || 0),
        text: ''
      };
    }

    current.text += String(word.text || '');
    current.end = Number(word.end_time || word.start_time || current.end);
    lastKeptIndex = index;
  }

  pushCurrent();
  return blocks;
}

export function normalizeDocumentBlocks(blocks = []) {
  return (Array.isArray(blocks) ? blocks : [])
    .map((block, index) => ({
      id: block.id || `doc_block_${index + 1}`,
      start: Number(block.start || 0),
      end: Number(block.end || block.start || 0),
      text: String(block.text || '').trim()
    }))
    .filter((block) => block.text);
}

export function buildDocumentParagraphs(blocks = [], {
  minParagraphChars = 120,
  maxParagraphChars = 260
} = {}) {
  const normalized = normalizeDocumentBlocks(blocks);
  if (!normalized.length) return [];

  const paragraphs = [];
  let current = '';

  const pushCurrent = () => {
    const text = String(current || '').trim();
    if (!text) return;
    paragraphs.push(text);
    current = '';
  };

  for (const block of normalized) {
    const text = String(block.text || '').trim();
    if (!text) continue;
    const candidate = current ? `${current}${text}` : text;
    const shouldBreak = Boolean(
      current && (
        current.length >= maxParagraphChars ||
        (current.length >= minParagraphChars && /[。！？!?；;]$/.test(current))
      )
    );

    if (shouldBreak) {
      pushCurrent();
      current = text;
      continue;
    }

    current = candidate;
  }

  pushCurrent();
  return paragraphs;
}

export function formatRangeLabel(start, end) {
  return `${formatDuration(start)} - ${formatDuration(end)}`;
}
