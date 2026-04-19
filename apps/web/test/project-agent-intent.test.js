import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProjectAgentRequest } from '../server/services/agent/project-agent-intent.service.js';

test('assemble_script mode falls back to custom for general conversation', () => {
  const result = classifyProjectAgentRequest({
    mode: 'assemble_script',
    prompt: '什么是 Claude Code？一句话解释一下。'
  });

  assert.equal(result.effectiveMode, 'custom');
  assert.equal(result.requiresMutation, false);
  assert.equal(result.generalConversation, true);
});

test('live_slicing intent stays in slicing mode for candidate generation request', () => {
  const result = classifyProjectAgentRequest({
    mode: 'custom',
    prompt: '先分析全文，给我 4 个候选切片，每条控制在 30-50 秒。'
  });

  assert.equal(result.effectiveMode, 'live_slicing');
  assert.equal(result.requiresToolUse, true);
});

test('read-only transcript request does not require mutation', () => {
  const result = classifyProjectAgentRequest({
    mode: 'assemble_script',
    prompt: '把这个视频最后的逐字稿输出给我，剪辑之后的最终版本。'
  });

  assert.equal(result.explicitReadOnlyProjectQuery, true);
  assert.equal(result.requiresMutation, false);
});
