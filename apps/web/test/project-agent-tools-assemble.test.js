import test from 'node:test';
import assert from 'node:assert/strict';
import { planConservativeAssemblePass } from '../server/services/agent/project-agent-tools.service.js';

test('planConservativeAssemblePass keeps the best duplicate version and selects recommended pauses', () => {
  const result = planConservativeAssemblePass({
    takeGroups: [
      {
        id: 'take_group_1',
        versions: [
          {
            id: 'take_a',
            text: '这是一段更完整的产品介绍内容。',
            start: 0,
            end: 12,
            duration: 12,
            sentence_ids: ['s1', 's2'],
            filler_hits: 0,
            pause_seconds: 0.2,
            long_pause_count: 0
          },
          {
            id: 'take_b',
            text: '这是一段产品介绍内容。',
            start: 20,
            end: 28,
            duration: 8,
            sentence_ids: ['s3', 's4'],
            filler_hits: 2,
            pause_seconds: 1.5,
            long_pause_count: 1
          }
        ]
      }
    ],
    blockGroups: [
      {
        id: 'block_group_1',
        versions: [
          {
            id: 'block_keep',
            text: '这一整段解释更完整，包含完整的使用流程和结论。',
            start: 60,
            end: 74,
            duration: 14,
            sentence_ids: ['b1', 'b2', 'b3'],
            sentence_count: 3,
            filler_hits: 0,
            pause_seconds: 0.4,
            long_pause_count: 0
          },
          {
            id: 'block_drop',
            text: '这一整段解释更完整，包含完整的使用流程。',
            start: 82,
            end: 94,
            duration: 12,
            sentence_ids: ['b4', 'b5'],
            sentence_count: 2,
            filler_hits: 1,
            pause_seconds: 1.2,
            long_pause_count: 1
          }
        ]
      }
    ],
    sentenceGroups: [
      {
        id: 'sentence_group_1',
        versions: [
          {
            id: 'sent_keep',
            text: '这个产品可以自动整理长视频内容。',
            start: 40,
            end: 43,
            duration: 3
          },
          {
            id: 'sent_drop',
            text: '这个产品可以自动整理长视频内容。',
            start: 50,
            end: 53,
            duration: 3
          }
        ]
      }
    ],
    pauseCandidates: [
      {
        gap_key: 'gap_1',
        gap_seconds: 0.8,
        recommended: true,
        safety_level: 'high'
      },
      {
        gap_key: 'gap_2',
        gap_seconds: 0.5,
        recommended: false,
        safety_level: 'medium'
      }
    ],
    restartCandidates: [
      {
        id: 'restart_1',
        sentence_ids: ['restart_drop']
      }
    ]
  });

  assert.deepEqual(result.deleted_take_version_ids, ['take_b']);
  assert.deepEqual(result.deleted_block_version_ids, ['block_drop']);
  assert.ok(result.sentence_ids_to_delete.includes('s3'));
  assert.ok(result.sentence_ids_to_delete.includes('s4'));
  assert.ok(result.sentence_ids_to_delete.includes('b4'));
  assert.ok(result.sentence_ids_to_delete.includes('b5'));
  assert.ok(result.deleted_sentence_version_ids.includes('sent_drop'));
  assert.ok(result.deleted_restart_sentence_ids.includes('restart_drop'));
  assert.deepEqual(result.pause_gap_keys, ['gap_1']);
  assert.equal(result.removed_pause_seconds, 0.8);
});
