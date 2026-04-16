/**
 * AutoEdit project configuration.
 * The project-local `.autoedit/config.json` is the only primary config source.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const CURRENT_FILE = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(CURRENT_FILE), '../../../../../');
const DEFAULT_PROJECT_CONFIG_DIR = path.join(PROJECT_ROOT, '.autoedit');

const CONFIG_DIR = process.env.AUTOEDIT_CONFIG_DIR
  ? path.resolve(process.env.AUTOEDIT_CONFIG_DIR)
  : DEFAULT_PROJECT_CONFIG_DIR;
const CONFIG_FILE = process.env.AUTOEDIT_CONFIG_FILE
  ? path.resolve(process.env.AUTOEDIT_CONFIG_FILE)
  : path.join(CONFIG_DIR, 'config.json');
const DEFAULT_CONFIG = {
  output_dir: os.tmpdir(),
  workspace_dir: process.env.AUTOEDIT_WORKSPACE_DIR || path.join(os.homedir(), '.autoedit', 'workspace'),
  storage_root: process.env.AUTOEDIT_STORAGE_ROOT || '',
  dashboard_host: '0.0.0.0',
  dashboard_port: 12080,
  api_port: 12081,
  database_url: process.env.DATABASE_URL || 'postgresql://autoedit:autoedit@127.0.0.1:5432/autoedit?schema=public',
  queue_enabled: true,
  asr_provider: 'local',
  asr_model_size: '1.7B',
  asr_language: '',
  siliconflow_api_key: '',
  siliconflow_base_url: 'https://api.siliconflow.cn/v1',
  siliconflow_asr_model: 'FunAudioLLM/SenseVoiceSmall',
  siliconflow_asr_fallback_model: 'TeleAI/TeleSpeechASR',
  agent_llm_provider: 'siliconflow_claude_sdk',
  agent_llm_model: 'Pro/zai-org/GLM-5',
  agent_llm_models: ['glm-5', 'glm-5-turbo'],
  agent_llm_keys: [],
  agent_llm_base_url: 'https://open.bigmodel.cn/api/anthropic',
  agent_llm_siliconflow_model: 'Pro/zai-org/GLM-5',
  agent_llm_siliconflow_models: ['Pro/zai-org/GLM-5'],
  agent_llm_siliconflow_keys: [],
  agent_llm_siliconflow_base_url: 'https://api.siliconflow.cn/',
  agent_llm_key_health_ttl_ms: 300000,
  agent_llm_timeout_ms: 300000,
  ai_gap_threshold: 0.8,
  ai_highlight_target_ratio: 0.35,
  ai_highlight_min_seconds: 45,
  ai_highlight_max_seconds: 180,
};

function loadJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (error) {
    console.error(`[AutoEdit Config] Failed to load config from ${filePath}:`, error.message);
    return {};
  }
}

/**
 * Load AutoEdit configuration
 * @returns {Object} Configuration object
 */
export function loadConfig() {
  const config = { ...DEFAULT_CONFIG };
  Object.assign(config, loadJsonFile(CONFIG_FILE));

  return config;
}

export function getProjectRoot() {
  return PROJECT_ROOT;
}

export function getConfigFile() {
  return CONFIG_FILE;
}

/**
 * Get workspace directory for Cut operations
 * @returns {string} Absolute path to workspace directory
 */
export function getWorkspaceDir() {
  const config = loadConfig();
  const workspaceDir = config.workspace_dir || DEFAULT_CONFIG.workspace_dir;
  return path.resolve(workspaceDir.replace('~', os.homedir()));
}

export function getStorageRoot() {
  const config = loadConfig();
  const configuredRoot = config.storage_root || DEFAULT_CONFIG.storage_root;
  if (configuredRoot) {
    return path.resolve(String(configuredRoot).replace('~', os.homedir()));
  }
  return path.join(getWorkspaceDir(), 'storage');
}

/**
 * Ensure workspace directories exist
 * @returns {Object} Object with paths to uploads and outputs directories
 */
export function ensureWorkspaceDirs() {
  const workspaceDir = getWorkspaceDir();
  const uploadsDir = path.join(workspaceDir, 'uploads');
  const outputsDir = path.join(workspaceDir, 'outputs');

  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(outputsDir, { recursive: true });

  return { uploadsDir, outputsDir, workspaceDir };
}

export function ensureStorageDirs() {
  const storageRoot = getStorageRoot();
  const assetsOriginalsDir = path.join(storageRoot, 'assets', 'originals');
  const assetsProxiesDir = path.join(storageRoot, 'assets', 'proxies');
  const packagesDir = path.join(storageRoot, 'projects', 'packages');
  const exportsDir = path.join(storageRoot, 'exports');

  fs.mkdirSync(assetsOriginalsDir, { recursive: true });
  fs.mkdirSync(assetsProxiesDir, { recursive: true });
  fs.mkdirSync(packagesDir, { recursive: true });
  fs.mkdirSync(exportsDir, { recursive: true });

  return {
    storageRoot,
    assetsOriginalsDir,
    assetsProxiesDir,
    packagesDir,
    exportsDir
  };
}
