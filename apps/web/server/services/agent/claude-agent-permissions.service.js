function isAutoeditMcpToolName(toolName = '') {
  return String(toolName || '').trim().startsWith('mcp__autoedit__');
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
