import { loadConfig } from './config.js';
import {
  getGlmClaudeSettings,
  getProjectAgentModel,
  getProjectAgentProvider,
  listGlmCandidateHealth,
} from '../agent/glm-claude-rotation.service.js';

export function getAgentLlmSettings() {
  const config = loadConfig();
  const glm = getGlmClaudeSettings();
  return {
    provider: getProjectAgentProvider(config),
    model: getProjectAgentModel(config),
    models: [getProjectAgentModel(config)],
    runtimeDir: glm.runtimeDir,
    baseUrl: glm.baseUrl,
    timeoutMs: Number(config.agent_llm_timeout_ms || 90000),
    keyHealth: listGlmCandidateHealth()
  };
}
