const AUTOEDIT_TOOL_NAMES = new Set([
  'get_project_context',
  'get_timeline_detail',
  'list_project_assets',
  'list_project_slices',
  'suggest_project_slices',
  'get_project_slice_detail',
  'create_project_slice',
  'delete_project_slice',
  'search_project_subtitles',
  'get_asset_script_map',
  'get_subtitle_blocks',
  'get_script_blocks',
  'get_deleted_subtitle_blocks',
  'get_assemble_candidates',
  'auto_assemble_script',
  'get_pause_candidates',
  'delete_subtitle_blocks',
  'restore_subtitle_blocks',
  'remove_project_asset',
  'reorder_project_assets',
  'delete_words_by_phrase',
  'replace_subtitle_text',
  'restore_words_by_phrase',
  'remove_pauses',
  'remove_all_pauses',
  'clear_deleted',
  'save_snapshot',
  'export_video'
]);

function normalizeToolName(input = '') {
  if (typeof input === 'string') return String(input || '').trim();
  if (input && typeof input === 'object') {
    return String(input.name || input.toolName || input.tool || '').trim();
  }
  return '';
}

function extractCandidateToolNames(toolName = '') {
  const normalized = normalizeToolName(toolName);
  if (!normalized) return [];
  const candidates = new Set([normalized]);
  if (normalized.startsWith('mcp__autoedit__')) {
    candidates.add(normalized.slice('mcp__autoedit__'.length));
  }
  if (normalized.includes('.')) {
    candidates.add(normalized.split('.').pop());
  }
  if (normalized.includes(':')) {
    candidates.add(normalized.split(':').pop());
  }
  return [...candidates].filter(Boolean);
}

function isAutoeditMcpToolName(toolName = '') {
  return extractCandidateToolNames(toolName).some((candidate) => (
    candidate.startsWith('mcp__autoedit__') || AUTOEDIT_TOOL_NAMES.has(candidate)
  ));
}

export function createAutoeditToolApprovalCallback() {
  return async (toolName) => {
    if (isAutoeditMcpToolName(toolName)) {
      return {
        behavior: 'allow',
        message: 'AutoEdit 项目级 MCP 工具已由服务端自动批准。'
      };
    }
    return {
      behavior: 'deny',
      message: '当前托管 Agent 运行仅允许调用 AutoEdit 项目级 MCP 工具。'
    };
  };
}

export function buildClaudeSdkPermissionOptions({ autoApproveProjectTools = false } = {}) {
  if (autoApproveProjectTools) {
    return {
      permissionMode: 'default',
      canUseTool: createAutoeditToolApprovalCallback()
    };
  }
  return {
    permissionMode: 'default'
  };
}
