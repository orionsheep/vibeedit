export function roundTime(value) {
  return Number(Number(value || 0).toFixed(3));
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function formatDuration(seconds) {
  const safe = Number(seconds || 0);
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function mergeRanges(ranges = []) {
  const normalized = (Array.isArray(ranges) ? ranges : [])
    .map((range) => ({
      start: roundTime(Number(range?.start || 0)),
      end: roundTime(Number(range?.end || 0))
    }))
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end - range.start > 0.05)
    .sort((left, right) => left.start - right.start);

  if (!normalized.length) return [];

  const merged = [normalized[0]];
  for (let index = 1; index < normalized.length; index += 1) {
    const current = normalized[index];
    const previous = merged[merged.length - 1];
    if (current.start <= previous.end + 0.05) {
      previous.end = roundTime(Math.max(previous.end, current.end));
      continue;
    }
    merged.push({ ...current });
  }

  return merged;
}

export function subtractRanges(baseRanges = [], removeRanges = []) {
  const source = mergeRanges(baseRanges);
  const cuts = mergeRanges(removeRanges);
  if (!source.length || !cuts.length) return source;

  const result = [];
  for (const base of source) {
    let fragments = [{ ...base }];
    for (const cut of cuts) {
      const nextFragments = [];
      for (const fragment of fragments) {
        const overlapStart = Math.max(fragment.start, cut.start);
        const overlapEnd = Math.min(fragment.end, cut.end);
        if (overlapEnd - overlapStart <= 0.001) {
          nextFragments.push(fragment);
          continue;
        }
        if (overlapStart - fragment.start > 0.05) {
          nextFragments.push({
            start: fragment.start,
            end: roundTime(overlapStart)
          });
        }
        if (fragment.end - overlapEnd > 0.05) {
          nextFragments.push({
            start: roundTime(overlapEnd),
            end: fragment.end
          });
        }
      }
      fragments = nextFragments;
      if (!fragments.length) break;
    }
    result.push(...fragments);
  }

  return mergeRanges(result);
}
