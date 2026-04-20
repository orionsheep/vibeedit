import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_DEFINITIONS } from '../server/services/agent/claude-agent-mcp.service.js';

test('project agent exposes deterministic all-pause cleanup tool', () => {
  assert.ok(TOOL_DEFINITIONS.remove_all_pauses);
  assert.equal(TOOL_DEFINITIONS.remove_all_pauses.mutatesProject, true);
  assert.match(
    String(TOOL_DEFINITIONS.remove_all_pauses.description || ''),
    /一键去除当前项目里所有可删停顿/
  );
});
