import { mergeRanges, roundTime } from './rangeMath.js';

export function normalizeSliceDisplayRanges(ranges = [], { merge = true } = {}) {
  let cursor = 0;
  const sourceRanges = merge ? mergeRanges(ranges) : (Array.isArray(ranges) ? ranges : []);
  return sourceRanges.map((range) => {
    const start = roundTime(Number(range.start || 0));
    const end = roundTime(Number(range.end || start));
    const duration = Math.max(0, end - start);
    const mapped = {
      ...range,
      start,
      end,
      display_start: roundTime(cursor),
      display_end: roundTime(cursor + duration),
      duration: roundTime(duration)
    };
    cursor += duration;
    return mapped;
  }).filter((range) => range.duration > 0.001);
}

export function originalTimeToDisplayTime(originalTime = 0, displayRanges = []) {
  const target = Number(originalTime || 0);
  if (!displayRanges.length) return roundTime(Math.max(0, target));

  for (let index = 0; index < displayRanges.length; index += 1) {
    const range = displayRanges[index];
    if (target <= Number(range.start || 0)) {
      return roundTime(Number(range.display_start || 0));
    }
    if (target < Number(range.end || 0) || index === displayRanges.length - 1) {
      const offset = Math.max(0, Math.min(Number(range.duration || 0), target - Number(range.start || 0)));
      return roundTime(Number(range.display_start || 0) + offset);
    }
  }

  return roundTime(Number(displayRanges[displayRanges.length - 1]?.display_end || 0));
}

export function displayTimeToOriginalTime(displayTime = 0, displayRanges = []) {
  const target = Number(displayTime || 0);
  if (!displayRanges.length) return roundTime(Math.max(0, target));

  for (let index = 0; index < displayRanges.length; index += 1) {
    const range = displayRanges[index];
    if (target <= Number(range.display_start || 0)) {
      return roundTime(Number(range.start || 0));
    }
    if (target < Number(range.display_end || 0) || index === displayRanges.length - 1) {
      const offset = Math.max(0, Math.min(Number(range.duration || 0), target - Number(range.display_start || 0)));
      return roundTime(Number(range.start || 0) + offset);
    }
  }

  return roundTime(Number(displayRanges[displayRanges.length - 1]?.end || 0));
}

export function remapWordsToSliceDisplayTimeline(words = [], displayRanges = []) {
  if (!displayRanges.length) {
    return {
      words: Array.isArray(words) ? words : [],
      duration: 0
    };
  }

  const mappedWords = [];
  for (const word of (Array.isArray(words) ? words : [])) {
    const originalStart = Number(word?.start_time || 0);
    const originalEnd = Math.max(originalStart + 0.01, Number(word?.end_time || originalStart + 0.01));
    for (const range of displayRanges) {
      const overlapStart = Math.max(originalStart, Number(range.start || 0));
      const overlapEnd = Math.min(originalEnd, Number(range.end || 0));
      if (overlapEnd - overlapStart <= 0.001) continue;
      const displayStart = roundTime(Number(range.display_start || 0) + (overlapStart - Number(range.start || 0)));
      const displayEnd = roundTime(Number(range.display_start || 0) + (overlapEnd - Number(range.start || 0)));
      mappedWords.push({
        ...word,
        id: `${word.id || word.word_key || 'word'}:slice:${displayStart}:${displayEnd}`,
        start_time: displayStart,
        end_time: displayEnd,
        original_start_time: roundTime(overlapStart),
        original_end_time: roundTime(overlapEnd),
        slice_display: true,
        slice_active: typeof word.slice_active === 'boolean' ? word.slice_active : true
      });
    }
  }

  mappedWords.sort((left, right) => Number(left.start_time || 0) - Number(right.start_time || 0));

  return {
    words: mappedWords,
    duration: roundTime(Number(displayRanges[displayRanges.length - 1]?.display_end || 0))
  };
}
