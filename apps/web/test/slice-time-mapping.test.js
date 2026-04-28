import test from 'node:test';
import assert from 'node:assert/strict';
import {
  displayTimeToOriginalTime,
  normalizeSliceDisplayRanges,
  originalTimeToDisplayTime,
  remapWordsToSliceDisplayTimeline
} from '../src/features/workspace/utils/sliceTimeMapping.js';

test('slice display ranges remap separated source ranges to a compact timeline', () => {
  const ranges = normalizeSliceDisplayRanges([
    { start: 60, end: 70 },
    { start: 120, end: 135 }
  ]);

  assert.deepEqual(ranges.map((range) => [range.start, range.end, range.display_start, range.display_end]), [
    [60, 70, 0, 10],
    [120, 135, 10, 25]
  ]);
  assert.equal(originalTimeToDisplayTime(125, ranges), 15);
  assert.equal(displayTimeToOriginalTime(15, ranges), 125);
});

test('slice word stream only keeps words inside selected slice ranges', () => {
  const ranges = normalizeSliceDisplayRanges([
    { start: 10, end: 20 },
    { start: 40, end: 50 }
  ]);
  const result = remapWordsToSliceDisplayTimeline([
    { id: 'a', word_key: 'a', text: '前', start_time: 8, end_time: 9 },
    { id: 'b', word_key: 'b', text: '中', start_time: 12, end_time: 13 },
    { id: 'c', word_key: 'c', text: '后', start_time: 45, end_time: 46 }
  ], ranges);

  assert.equal(result.duration, 20);
  assert.deepEqual(result.words.map((word) => [word.word_key, word.start_time, word.end_time, word.original_start_time]), [
    ['b', 2, 3, 12],
    ['c', 15, 16, 45]
  ]);
  assert.equal(result.words.every((word) => word.slice_display), true);
});
