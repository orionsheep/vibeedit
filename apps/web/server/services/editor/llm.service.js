import { loadConfig } from './config.js';
import {
  getGlmClaudeSettings,
  listGlmCandidateHealth,
  PROJECT_AGENT_MODEL,
  PROJECT_AGENT_PROVIDER
} from '../agent/glm-claude-rotation.service.js';

export function getAgentLlmSettings() {
  const config = loadConfig();
  const glm = getGlmClaudeSettings();
  return {
    provider: PROJECT_AGENT_PROVIDER,
    model: PROJECT_AGENT_MODEL,
    models: [PROJECT_AGENT_MODEL],
    runtimeDir: glm.runtimeDir,
    baseUrl: glm.baseUrl,
    timeoutMs: Number(config.agent_llm_timeout_ms || 90000),
    keyHealth: listGlmCandidateHealth()
  };
}
