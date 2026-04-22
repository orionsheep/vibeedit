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

test('project agent exposes deterministic conservative assemble tool', () => {
  assert.ok(TOOL_DEFINITIONS.auto_assemble_script);
  assert.equal(TOOL_DEFINITIONS.auto_assemble_script.mutatesProject, true);
  assert.match(
    String(TOOL_DEFINITIONS.auto_assemble_script.description || ''),
    /保守的口播拼稿/
  );
});

test('project agent exposes multi-asset script map reader', () => {
  assert.ok(TOOL_DEFINITIONS.get_asset_script_map);
  assert.equal(TOOL_DEFINITIONS.get_asset_script_map.mutatesProject, false);
  assert.match(
    String(TOOL_DEFINITIONS.get_asset_script_map.description || ''),
    /多素材口播拼稿/
  );
});
