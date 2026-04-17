import fs from 'fs';
import path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { getProjectRoot, loadConfig } from '../editor/config.js';
import {
  getHealthyGlmCandidate,
  getProjectAgentModel,
  getProjectAgentProvider,
  listGlmCandidateHealth,
  markGlmCandidateFailure,
  markGlmCandidateHealthy
} from './glm-claude-rotation.service.js';
import { TOOL_DEFINITIONS, createProjectAgentMcpServer } from './claude-agent-mcp.service.js';
import {
  appendAgentEvent,
  appendAgentMessage,
  getProjectAgentSession,
  touchAgentSession,
  updateAgentRunRecord
} from './agent-session.service.js';

const SUPPORTED_PROJECT_AGENT_MODES = new Set(['custom', 'assemble_script']);
const ASSEMBLE_SCRIPT_INTENT_PATTERN = /(口播|拼稿|讲稿|录了几遍|重复\s*take|重复录|重复版本|整理口播|剪(?:辑)?一下口播|剪口播|精简口播|去重|口头禅|停顿)/i;

function loadClaudeMdInstructions() {
  try {
    const filePath = path.join(getProjectRoot(), '.autoedit', 'CLAUDE.md');
    if (!fs.existsSync(filePath)) return '';
    return String(fs.readFileSync(filePath, 'utf-8') || '').trim();
  } catch {
    return '';
  }
}

function inferEffectiveMode(mode = 'custom', prompt = '', topic = '') {
  const normalizedMode = String(mode || 'custom').trim().toLowerCase() || 'custom';
  if (normalizedMode === 'assemble_script') return normalizedMode;
  const text = `${String(prompt || '').trim()} ${String(topic || '').trim()}`.trim();
  if (ASSEMBLE_SCRIPT_INTENT_PATTERN.test(text)) {
    return 'assemble_script';
  }
  return normalizedMode;
}

function buildSystemPrompt({ mode = 'custom', preferencePrompt = '', assembleRetryPass = false } = {}) {
  const normalizedMode = String(mode || 'custom').trim();
  const claudeMd = loadClaudeMdInstructions();
  const modeInstruction = normalizedMode === 'assemble_script'
    ? [
        '你现在执行的是一个完整的 Claude Code skill：口播拼稿。',
        '这不是高光总结，也不是文案改写任务；它要求你像资深中文口播编辑一样，基于当前项目真实时间线做严格保序的删减和清理。',
        '当前项目里**已经保留的内容和当前时间线顺序**就是你的工作基线。新的用户要求默认是在当前结果上继续增量修改，不要默认重来。',
        '除非用户明确说“重来 / 从头开始 / 恢复完整 / 重新拼一版”，否则不要调用 clear_deleted，也不要把当前删改结果推翻重做。',
        '默认保持当前顺序和原始表达顺序，不要擅自重排句子、跨段拼接、移动段落或改变素材顺序；只有用户明确要求改顺序时才能这样做。',
        '即使用户明确要求改顺序，也只允许调整整段素材 / 整个文件之间的顺序；不要改变单个视频素材内部的句子顺序、片段顺序或表达顺序。',
        '当前网站没有正式的字词润色或句子改写能力。默认不要改写原句，不要把口播剪辑做成文案重写。',
        '先自己读取当前真实时间线、当前脚本块和当前字幕块，再判断重复 take、整段重复、明显重复句、口气词和停顿。不要依赖候选摘要替你下结论。',
        '优先一次性读取完整脚本块和完整字幕块，再尽量用少量、成组的删改工具完成修改；不要删一点就反复回头分页检查，除非你明确需要验证结果。',
        '默认高保留率，主要删除重复 take、明显重复句、口头禅和停顿；不要为了“更顺”而重写表达。',
        '删除整句、半句、重复 take、重复表达时，优先使用 delete_subtitle_blocks / restore_subtitle_blocks 做块级删改；不要为了省事在句子中间掏词。',
        'delete_words_by_phrase / restore_words_by_phrase 只用于独立短口头禅和语气词，例如“嗯”“啊”“呃”“就是”“那个”；不允许用它删除句中实词、主谓宾、连接逻辑或半句结构。',
        '如果用户要求去口气词、口头禅或停顿，你必须真正调用 delete_words_by_phrase、delete_subtitle_blocks、remove_pauses 等工具落地，而不是只在总结里声称处理过。',
        '即使用户没有单独强调停顿，口播拼稿在完成主要语义删减后，也必须检查一次当前结果里是否还残留明显长停顿；若有，就调用 remove_pauses 做收尾清理。',
        '在你认为编辑完成后，必须做一次强制自我审查，而且不能只凭记忆判断；必须再次调用 get_script_blocks、必要时再调用 get_subtitle_blocks / get_timeline_detail，基于最新结果逐项复查。',
        '自我审查必须逐项检查这 8 点：1. 顺序是否正确；如果本轮涉及调序，必须确认只改了素材之间的顺序，没有改单个素材内部顺序；2. 句子是否通顺；3. 逻辑是否完整；4. 断句和衔接是否自然；5. 是否仍残留重复 take 或重复句；6. 停顿、口气词、口头禅是否真的去掉；7. 是否误删关键内容；8. 是否还存在一到两处明显可改进点。',
        '只要这 8 项里有任意一项不通过，就继续调用工具修正，直到全部通过后才能结束。',
        '最终回复里，必须用简短清单汇报这 8 项的检查结果与修正结论，不能只给一句笼统总结；如果没有这 8 项清单，就不算完成。',
        assembleRetryPass
          ? '这是一次强制重试：上一轮没有真正改到项目或没有完成自审清单。你这次必须自己读完整个当前口播稿，再调用删除/恢复/去停顿工具完成实际修改。不要停在总结。'
          : ''
      ].join('\n')
    : [
        '你在做自定义项目剪辑任务，应直接基于当前项目真实时间线和字幕流调用工具。',
        '新的用户要求默认是在当前结果上继续做局部修改，不要默认重来或恢复完整项目，除非用户明确这样要求。',
        '默认保持当前顺序，不要擅自重排句子或素材顺序，除非用户明确要求。',
        '如果用户明确要求改顺序，也只允许调整整段素材 / 整个文件之间的顺序；不要改单个视频素材内部的句子顺序、片段顺序或表达顺序。',
        '任何写操作完成前，都必须做一轮强制自我审查：重新读取当前结果，逐项检查顺序、通顺度、逻辑完整性、断句自然度、重复残留、停顿/口气词处理和误删风险，并确认调序时没有破坏单素材内部顺序，确认全部通过后再结束。'
      ].join('\n');

  return [
    '你是 AutoEdit 的项目级 Claude Code Agent。',
    '你只能通过提供的 MCP 工具修改项目，不能凭空声称已经完成操作。',
    '你拥有当前项目全部可用工具的直接操作权，可以自行决定调用哪些工具完成任务。',
    '模式只决定当前任务目标和编辑偏好，不会限制你的工具权限；无论是口播拼稿还是自由指令，你都可以自由选择任意项目工具。',
    '项目状态的真相是当前真实时间线、当前项目级字幕覆盖和当前删除态，不要按素材原顺序脑补项目内容。',
    '除了 remove_pauses 这类明显确定性动作外，其他语义判断都必须由你基于完整上下文做出。',
    '读取上下文时先小后大：先用 get_project_context 和 get_timeline_detail 建立整体认知；只有在需要语义判断时，再读 get_script_blocks、get_subtitle_blocks 或 search_project_subtitles。',
    '口播拼稿时，固定先保存快照，再读取真实时间线和当前完整脚本块，然后基于当前结果做增量修改。',
    '执行语义编辑时，删除完整意思单元优先使用 delete_subtitle_blocks、restore_subtitle_blocks；delete_words_by_phrase、restore_words_by_phrase 只用于独立短口头禅和语气词，不允许删除句中实词、主谓宾或半句结构。',
    'replace_subtitle_text 只用于真正的字幕纠错，不用于剪辑意义上的删减，也不用于为追求“更顺”而改写原句。',
    '如果你没有真正改动项目，就不要说完成。',
    '默认用简洁中文回复。',
    modeInstruction,
    preferencePrompt ? `长期偏好：${preferencePrompt}` : '',
    claudeMd ? `项目级 CLAUDE.md 约束：\n${claudeMd}` : ''
  ].filter(Boolean).join('\n\n');
}

function buildConversationMemory(sessionDetail, currentPrompt = '') {
  const summary = String(sessionDetail?.summary || '').trim();
  const recentMessages = (sessionDetail?.messages || [])
    .slice(-12)
    .map((message) => `${message.role === 'assistant' ? 'Agent' : '用户'}: ${String(message.content || '').trim()}`)
    .filter(Boolean);

  return [
    summary ? `会话摘要：\n${summary}` : '',
    recentMessages.length ? `最近对话：\n${recentMessages.join('\n')}` : '',
    currentPrompt ? `本轮新要求：\n${currentPrompt}` : ''
  ].filter(Boolean).join('\n\n');
}

function buildUserPrompt({ mode = 'custom', prompt = '', topic = '', targetMinutes = 0, sessionDetail = null, assembleRetryPass = false }) {
  const lines = [];
  lines.push(`当前模式：${mode}`);
  if (topic) lines.push(`主题：${topic}`);
  if (Number(targetMinutes || 0) > 0) lines.push(`目标分钟数：${Number(targetMinutes)}`);
  lines.push(`用户要求：${String(prompt || '').trim() || `执行 ${mode}`}`);
  const memoryText = buildConversationMemory(sessionDetail, String(prompt || '').trim());
  if (memoryText) lines.push(memoryText);
  lines.push('请先理解需求，再通过工具完成修改。读操作不要过度扫描；写操作必须真实改动项目。默认是在当前已剪结果上继续局部修改，不要重来，也不要恢复完整项目，除非用户明确要求。默认保持当前顺序，不要擅自重排。当前网站没有正式的字词润色能力，所以不要改写原句；默认只做删除、恢复、去停顿和项目级管理。若用户明确要求改顺序，也只允许调整整段素材 / 整个文件之间的顺序，不要改单个视频素材内部的句子顺序、片段顺序或表达顺序。口播拼稿时不要凭几句样本或候选摘要就开始删减，必须先自己读到足够完整的当前脚本块和字幕块后再动手；如果 get_script_blocks / get_subtitle_blocks 没有限制参数，默认会直接给你全量，请优先这样读完整上下文。删整句、半句、重复 take、重复表达时优先用 delete_subtitle_blocks；delete_words_by_phrase 只允许删独立短口头禅和语气词，不允许在句子中间掏词。若用户要求去口气词、去口头禅或去停顿，必须真正调用对应工具落地；即使用户没特别强调停顿，也要在语义删减后检查一次是否还残留明显长停顿，并按需调用 remove_pauses 收尾。工具执行完成后，不要立即结束；必须重新读取当前结果做一轮强制自我审查，并逐项检查这 8 项：顺序、通顺、逻辑完整、断句衔接、重复残留、停顿/口气词处理、误删关键内容、是否还有明显可改进点；如果本轮涉及调序，还必须确认只改了素材之间的顺序，没有改单素材内部顺序。只要任一项不通过，就继续修正。最终回复里必须清楚包含这 8 项检查结论。');
  if (assembleRetryPass && String(mode || '').trim() === 'assemble_script') {
    lines.push('上一轮没有真正修改项目或没有完成自审清单。这一轮禁止只读取候选摘要后结束，必须自己读完整脚本块并真正调用删改工具。');
  }
  return lines.join('\n');
}

function getPrimaryAppliedSummary(appliedChanges = []) {
  const primaryChange = appliedChanges[appliedChanges.length - 1];
  return String(primaryChange?.summary || '').trim();
}

function buildAssistantReply(resultText = '', appliedChanges = [], { mode = 'custom' } = {}) {
  const primarySummary = getPrimaryAppliedSummary(appliedChanges);
  const text = String(resultText || '').trim();
  if (String(mode || '').trim() === 'assemble_script') {
    return text;
  }
  if (text) return text;
  return primarySummary || '本次项目编辑已完成。';
}

const ASSEMBLE_REVIEW_KEYWORDS = ['顺序', '通顺', '逻辑', '断句', '重复', '停顿', '误删', '改进'];

function buildAssembleReviewResult(text = '', extra = {}) {
  const content = String(text || '').trim();
  const checklist = ASSEMBLE_REVIEW_KEYWORDS.map((keyword) => ({
    keyword,
    present: content.includes(keyword)
  }));
  return {
    complete: checklist.every((item) => item.present),
    checklist,
    synthesized: Boolean(extra.synthesized),
    recovery_reason: extra.recoveryReason || ''
  };
}

function isStallLikeError(error) {
  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('timed out') ||
    message.includes('timeout') ||
    message.includes('without progress') ||
    message.includes('fetch failed') ||
    message.includes('socket hang up') ||
    message.includes('econnreset')
  );
}

function isAssembleReviewFailure(error) {
  const message = String(error?.message || '');
  return (
    message.includes('自审清单') ||
    message.includes('最终自审') ||
    message.includes('最终回复') ||
    message.includes('没有输出最终自审') ||
    message.includes('没有完成强制自审')
  );
}

function summarizeAssembleAppliedChanges(appliedChanges = []) {
  const tools = appliedChanges.map((change) => String(change?.tool || '').trim()).filter(Boolean);
  return {
    savedSnapshot: tools.includes('save_snapshot'),
    reorderedAssets: tools.includes('reorder_project_assets'),
    removedPauses: tools.includes('remove_pauses'),
    deletedWords: tools.includes('delete_words_by_phrase'),
    deletedBlocks: tools.includes('delete_subtitle_blocks'),
    restoredWords: tools.includes('restore_words_by_phrase'),
    restoredBlocks: tools.includes('restore_subtitle_blocks'),
    replacedText: tools.includes('replace_subtitle_text')
  };
}

function buildAssembleRecoveryReply(appliedChanges = [], recoveryReason = '') {
  const summary = getPrimaryAppliedSummary(appliedChanges) || '已按本轮工具操作完成口播时间线修改。';
  const flags = summarizeAssembleAppliedChanges(appliedChanges);
  const intro = recoveryReason
    ? `系统保底收尾：模型已经实际改动项目，但最终自审阶段未稳定返回（${recoveryReason}）。以下清单基于本轮工具结果生成，建议你顺手抽查一遍预览。`
    : '系统保底收尾：模型已经实际改动项目，但最终自审阶段未稳定返回。以下清单基于本轮工具结果生成，建议你顺手抽查一遍预览。';

  const repeatedCleanupSummary = flags.deletedWords || flags.deletedBlocks
    ? '本轮已执行删除类工具处理重复内容和冗余表达。'
    : '本轮没有新的删除类工具记录，建议人工确认是否仍有重复段落残留。';

  const pauseSummary = flags.removedPauses
    ? '本轮已调用 remove_pauses 处理明显停顿。'
    : '本轮未记录 remove_pauses，建议人工确认是否仍有明显长停顿。';

  return [
    intro,
    `本轮结果：${summary}`,
    `顺序：${flags.reorderedAssets ? '本轮涉及素材级调序；系统只允许素材/文件之间的顺序变化，不会自动改单个素材内部顺序。' : '本轮未调用调序工具，默认保持当前素材顺序不变。'}`,
    `通顺：${flags.replacedText ? '本轮包含少量字幕纠错；请重点抽查修改处的语句通顺度。' : '本轮主要通过删除/恢复/去停顿处理，不靠改写原句；建议抽查衔接是否自然。'}`,
    '逻辑：本轮是在当前已剪结果上继续增量修改，没有自动重置项目；建议人工确认关键信息仍然完整。',
    `断句：${flags.deletedWords || flags.deletedBlocks || flags.restoredWords || flags.restoredBlocks ? '本轮做过删除或恢复，建议抽查删改交界处的断句和衔接。' : '本轮没有明显的断句级工具变动，请结合预览确认。'}`,
    `重复：${repeatedCleanupSummary}`,
    `停顿：${pauseSummary}`,
    '误删：系统无法仅凭工具日志完全排除误删，建议重点复核本轮刚删除的短句和连接句。',
    '改进：如果你听感上仍觉得不顺，建议再发一条更具体的局部指令继续细修，例如“把第二段再压紧一点”或“把口头禅继续清一轮”。'
  ].join('\n');
}

function requestRequiresToolUse({ mode = 'custom', prompt = '', topic = '', targetMinutes = 0 } = {}) {
  if (String(mode || '').trim() === 'assemble_script') return true;
  if (Number(targetMinutes || 0) > 0) return true;
  const text = `${String(prompt || '').trim()} ${String(topic || '').trim()}`.toLowerCase();
  if (!text) return false;
  return /(读取|查看|项目|上下文|素材|时间线|字幕|搜索|删除|恢复|导出|快照|拼稿|口播|停顿|冗余|改写|替换|调整|排序|移除|保存|重写|修改|剪辑|剪一下|精简)/.test(text);
}

function isMutatingChange(change = {}) {
  const tool = String(change.tool || change.change || change.type || '').trim();
  return new Set([
    'delete_subtitle_blocks',
    'restore_subtitle_blocks',
    'remove_project_asset',
    'reorder_project_assets',
    'delete_words_by_phrase',
    'replace_subtitle_text',
    'restore_words_by_phrase',
    'remove_pauses',
    'clear_deleted',
    'save_snapshot',
    'export_video',
    'export_project_package'
  ]).has(tool);
}

function isTimelineEditingChange(change = {}) {
  const tool = String(change.tool || change.change || change.type || '').trim();
  return new Set([
    'delete_subtitle_blocks',
    'restore_subtitle_blocks',
    'remove_project_asset',
    'reorder_project_assets',
    'delete_words_by_phrase',
    'replace_subtitle_text',
    'restore_words_by_phrase',
    'remove_pauses',
    'clear_deleted'
  ]).has(tool);
}

function requestRequiresMutation({ mode = 'custom', prompt = '', topic = '', targetMinutes = 0 } = {}) {
  const normalizedMode = String(mode || '').trim();
  if (normalizedMode === 'assemble_script') return true;
  if (normalizedMode !== 'custom') return false;
  if (Number(targetMinutes || 0) > 0) return true;
  const text = `${String(prompt || '').trim()} ${String(topic || '').trim()}`.toLowerCase();
  if (!text) return false;
  return /(拼稿|删除|恢复|导出|快照|去重|删掉|移除|改写|替换|调整|排序|口播|改成|清理|压缩|精简|去掉|重写|修改)/.test(text);
}

function selectToolNames({ mode = 'custom' } = {}) {
  return Object.keys(TOOL_DEFINITIONS);
}

function buildAssembleReviewFollowupPrompt() {
  return [
    '你刚刚已经完成了一轮口播剪辑。',
    '现在禁止重来，也不要重新从头做一版；必须基于当前项目最新状态执行最终自审。',
    '先调用一次 get_script_blocks；只有在你确实需要补充确认时，才再调用 get_subtitle_blocks 或 get_timeline_detail。',
    '除非你明确发现严重问题，否则不要继续大改，也不要重排单个视频素材内部顺序。',
    '最后只输出 8 行清单，不要写额外前言或总结；每行必须以对应关键词开头：顺序、通顺、逻辑、断句、重复、停顿、误删、改进。',
    '如果本轮涉及调序，必须明确说明只改了素材/文件之间的顺序，没有改单个素材内部顺序。',
    '如果你没有发现新增问题，就直接给出 8 行检查结论并结束。'
  ].join('\n');
}

function getAssembleReviewReserveMs(timeoutMs, config = loadConfig()) {
  const configured = Number(config.agent_llm_assemble_review_reserve_ms || 0);
  const fallback = 25000;
  const raw = configured > 0 ? configured : fallback;
  const cappedUpperBound = Math.max(5000, Number(timeoutMs || 0) - 5000);
  return Math.min(Math.max(5000, raw), cappedUpperBound);
}

export async function runClaudeAgentSession({
  projectId,
  sessionId,
  runId,
  mode = 'custom',
  prompt = '',
  topic = '',
  targetMinutes = 0,
  preferencePrompt = '',
  preferredProvider = '',
  preferredModel = '',
  onEvent = () => {},
  signal,
  approvedHighRisk = true
}) {
  const normalizedMode = inferEffectiveMode(mode, prompt, topic);
  if (!SUPPORTED_PROJECT_AGENT_MODES.has(normalizedMode)) {
    throw new Error(`Unsupported project agent mode: ${normalizedMode}. Only custom and assemble_script are supported.`);
  }

  const sessionDetail = await getProjectAgentSession(projectId, sessionId);
  if (!sessionDetail) {
    throw new Error('Agent session not found');
  }

  const emit = async (event) => {
    const appended = await appendAgentEvent({
      sessionId,
      runId,
      type: event.type,
      step: event.step || '',
      message: event.message || '',
      payload: event.payload || {}
    });
    onEvent(appended);
    return appended;
  };

  const candidateCount = Math.max(listGlmCandidateHealth().length || 0, 1);
  const logicalAttempts = normalizedMode === 'assemble_script' ? 2 : 1;
  const attemptCount = candidateCount * logicalAttempts;
  let lastError = null;
  let resumeSessionId = sessionDetail.memory?.claude_sdk_session_id || '';
  const requestedProvider = getProjectAgentProvider();
  const requestedModel = getProjectAgentModel();
  let bumpProgress = () => {};

  for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
    const config = loadConfig();
    const candidate = getHealthyGlmCandidate(requestedModel, requestedProvider);
    const abortController = new AbortController();
    const timeoutMs = Number(config.agent_llm_timeout_ms || 90000);
    const inactivityTimeoutMs = Number(config.agent_llm_inactivity_timeout_ms || (normalizedMode === 'assemble_script' ? 45000 : 20000));
    const assembleReviewReserveMs = normalizedMode === 'assemble_script'
      ? getAssembleReviewReserveMs(timeoutMs, config)
      : 0;
    let timeoutId = null;
    let inactivityId = null;
    const activeStreamRef = { current: null };
    const onAbort = () => abortController.abort(new Error('Agent run cancelled'));
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const assembleRetryPass = normalizedMode === 'assemble_script' && attempt > candidateCount;
    const appliedChanges = [];
    const pendingConfirmation = { current: null };
    const mutatedProject = { current: false };
    let claudeSessionId = assembleRetryPass ? '' : resumeSessionId;
    let finalResultText = '';
    let forcedReviewHandoff = false;
    const mcpToolNames = selectToolNames({ mode: normalizedMode, prompt, assembleRetryPass });
    const runtimeDir = candidate.runtimeDir;
    const attemptStartedAt = Date.now();
    let stream = null;
    const closeCurrentStream = () => {
      try {
        activeStreamRef.current?.close?.();
      } catch {
        // ignore close errors from provider SDK
      }
    };
    const throwIfAborted = () => {
      if (abortController.signal.aborted) {
        throw abortController.signal.reason || new Error('Agent run cancelled');
      }
    };
    const shouldForceReviewHandoff = () => {
      if (normalizedMode !== 'assemble_script' || forcedReviewHandoff) return false;
      if (!appliedChanges.some(isTimelineEditingChange)) return false;
      return Date.now() - attemptStartedAt >= Math.max(0, timeoutMs - assembleReviewReserveMs);
    };
    const runAssembleReviewPass = async (mcpServer) => {
      if (normalizedMode !== 'assemble_script') return '';
      await emit({
        type: 'stage',
        step: 'review',
        message: forcedReviewHandoff
          ? '已完成主要修改，正在提前切换到最终自审，避免总结阶段超时。'
          : '第一轮未输出完整自审清单，正在强制发起最终自审。',
        payload: {
          model: candidate.model,
          provider: candidate.provider,
          forced_handoff: forcedReviewHandoff
        }
      });
      let reviewText = '';
      const reviewStream = query({
        prompt: buildAssembleReviewFollowupPrompt(),
        options: {
          cwd: getProjectRoot(),
          permissionMode: 'bypassPermissions',
          tools: [],
          model: candidate.model,
          maxTurns: 24,
          resume: claudeSessionId || undefined,
          abortController,
          systemPrompt: buildSystemPrompt({ mode: normalizedMode, preferencePrompt, assembleRetryPass }),
          mcpServers: {
            autoedit: mcpServer
          },
          env: {
            ...process.env,
            ANTHROPIC_BASE_URL: candidate.baseUrl,
            ANTHROPIC_API_KEY: '',
            ANTHROPIC_AUTH_TOKEN: candidate.key,
            CLAUDE_CONFIG_DIR: runtimeDir,
            CLAUDE_AGENT_SDK_CLIENT_APP: 'autoedit/claude-sdk'
          }
        }
      });
      activeStreamRef.current = reviewStream;
      try {
        for await (const message of reviewStream) {
          throwIfAborted();
          bumpProgress();
          if (message?.session_id) {
            claudeSessionId = message.session_id;
          }
          if (message?.type === 'assistant') {
            const parts = Array.isArray(message.message?.content) ? message.message.content : [];
            const thinking = parts.find((item) => item?.type === 'thinking');
            if (thinking?.thinking) {
              await emit({
                type: 'stage',
                step: 'review_thinking',
                message: '正在执行最终自审...',
                payload: {
                  model: candidate.model,
                  preview: String(thinking.thinking).slice(0, 300)
                }
              });
            }
          }
          if (message?.type === 'result') {
            if (message.subtype !== 'success') {
              throw new Error((message.errors || []).join('\n') || `Claude SDK review failed: ${message.subtype}`);
            }
            reviewText = String(message.result || '').trim();
          }
        }
      } finally {
        if (activeStreamRef.current === reviewStream) {
          activeStreamRef.current = null;
        }
        try {
          reviewStream?.close?.();
        } catch {
          // ignore close errors
        }
      }
      return reviewText;
    };

    try {
      let timeoutReject = () => {};
      let inactivityReject = () => {};
      const timeoutPromise = new Promise((_, reject) => {
        timeoutReject = reject;
        timeoutId = setTimeout(() => {
          const error = new Error(`Claude Agent SDK timed out after ${timeoutMs}ms`);
          abortController.abort(error);
          closeCurrentStream();
          reject(error);
        }, timeoutMs);
      });
      const inactivityPromise = new Promise((_, reject) => {
        inactivityReject = reject;
      });
      bumpProgress = () => {
        if (inactivityId) clearTimeout(inactivityId);
        inactivityId = setTimeout(() => {
          const error = new Error(`Agent run stalled after ${inactivityTimeoutMs}ms without progress`);
          abortController.abort(error);
          closeCurrentStream();
          inactivityReject(error);
        }, inactivityTimeoutMs);
      };

      const attemptPromise = (async () => {
        await emit({
          type: 'start',
          step: 'start',
          message: `使用 ${candidate.model} 开始处理项目请求${assembleRetryPass ? '（强制重试）' : ''}`,
          payload: {
            requested_provider: requestedProvider,
            requested_model: requestedModel,
            model: candidate.model,
            provider: candidate.provider,
            key_hash: candidate.keyHash,
            tools: mcpToolNames
          }
        });
        bumpProgress();
        if (assembleRetryPass) {
          await emit({
            type: 'stage',
            step: 'retry',
            message: '上一轮没有真正改到项目，正在强制重试：这次必须读完整脚本块并完成实际修改。',
            payload: {
              model: candidate.model,
              provider: candidate.provider
            }
          });
        }

        const mcpServer = createProjectAgentMcpServer(projectId, {
          signal: abortController.signal,
          llmProvider: candidate.provider,
          llmModel: candidate.model,
          approvedHighRisk,
          pendingConfirmation,
          mutatedProject,
          appliedChanges,
          emit,
          requestContext: {
            mode: normalizedMode,
            prompt,
            topic,
            targetMinutes,
            preferencePrompt,
            sessionId,
            runId
          }
        }, mcpToolNames);

        fs.mkdirSync(runtimeDir, { recursive: true });
        stream = query({
          prompt: buildUserPrompt({ mode: normalizedMode, prompt, topic, targetMinutes, sessionDetail, assembleRetryPass }),
          options: {
            cwd: getProjectRoot(),
            permissionMode: 'bypassPermissions',
            tools: [],
            model: candidate.model,
            maxTurns: 120,
            resume: claudeSessionId || undefined,
            abortController,
            systemPrompt: buildSystemPrompt({ mode: normalizedMode, preferencePrompt, assembleRetryPass }),
            mcpServers: {
              autoedit: mcpServer
            },
            env: {
              ...process.env,
              ANTHROPIC_BASE_URL: candidate.baseUrl,
              ANTHROPIC_API_KEY: '',
              ANTHROPIC_AUTH_TOKEN: candidate.key,
              CLAUDE_CONFIG_DIR: runtimeDir,
              CLAUDE_AGENT_SDK_CLIENT_APP: 'autoedit/claude-sdk'
            }
          }
        });
        activeStreamRef.current = stream;
        abortController.signal.addEventListener('abort', closeCurrentStream, { once: true });

        try {
          for await (const message of stream) {
            throwIfAborted();
            bumpProgress();
            if (message?.session_id) {
              claudeSessionId = message.session_id;
            }

            if (message?.type === 'assistant') {
              const parts = Array.isArray(message.message?.content) ? message.message.content : [];
              const thinking = parts.find((item) => item?.type === 'thinking');
              if (thinking?.thinking) {
                await emit({
                  type: 'stage',
                  step: 'thinking',
                  message: '正在思考下一步操作...',
                  payload: {
                    model: candidate.model,
                    preview: String(thinking.thinking).slice(0, 300)
                  }
                });
              }
            }

            if (message?.type === 'result') {
              if (message.subtype !== 'success') {
                throw new Error((message.errors || []).join('\n') || `Claude SDK execution failed: ${message.subtype}`);
              }
              finalResultText = String(message.result || '').trim();
            }

            if (shouldForceReviewHandoff()) {
              forcedReviewHandoff = true;
              await emit({
                type: 'stage',
                step: 'review_handoff',
                message: '主要修改已完成，正在切换到短版最终自审。',
                payload: {
                  model: candidate.model,
                  provider: candidate.provider,
                  reserve_ms: assembleReviewReserveMs
                }
              });
              closeCurrentStream();
            }
          }
        } finally {
          if (activeStreamRef.current === stream) {
            activeStreamRef.current = null;
          }
        }

        throwIfAborted();
        await touchAgentSession(sessionId, {
          memory: {
            ...(sessionDetail.memory || {}),
            claude_sdk_session_id: claudeSessionId,
            last_agent_model: candidate.model,
            last_agent_key_hash: candidate.keyHash
          }
        });
        resumeSessionId = claudeSessionId;
        markGlmCandidateHealthy(candidate);
        const actualProvider = String(candidate.provider || '').trim();
        const fallbackRun =
          requestedProvider.toLowerCase() !== actualProvider.toLowerCase() ||
          requestedModel !== String(candidate.model || '').trim();

        if (fallbackRun) {
          await emit({
            type: 'stage',
            step: 'fallback',
            message: `本次运行发生模型回退：请求 ${requestedProvider || 'auto'}/${requestedModel || 'auto'}，实际使用 ${actualProvider}/${candidate.model}`,
            payload: {
              requested_provider: requestedProvider || '',
              requested_model: requestedModel || '',
              actual_provider: actualProvider,
              actual_model: candidate.model
            }
          });
        }

        if (pendingConfirmation.current) {
          const reply = buildAssistantReply(finalResultText || pendingConfirmation.current.confirmation_prompt, appliedChanges, {
            mode: normalizedMode
          });
          const result = {
            reply,
            summary: pendingConfirmation.current.confirmation_prompt,
            confirmation_prompt: pendingConfirmation.current.confirmation_prompt,
            actual_model: candidate.model,
            actual_provider: actualProvider,
            fallback_run: fallbackRun,
            pending_tool: {
              tool: pendingConfirmation.current.tool,
              args: pendingConfirmation.current.args
            }
          };

          await updateAgentRunRecord(runId, {
            status: 'waiting_confirmation',
            result,
            requiresConfirmation: true,
            appliedChanges
          });
          await appendAgentMessage({
            sessionId,
            runId,
            role: 'assistant',
            content: reply,
            metadata: {
              status: 'waiting_confirmation'
            }
          });
          return {
            success: true,
            run_id: runId,
            status: 'waiting_confirmation',
            reply,
            requires_confirmation: true,
            confirmation_prompt: pendingConfirmation.current.confirmation_prompt,
            applied_changes: appliedChanges,
            model: candidate.model,
            actual_model: candidate.model,
            actual_provider: actualProvider,
            fallback_run: fallbackRun
          };
        }

        let reviewResult = null;
        const requiresToolUse = requestRequiresToolUse({ mode: normalizedMode, prompt, topic, targetMinutes });
        const requiresMutation = requestRequiresMutation({ mode: normalizedMode, prompt, topic, targetMinutes });
        if (requiresToolUse && !appliedChanges.length) {
          throw new Error('本次 Agent 没有真正调用需要的工具，请重试。');
        }
        const mutationSatisfied = normalizedMode === 'assemble_script'
          ? appliedChanges.some(isTimelineEditingChange)
          : appliedChanges.some(isMutatingChange);
        if (requiresMutation && !mutationSatisfied) {
          throw new Error('本次 Agent 没有产生任何实际修改，请重试或换更明确的指令。');
        }
        if (normalizedMode === 'assemble_script') {
          reviewResult = buildAssembleReviewResult(finalResultText);
          if (!String(finalResultText || '').trim() || !reviewResult.complete) {
            const reviewFollowupText = await runAssembleReviewPass(mcpServer);
            if (String(reviewFollowupText || '').trim()) {
              finalResultText = reviewFollowupText;
              reviewResult = buildAssembleReviewResult(finalResultText);
            }
          }
          if (!String(finalResultText || '').trim()) {
            finalResultText = buildAssembleRecoveryReply(appliedChanges, '模型没有返回最终自审清单');
            reviewResult = buildAssembleReviewResult(finalResultText, {
              synthesized: true,
              recoveryReason: 'missing-final-review'
            });
          } else if (!reviewResult.complete) {
            finalResultText = buildAssembleRecoveryReply(appliedChanges, '模型没有完整输出 8 项自审清单');
            reviewResult = buildAssembleReviewResult(finalResultText, {
              synthesized: true,
              recoveryReason: 'incomplete-final-review'
            });
          }
        }

        const reply = buildAssistantReply(finalResultText, appliedChanges, {
          mode: normalizedMode,
          reviewResult
        });
        const result = {
          reply,
          summary: getPrimaryAppliedSummary(appliedChanges) || reply,
          review: reviewResult,
          applied_changes: appliedChanges,
          actual_model: candidate.model,
          actual_provider: actualProvider,
          fallback_run: fallbackRun
        };

        await updateAgentRunRecord(runId, {
          status: 'completed',
          result,
          requiresConfirmation: false,
          appliedChanges,
          finished: true
        });
        await appendAgentMessage({
          sessionId,
          runId,
          role: 'assistant',
          content: reply,
          metadata: {
            status: 'completed',
            model: candidate.model,
            provider: actualProvider,
            fallback_run: fallbackRun
          }
        });
        await emit({
          type: 'complete',
          step: 'complete',
          message: '本次 Agent 执行已完成。',
          payload: {
            model: candidate.model,
            provider: actualProvider,
            fallback_run: fallbackRun
          }
        });

        return {
          success: true,
          run_id: runId,
          status: 'completed',
          reply,
          applied_changes: appliedChanges,
          review: reviewResult,
          model: candidate.model,
          actual_model: candidate.model,
          actual_provider: actualProvider,
          fallback_run: fallbackRun
        };
      })();

      const result = await Promise.race([attemptPromise, timeoutPromise, inactivityPromise]);
      timeoutReject = () => {};
      inactivityReject = () => {};
      return result;
    } catch (error) {
      lastError = error;
      const message = String(error?.message || '');
      const hasMutatedProject = mutatedProject.current;
      if (message.includes('No conversation found with session ID') && resumeSessionId) {
        if (hasMutatedProject) {
          break;
        }
        resumeSessionId = '';
        await touchAgentSession(sessionId, {
          memory: {
            ...(sessionDetail.memory || {}),
            claude_sdk_session_id: '',
            last_agent_model: candidate.model,
            last_agent_key_hash: candidate.keyHash
          }
        });
        continue;
      }
      markGlmCandidateFailure(candidate, error);
      if (hasMutatedProject && appliedChanges.length && (isStallLikeError(error) || isAssembleReviewFailure(error))) {
        const actualProvider = String(candidate.provider || '').trim();
        const fallbackRun =
          requestedProvider.toLowerCase() !== actualProvider.toLowerCase() ||
          requestedModel !== String(candidate.model || '').trim();
        const reply = normalizedMode === 'assemble_script'
          ? buildAssembleRecoveryReply(appliedChanges, String(error?.message || '模型收尾阶段不稳定'))
          : buildAssistantReply('', appliedChanges, { mode: normalizedMode });
        const review = normalizedMode === 'assemble_script'
          ? buildAssembleReviewResult(reply, {
              synthesized: true,
              recoveryReason: String(error?.message || 'assemble-review-recovery')
            })
          : null;
        const result = {
          reply,
          summary: `${getPrimaryAppliedSummary(appliedChanges) || '已完成本次项目修改。'}（模型收尾阶段不稳定，已按实际工具结果保底收尾）`,
          review,
          applied_changes: appliedChanges,
          actual_model: candidate.model,
          actual_provider: actualProvider,
          fallback_run: fallbackRun,
          recovered_from_stall: isStallLikeError(error),
          recovered_from_review_failure: isAssembleReviewFailure(error)
        };

        await updateAgentRunRecord(runId, {
          status: 'completed',
          result,
          requiresConfirmation: false,
          appliedChanges,
          finished: true
        });
        await appendAgentMessage({
          sessionId,
          runId,
          role: 'assistant',
          content: reply,
          metadata: {
            status: 'completed',
            model: candidate.model,
            provider: actualProvider,
            fallback_run: fallbackRun,
            recovered_from_stall: isStallLikeError(error),
            recovered_from_review_failure: isAssembleReviewFailure(error)
          }
        });
        await emit({
          type: 'complete',
          step: 'complete',
          message: '本次 Agent 执行已完成（模型收尾阶段不稳定，已按工具结果保底收尾）。',
          payload: {
            model: candidate.model,
            provider: actualProvider,
            fallback_run: fallbackRun,
            recovered_from_stall: isStallLikeError(error),
            recovered_from_review_failure: isAssembleReviewFailure(error)
          }
        });

        return {
          success: true,
          run_id: runId,
          status: 'completed',
          reply,
          applied_changes: appliedChanges,
          review,
          model: candidate.model,
          actual_model: candidate.model,
          actual_provider: actualProvider,
          fallback_run: fallbackRun,
          recovered_from_stall: isStallLikeError(error),
          recovered_from_review_failure: isAssembleReviewFailure(error)
        };
      }
      if (String(error?.name || '') === 'AbortError' || String(error?.message || '').toLowerCase().includes('cancel')) {
        throw error;
      }
      if (hasMutatedProject) {
        break;
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (inactivityId) clearTimeout(inactivityId);
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      try { closeCurrentStream(); } catch {}
    }
  }

  throw lastError || new Error('Claude Agent SDK run failed');
}
