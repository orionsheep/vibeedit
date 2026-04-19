import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeAsciiFilename } from '../server/services/shared/text-utils.js';
import { normalizeTimelineSettings, readTimelineKind, roundTime } from '../server/services/shared/timeline-utils.js';

test('sanitizeAsciiFilename falls back to ascii-safe slug names', () => {
  assert.equal(sanitizeAsciiFilename('课前回顾：基础方法论', 'slice_01'), 'slice_01');
  assert.equal(sanitizeAsciiFilename('Heading 选项中的抽象名词规律', 'slice_02'), 'Heading');
  assert.equal(sanitizeAsciiFilename('  A/B Test  ', 'fallback'), 'AB_Test');
});

test('timeline helpers normalize settings and preserve slice kind', () => {
  assert.deepEqual(normalizeTimelineSettings(null), {});
  assert.equal(readTimelineKind({ isPrimary: true }), 'master');
  assert.equal(readTimelineKind({ settings: { kind: 'slice' } }), 'slice');
  assert.equal(readTimelineKind({ settings: [] }), 'aux');
  assert.equal(roundTime(3.14159), 3.142);
});
