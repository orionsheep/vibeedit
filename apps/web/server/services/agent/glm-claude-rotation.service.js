import crypto from 'crypto';
import { loadConfig, getProjectRoot } from '../editor/config.js';

export const DEFAULT_PROJECT_AGENT_PROVIDER = 'siliconflow_claude_sdk';
export const DEFAULT_PROJECT_AGENT_MODEL = 'Pro/zai-org/GLM-5.1';

const healthMap = new Map();
let roundRobinIndex = 0;

function hashKey(value = '') {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 10);
}

function getRuntimeDir(config = loadConfig()) {
  return config.claude_runtime_dir || `${getProjectRoot()}/.autoedit/claude-runtime`;
}

export function getProjectAgentProvider(config = loadConfig()) {
  return String(config.agent_llm_provider || DEFAULT_PROJECT_AGENT_PROVIDER).trim() || DEFAULT_PROJECT_AGENT_PROVIDER;
}

export function getProjectAgentModel(config = loadConfig()) {
  return String(
    config.agent_llm_siliconflow_model ||
    config.agent_llm_model ||
    DEFAULT_PROJECT_AGENT_MODEL
  ).trim() || DEFAULT_PROJECT_AGENT_MODEL;
}

function buildProviderRuntimeDir(baseDir) {
  return `${baseDir}/siliconflow`;
}

function uniqueValues(values = []) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

export function getGlmClaudeSettings() {
  const config = loadConfig();
  const disabledKeyHashes = Array.isArray(config.agent_llm_disabled_key_hashes)
    ? config.agent_llm_disabled_key_hashes.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const keys = resolveGlmClaudeKeys(config);

  return {
    provider: getProjectAgentProvider(config),
    model: getProjectAgentModel(config),
    keys,
    disabledKeyHashes,
    baseUrl: String(config.agent_llm_siliconflow_base_url || config.siliconflow_base_url || 'https://api.siliconflow.cn/').trim(),
    keyHealthTtlMs: Number(config.agent_llm_key_health_ttl_ms || 300000),
    runtimeDir: getRuntimeDir(config)
  };
}

export function resolveGlmClaudeKeys(config = loadConfig(), envSiliconFlowKey = process.env.SILICONFLOW_API_KEY) {
  const agentKeys = uniqueValues(
    Array.isArray(config.agent_llm_siliconflow_keys) ? config.agent_llm_siliconflow_keys : []
  );
  if (agentKeys.length) return agentKeys;
  return uniqueValues([
    config.siliconflow_api_key,
    envSiliconFlowKey
  ]);
}

function buildCandidates(settings) {
  return settings.keys
    .map((key) => {
      const keyHash = hashKey(key);
      if (settings.disabledKeyHashes.includes(keyHash)) return null;
      return {
        provider: settings.provider,
        model: settings.model,
        key,
        keyHash,
        runtimeDir: buildProviderRuntimeDir(settings.runtimeDir),
        baseUrl: settings.baseUrl
      };
    })
    .filter(Boolean);
}

function isHealthy(candidate) {
  const state = healthMap.get(`${candidate.keyHash}:${candidate.model}`);
  if (!state) return true;
  return Number(state.retryAfter || 0) <= Date.now();
}

export function markGlmCandidateHealthy(candidate) {
  healthMap.delete(`${candidate.keyHash}:${candidate.model}`);
}

function shouldMarkUnhealthy(error) {
  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('429') ||
    message.includes('403') ||
    message.includes('failed to authenticate') ||
    message.includes('authentication') ||
    message.includes('balance is insufficient') ||
    message.includes('insufficient balance') ||
    message.includes('too many requests') ||
    message.includes('rate limit') ||
    message.includes('fetch failed') ||
    message.includes('timeout') ||
    message.includes('without progress') ||
    message.includes('without calling required tools') ||
    message.includes('stalled') ||
    message.includes('econnreset') ||
    message.includes('socket hang up') ||
    message.includes('temporarily unavailable')
  );
}

export function markGlmCandidateFailure(candidate, error, ttlMs = getGlmClaudeSettings().keyHealthTtlMs) {
  if (!candidate || !shouldMarkUnhealthy(error)) return;
  healthMap.set(`${candidate.keyHash}:${candidate.model}`, {
    retryAfter: Date.now() + Number(ttlMs || 300000),
    lastError: String(error?.message || 'unknown error')
  });
}

export function getHealthyGlmCandidate(_preferredModel = '', _preferredProvider = '') {
  const settings = getGlmClaudeSettings();
  const allCandidates = buildCandidates(settings);
  if (!allCandidates.length) {
    throw new Error('No SiliconFlow Claude agent candidates configured in .autoedit/config.json');
  }
  const healthy = allCandidates.filter(isHealthy);
  const pool = healthy.length ? healthy : allCandidates;

  const candidate = pool[roundRobinIndex % pool.length];
  roundRobinIndex = (roundRobinIndex + 1) % pool.length;
  return {
    ...candidate,
    provider: candidate.provider,
    baseUrl: candidate.baseUrl,
    runtimeDir: candidate.runtimeDir
  };
}

export function listGlmCandidateHealth() {
  const settings = getGlmClaudeSettings();
  const candidates = buildCandidates(settings);
  return candidates.map((candidate) => {
    const state = healthMap.get(`${candidate.keyHash}:${candidate.model}`);
    return {
      provider: candidate.provider,
      model: candidate.model,
      keyHash: candidate.keyHash,
      healthy: !state || Number(state.retryAfter || 0) <= Date.now(),
      retryAfter: state?.retryAfter || null,
      lastError: state?.lastError || ''
    };
  });
}
