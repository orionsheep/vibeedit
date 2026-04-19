const SUPPORTED_PROJECT_AGENT_MODES = new Set(['custom', 'assemble_script']);

const ASSEMBLE_SCRIPT_INTENT_PATTERN = /(口播|拼稿|讲稿|录了几遍|重复\s*take|重复录|重复版本|整理口播|剪(?:辑)?一下口播|剪口播|精简口播|去重|口头禅|停顿|间隙|空白|压紧节奏)/i;
const PROJECT_REFERENCE_PATTERN = /(这个视频|这个项目|当前视频|当前项目|当前结果|当前版本|当前时间线|当前字幕|当前脚本|当前逐字稿|剪辑后|最终版本|最后版本|项目里|项目中|视频里|视频中|素材|时间线|字幕|脚本|逐字稿|文稿|台词|成片|片子|保留内容|删了什么|剩下什么)/i;
const RESULT_REFERENCE_PATTERN = /(这个视频|这个项目|当前|最后|最终|剪辑后|成片|现在|保留|删了|剩下)/i;
const TRANSCRIPT_REFERENCE_PATTERN = /(逐字稿|字幕稿|脚本|全文|全稿|文稿|台词|字幕)/i;
const PROJECT_READ_VERB_PATTERN = /(输出|列出|展示|贴出|发我|给我|看看|查看|读取|读一下|总结|分析|解释|说明|告诉我|列一下|展开|贴一下|发一下)/i;
const PROJECT_READ_ONLY_PATTERN = /(删了什么|剩下什么|保留了什么|现在.*(内容|字幕|脚本|时间线)|总结一下当前|解释一下当前|看看当前|查看当前|当前项目.*(情况|状态|内容)|当前视频.*(内容|状态)|剪辑后.*(稿|字幕|脚本|逐字稿|文稿)|最终.*(稿|字幕|脚本|逐字稿|文稿)|最后.*(稿|字幕|脚本|逐字稿|文稿))/i;
const MUTATION_INTENT_PATTERN = /(删除|恢复|去掉|切掉|清理|压紧|压缩|精简|改写|替换|调整|排序|重排|重做|重剪|拼稿|剪(?:辑)?|去重|删停顿|去停顿|删间隙|去间隙|删空白|去空白|删口头禅|去口头禅|合并|拆分|保存快照|新建快照|恢复完整|重置|导出视频|导出工程包|导出xml|导出edl|导出srt|导入)/i;
const PROJECT_CONTEXT_ACTION_PATTERN = /(项目|时间线|字幕|脚本|逐字稿|素材|片段|版本|结果|导出|快照)/i;

function buildRequestText(prompt = '', topic = '') {
  return `${String(prompt || '').trim()} ${String(topic || '').trim()}`.trim();
}

export function normalizeProjectAgentMode(mode = 'custom') {
  const value = String(mode || 'custom').trim().toLowerCase() || 'custom';
  if (!SUPPORTED_PROJECT_AGENT_MODES.has(value)) {
    throw new Error(`Unsupported project agent mode: ${value}. Only custom and assemble_script are supported.`);
  }
  return value;
}

export function classifyProjectAgentRequest({
  mode = 'custom',
  prompt = '',
  topic = '',
  targetMinutes = 0
} = {}) {
  const requestedMode = normalizeProjectAgentMode(mode);
  const text = buildRequestText(prompt, topic);
  const hasProjectReference = PROJECT_REFERENCE_PATTERN.test(text);
  const asksForTranscriptLikeOutput = RESULT_REFERENCE_PATTERN.test(text) && TRANSCRIPT_REFERENCE_PATTERN.test(text);
  const explicitReadOnlyProjectQuery = (
    PROJECT_READ_ONLY_PATTERN.test(text) ||
    asksForTranscriptLikeOutput ||
    (hasProjectReference && PROJECT_READ_VERB_PATTERN.test(text) && !MUTATION_INTENT_PATTERN.test(text))
  );
  const explicitMutationIntent = (
    Number(targetMinutes || 0) > 0 ||
    (MUTATION_INTENT_PATTERN.test(text) && !explicitReadOnlyProjectQuery)
  );
  const assembleScriptIntent = ASSEMBLE_SCRIPT_INTENT_PATTERN.test(text);

  let effectiveMode = requestedMode;
  let routingReason = '';

  if (requestedMode === 'assemble_script' && !assembleScriptIntent) {
    effectiveMode = 'custom';
    routingReason = explicitReadOnlyProjectQuery
      ? 'read_only_project_query'
      : explicitMutationIntent
        ? 'non_assemble_project_task'
        : 'general_conversation';
  } else if (requestedMode === 'custom' && assembleScriptIntent && explicitMutationIntent) {
    effectiveMode = 'assemble_script';
    routingReason = 'assemble_script_intent';
  }

  const requiresToolUse = (
    effectiveMode === 'assemble_script' ||
    explicitMutationIntent ||
    explicitReadOnlyProjectQuery ||
    (hasProjectReference && PROJECT_CONTEXT_ACTION_PATTERN.test(text) && PROJECT_READ_VERB_PATTERN.test(text))
  );

  const requiresMutation = (
    effectiveMode === 'assemble_script' ||
    (effectiveMode === 'custom' && explicitMutationIntent && !explicitReadOnlyProjectQuery)
  );

  return {
    requestedMode,
    effectiveMode,
    text,
    hasProjectReference,
    assembleScriptIntent,
    explicitReadOnlyProjectQuery,
    explicitMutationIntent,
    requiresToolUse,
    requiresMutation,
    generalConversation: !hasProjectReference && !explicitReadOnlyProjectQuery && !explicitMutationIntent,
    routingReason
  };
}

export function inferEffectiveProjectAgentMode(mode = 'custom', prompt = '', topic = '', targetMinutes = 0) {
  return classifyProjectAgentRequest({
    mode,
    prompt,
    topic,
    targetMinutes
  }).effectiveMode;
}
