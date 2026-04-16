"""Shared config for autoedit CLI."""

import json
import os
import tempfile
from pathlib import Path

CURRENT_FILE = Path(__file__).resolve()
PROJECT_ROOT = CURRENT_FILE.parents[2]
DEFAULT_PROJECT_CONFIG_DIR = PROJECT_ROOT / ".autoedit"

_config_file_override = os.environ.get("AUTOEDIT_CONFIG_FILE", "").strip()
if _config_file_override:
    CONFIG_FILE = Path(_config_file_override).expanduser().resolve()
    CONFIG_DIR = CONFIG_FILE.parent
else:
    _config_dir_override = os.environ.get("AUTOEDIT_CONFIG_DIR", "").strip()
    if _config_dir_override:
        CONFIG_DIR = Path(_config_dir_override).expanduser().resolve()
    else:
        CONFIG_DIR = DEFAULT_PROJECT_CONFIG_DIR
    CONFIG_FILE = CONFIG_DIR / "config.json"

CONFIG_DIR.mkdir(parents=True, exist_ok=True)

DEFAULT_CONFIG = {
    "output_dir": os.environ.get("AUTOEDIT_OUTPUT_DIR", tempfile.gettempdir()),
    "workspace_dir": os.environ.get("AUTOEDIT_WORKSPACE_DIR", str(Path.home() / ".autoedit" / "workspace")),
    "asr_model_size": "1.7B",
    "asr_language": "",
    "asr_provider": "siliconflow",
    "backend": "",
    "model_source": "modelscope",
    "model_cache_dir": "",
    "dashboard_host": "0.0.0.0",
    "dashboard_port": 12080,
    "api_port": 12081,
    "siliconflow_api_key": "",
    "siliconflow_base_url": "https://api.siliconflow.cn/v1",
    "siliconflow_asr_model": "FunAudioLLM/SenseVoiceSmall",
    "siliconflow_asr_fallback_model": "TeleAI/TeleSpeechASR",
    "agent_llm_provider": "glm_claude_sdk",
    "agent_llm_model": "glm-5",
    "agent_llm_models": ["glm-5", "glm-5-turbo"],
    "agent_llm_keys": [],
    "agent_llm_base_url": "https://open.bigmodel.cn/api/anthropic",
    "agent_llm_key_health_ttl_ms": 300000,
    "agent_llm_timeout_ms": 300000,
    "ai_gap_threshold": 0.8,
    "ai_highlight_target_ratio": 0.35,
    "ai_highlight_min_seconds": 45,
    "ai_highlight_max_seconds": 180,
}


def _load_json_file(file_path: Path):
    if not file_path.exists():
        return {}
    try:
        with open(file_path, "r") as f:
            return json.load(f)
    except Exception:
        return {}


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    cfg.update(_load_json_file(CONFIG_FILE))
    return cfg


def save_config(key, value):
    cfg = load_config()
    cfg[key] = value
    with open(CONFIG_FILE, "w") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
