import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildArchivedLiveSlicingSlices,
  buildDeterministicLiveSlicingArgs,
  isCandidateOnlyLiveSlicingRequest,
  shouldUseDeterministicLiveSlicing
} from '../server/services/agent/project-agent.service.js';

test('generic execute live slicing request uses deterministic creation flow', () => {
  assert.equal(shouldUseDeterministicLiveSlicing({
    mode: 'live_slicing',
    prompt: '执行 直播切片',
    requestProfile: {
      effectiveMode: 'live_slicing'
    }
  }), true);

  assert.equal(shouldUseDeterministicLiveSlicing({
    mode: 'live_slicing',
    prompt: '我现在需要重新切片这个视频，请你把这个视频切片成7',
    requestProfile: {
      effectiveMode: 'live_slicing'
    }
  }), true);
});

test('candidate-only live slicing request does not auto-create slices', () => {
  const request = {
    prompt: '先分析全文，给我 4 个候选切片，每条控制在 30-50 秒。'
  };

  assert.equal(isCandidateOnlyLiveSlicingRequest(request), true);
  assert.equal(shouldUseDeterministicLiveSlicing({
    mode: 'live_slicing',
    ...request,
    requestProfile: {
      effectiveMode: 'live_slicing'
    }
  }), false);
});

test('deterministic live slicing args parse count and target duration', () => {
  const args = buildDeterministicLiveSlicingArgs({
    prompt: '帮我切 3 条短视频',
    targetMinutes: 1.5
  });

  assert.equal(args.count, 3);
  assert.equal(args.max_duration, 90);
  assert.ok(args.min_duration >= 12);
  assert.ok(args.min_duration < args.max_duration);

  assert.equal(buildDeterministicLiveSlicingArgs({
    prompt: '我现在需要重新切片这个视频，请你把这个视频切片成7'
  }).count, 7);
  assert.equal(buildDeterministicLiveSlicingArgs({
    prompt: '拆成七段'
  }).count, 7);
});

test('deterministic live slicing archives all existing slices before replacement', () => {
  const archived = buildArchivedLiveSlicingSlices([
    {
      id: 'manual-1',
      title: '雅思阅读四大逻辑与对比段落入门',
      generated_by: 'manual',
      total_duration: 97.1234,
      ranges: [{ start: 670, end: 767 }]
    },
    {
      id: 'auto-1',
      title: '切片 1 · 内容开头',
      generated_by: 'deterministic_live_slicing',
      clips: [{
        id: 'clip-1',
        asset_id: 'asset-1',
        source_start: 10,
        source_end: 20,
        timeline_start: 0,
        timeline_end: 10,
        original_project_start: 100,
        original_project_end: 110
      }]
    }
  ]);

  assert.equal(archived.length, 2);
  assert.deepEqual(archived.map((slice) => slice.id), ['manual-1', 'auto-1']);
  assert.equal(archived[0].total_duration, 97.123);
  assert.deepEqual(archived[1].ranges, [{ start: 100, end: 110 }]);
});
