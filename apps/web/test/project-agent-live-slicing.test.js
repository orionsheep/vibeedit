import test from 'node:test';
import assert from 'node:assert/strict';
import {
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
});
