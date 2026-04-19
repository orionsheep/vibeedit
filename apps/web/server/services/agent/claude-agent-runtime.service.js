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
  classifyProjectAgentRequest
} from './project-agent-intent.service.js';
import {
  appendAgentEvent,
  appendAgentMessage,
  getProjectAgentSession,
  touchAgentSession,
  updateAgentRunRecord
} from './agent-session.service.js';

const SUPPORTED_PROJECT_AGENT_MODES = new Set(['custom', 'assemble_script', 'live_slicing']);
const MEMORY_PROFILES = {
  standard: {
    summaryChars: 1200,
    recentMessageChars: 360,
    recentMessageCount: 8,
    recentTotalChars: 2600
  },
  compact: {
    summaryChars: 420,
    recentMessageChars: 180,
    recentMessageCount: 4,
    recentTotalChars: 900
  }
};

function loadClaudeMdInstructions() {
  try {
    const filePath = path.join(getProjectRoot(), '.autoedit', 'CLAUDE.md');
    if (!fs.existsSync(filePath)) return '';
    return String(fs.readFileSync(filePath, 'utf-8') || '').trim();
  } catch {
    return '';
  }
}

function normalizeMemoryText(text = '') {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .trim();
}

function stripMarkdownForMemory(text = '') {
  return normalizeMemoryText(text)
    .replace(/```[\s\S]*?```/g, ' [代码块已省略] ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\|.*\|$/gm, ' [表格行已省略] ')
    .replace(/^\s*[-*_]{3,}\s*$/gm, ' ')
    .replace(/\n{2,}/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateMemoryText(text = '', maxChars = 240) {
  const normalized = String(text || '').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

function compressSessionMessage(message = {}, { profile = 'standard' } = {}) {
  const limits = MEMORY_PROFILES[profile] || MEMORY_PROFILES.standard;
  const prefix = message.role === 'assistant' ? 'Agent' : '用户';
  const content = truncateMemoryText(stripMarkdownForMemory(message.content), limits.recentMessageChars);
  return content ? `${prefix}: ${content}` : '';
}

function shouldCompactConversationMemory(sessionDetail, { mode = 'custom' } = {}) {
  const summaryChars = String(sessionDetail?.summary || '').length;
  const messages = Array.isArray(sessionDetail?.messages) ? sessionDetail.messages : [];
  const totalChars = summaryChars + messages.reduce((sum, message) => sum + String(message?.content || '').length, 0);
  const hasHugeMessage = messages.some((message) => String(message?.content || '').length > 4200);
  if (summaryChars > 3200) return true;
  if (messages.length > 28) return true;
  if (totalChars > 14000) return true;
  if (hasHugeMessage) return true;
  return String(mode || '').trim() === 'live_slicing' && totalChars > 18000;
}

function isPromptTooLongError(error) {
  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('prompt is too long') ||
    message.includes('context length') ||
    message.includes('maximum context') ||
    message.includes('too many tokens')
  );
}

function buildSystemPrompt({
  mode = 'custom',
  preferencePrompt = '',
  assembleRetryPass = false,
  pauseOnlyRequest = false,
  requestProfile = null
} = {}) {
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
        '在你读完整个脚本块和字幕块之后，必须再调用一次 get_assemble_candidates 复查重复 take / 重复句候选；尤其是空白项目、初次拼稿或用户要求压时长时，不能跳过这一步。',
        '优先一次性读取完整脚本块和完整字幕块，再尽量用少量、成组的删改工具完成修改；不要删一点就反复回头分页检查，除非你明确需要验证结果。',
        '默认高保留率，主要删除重复 take、明显重复句、口头禅和停顿；不要为了“更顺”而重写表达。',
        pauseOnlyRequest
          ? '当前这轮用户主要是在清理停顿/间隙，不是在重做拼稿。除非是极少量独立口头禅，否则不要删除整句、整段或重复块；优先只做 gap 清理。'
          : '删除整句、半句、重复 take、重复表达时，优先使用 delete_subtitle_blocks / restore_subtitle_blocks 做块级删改；不要为了省事在句子中间掏词。',
        'delete_words_by_phrase / restore_words_by_phrase 只用于独立短口头禅和语气词，例如“嗯”“啊”“呃”“就是”“那个”；不允许用它删除句中实词、主谓宾、连接逻辑或半句结构。',
        '如果用户要求去口气词、口头禅、停顿、间隙或压紧节奏，你必须真正调用 delete_words_by_phrase、delete_subtitle_blocks、get_pause_candidates、remove_pauses 等工具落地，而不是只在总结里声称处理过。',
        '处理停顿时，必须先读 get_pause_candidates 或 get_assemble_candidates 里的停顿候选；口播拼稿里，remove_pauses 默认应传 gap_keys 做 3-8 个间隙的小批量定点删除，不要用 2 秒/3 秒阈值整批扫停顿。',
        '参考成熟人工剪法：先删整块重复，再分两到三轮切掉 0.35-1.2 秒的明显间隙；如果拿不准，就宁可少删一轮，也不要整段硬砍。',
        '好的口播成片应尽量保持句义单元完整，主要通过删除重复块和 gap 来压紧节奏，而不是在句子中间抠几个字假装顺畅。',
        '即使用户没有单独强调停顿，口播拼稿在完成主要语义删减后，也必须检查一次当前结果里是否还残留明显长停顿；若有，就调用 remove_pauses 做收尾清理，并确认 deleted_gap_count 真的增加。',
        '在你认为编辑完成后，必须做一次强制自我审查，而且不能只凭记忆判断；必须再次调用 get_script_blocks、必要时再调用 get_subtitle_blocks / get_timeline_detail，基于最新结果逐项复查。',
        '自我审查必须逐项检查这 8 点：1. 顺序是否正确；如果本轮涉及调序，必须确认只改了素材之间的顺序，没有改单个素材内部顺序；2. 句子是否通顺；3. 逻辑是否完整；4. 断句和衔接是否自然；5. 是否仍残留重复 take 或重复句；6. 停顿、口气词、口头禅是否真的去掉；7. 是否误删关键内容；8. 是否还存在一到两处明显可改进点。',
        '只要这 8 项里有任意一项不通过，就继续调用工具修正，直到全部通过后才能结束。',
        '最终回复里，必须用简短清单汇报这 8 项的检查结果与修正结论，不能只给一句笼统总结；如果没有这 8 项清单，就不算完成。',
        assembleRetryPass
          ? '这是一次强制重试：上一轮没有真正改到项目或没有完成自审清单。你这次必须自己读完整个当前口播稿，随后强制调用一次 get_assemble_candidates，必要时再读 get_pause_candidates，然后调用删除/恢复/去停顿工具完成实际修改。不要停在总结。'
          : ''
      ].join('\n')
    : normalizedMode === 'live_slicing'
      ? [
          '你现在执行的是一个完整的 Claude Code skill：直播切片。',
          '目标不是继续在主时间线上抠字，而是围绕整条长视频，分析内容结构，产出多个可独立导出的小视频切片。',
          '直播切片模式下，优先使用切片相关工具读取、建议、创建、更新和删除切片；不要默认去改当前主时间线。',
          '切片的本质是“母片上的若干时间范围”，所以先理解全文，再决定哪些段落值得单独成片。',
          '如果用户还没明确给出题材方向、条数、时长或风格，你可以先读完整脚本块，再主动提出候选方案或反问约束。',
          '若用户要求“先给候选”，优先调用 suggest_project_slices，不要直接创建切片。',
          '若用户要求“直接生成”“就按这个主题切几条”，再调用 create_project_slice 落地。',
          '直播切片模式下允许只做分析和建议，不要求每轮都创建切片；但只要用户明确要求生成、更新或删除切片，就必须真实调用切片工具。',
          '不要把直播切片做成“随机截几段”。候选应尽量基于完整表达单元、相对独立主题、高潮观点或信息密度高的连续片段。',
          '如果用户要求查看某个切片的正文、总结、时长或范围，应优先调用 list_project_slices / get_project_slice_detail，再据实回答。',
          '除非用户明确要求，否则不要顺手删主时间线的字、停顿或片段；直播切片和口播拼稿是同一个 Agent 的两种技能，不要混用目标。'
        ].join('\n')
      : [
        '你现在处于自由指令模式，它是一个全能的 Claude Code 项目助理，不只是剪辑流水线触发器。',
        '如果用户是在问普通问题，且不需要项目上下文，直接回答即可；不要为了调用工具而调用工具。',
        '如果用户是在问当前项目、当前时间线、当前字幕、剪辑后逐字稿或当前成片状态，你应先读取必要工具，再给出准确答案；这种读取/分析型请求默认不要改动项目。',
        '如果用户明确要求修改项目、导出、保存快照或执行某个工具目标，你再调用工具落地，并且只做用户明确要求的变更。',
        '当用户要“剪辑后的逐字稿 / 最终稿 / 当前字幕全文”时，优先读取 get_script_blocks 的当前完整脚本；只有在确实需要逐句核对时，再补读 get_subtitle_blocks。',
        '当用户只是在问“删了什么 / 剩下什么 / 当前版本怎么样”，优先读取 get_project_context、get_timeline_detail、get_script_blocks 等只读工具，不要把问题误当成继续剪辑。',
        '只有明确编辑请求才需要修改时间线；读取、解释、总结、问答和项目分析不要求产生任何实际改动。',
        requestProfile?.requiresMutation
          ? '若本轮属于写操作，完成前仍需重新读取结果自查，确认顺序、通顺、逻辑和误删风险没有被破坏。'
          : '若本轮属于只读或问答请求，不要为了凑“完成感”去修改项目。'
      ].join('\n');

  return [
    '你是 AutoEdit 的项目级 Claude Code Agent。',
    '你只能通过提供的 MCP 工具修改项目，不能凭空声称已经完成操作。',
    '你拥有当前项目全部可用工具的直接操作权，可以自行决定调用哪些工具完成任务。',
    '模式只决定当前任务目标和编辑偏好，不会限制你的工具权限；无论是口播拼稿、直播切片还是自由指令，你都可以自由选择任意项目工具。',
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

function buildConversationMemory(sessionDetail, { profile = 'standard' } = {}) {
  const limits = MEMORY_PROFILES[profile] || MEMORY_PROFILES.standard;
  const summary = truncateMemoryText(stripMarkdownForMemory(sessionDetail?.summary), limits.summaryChars);
  const recentMessages = (sessionDetail?.messages || [])
    .slice(-18)
    .reverse()
    .reduce((accumulator, message) => {
      if (accumulator.length >= limits.recentMessageCount) {
        return accumulator;
      }
      const compressed = compressSessionMessage(message, { profile });
      if (!compressed) return accumulator;
      const usedChars = accumulator.reduce((sum, item) => sum + item.length, 0);
      if (usedChars + compressed.length > limits.recentTotalChars) {
        return accumulator;
      }
      accumulator.push(compressed);
      return accumulator;
    }, [])
    .reverse();

  return [
    summary ? `会话摘要：\n${summary}` : '',
    recentMessages.length ? `最近对话：\n${recentMessages.join('\n')}` : ''
  ].filter(Boolean).join('\n\n');
}

function buildUserPrompt({
  mode = 'custom',
  prompt = '',
  topic = '',
  targetMinutes = 0,
  sessionDetail = null,
  assembleRetryPass = false,
  pauseOnlyRequest = false,
  requestProfile = null,
  memoryProfile = 'standard'
}) {
  const lines = [];
  lines.push(`当前模式：${mode}`);
  if (topic) lines.push(`主题：${topic}`);
  if (Number(targetMinutes || 0) > 0) lines.push(`目标分钟数：${Number(targetMinutes)}`);
  lines.push(`用户要求：${String(prompt || '').trim() || `执行 ${mode}`}`);
  const memoryText = buildConversationMemory(sessionDetail, { profile: memoryProfile });
  if (memoryText) lines.push(memoryText);
  if (pauseOnlyRequest) {
    lines.push('这轮目标只是在当前结果上清理停顿/间隙并少量清理独立口头禅，不要顺手删整句、删整段、去重整块或重做口播结构。');
  }
  if (String(mode || '').trim() === 'assemble_script') {
    lines.push('请先理解需求，再通过工具完成修改。读操作不要过度扫描；写操作必须真实改动项目。默认是在当前已剪结果上继续局部修改，不要重来，也不要恢复完整项目，除非用户明确要求。默认保持当前顺序，不要擅自重排。当前网站没有正式的字词润色能力，所以不要改写原句；默认只做删除、恢复、去停顿和项目级管理。若用户明确要求改顺序，也只允许调整整段素材 / 整个文件之间的顺序，不要改单个视频素材内部的句子顺序、片段顺序或表达顺序。口播拼稿时不要凭几句样本或候选摘要就开始删减，必须先自己读到足够完整的当前脚本块和字幕块后再动手；如果 get_script_blocks / get_subtitle_blocks 没有限制参数，默认会直接给你全量，请优先这样读完整上下文。读完整脚本块和字幕块后，必须再调用一次 get_assemble_candidates 复查重复 take / 重复句候选，决定 no-op 前不能跳过这一步。处理停顿、间隙、节奏时，必须先调用 get_pause_candidates 或直接读取 get_assemble_candidates 里的停顿候选，再把具体 gap_keys 传给 remove_pauses 做 3-8 个间隙的小批量定点删除；不要只靠一句“我已经删了停顿”就结束，也不要用 2 秒/3 秒大阈值整批扫。参考成熟人工剪法：先删块级重复，再分两到三轮清掉 0.35-1.2 秒的明显间隙。删整句、半句、重复 take、重复表达时优先用 delete_subtitle_blocks；delete_words_by_phrase 只允许删独立短口头禅和语气词，不允许在句子中间掏词。若用户要求去口气词、去口头禅、去停顿、删间隙或压紧节奏，必须真正调用对应工具落地；即使用户没特别强调停顿，也要在语义删减后检查一次是否还残留明显长停顿，并按需调用 remove_pauses 收尾，确认 deleted_gap_count 真的增加。工具执行完成后，不要立即结束；必须重新读取当前结果做一轮强制自我审查，并逐项检查这 8 项：顺序、通顺、逻辑完整、断句衔接、重复残留、停顿/口气词处理、误删关键内容、是否还有明显可改进点；如果本轮涉及调序，还必须确认只改了素材之间的顺序，没有改单素材内部顺序。只要任一项不通过，就继续修正。最终回复里必须清楚包含这 8 项检查结论。');
  } else if (String(mode || '').trim() === 'live_slicing') {
    lines.push('这是一条直播切片请求。优先围绕整条长视频生成、读取或管理多个切片，不要默认去改主时间线。若用户只是想先看候选或先分析全文，可以只调用只读和建议类切片工具；若用户明确要求生成切片，必须真实创建切片。回复时优先给出清晰的候选标题、时长、主题和后续动作建议。');
  } else if (requestProfile?.explicitReadOnlyProjectQuery) {
    lines.push('这是一条只读型项目请求：不要修改项目，不要删除或恢复任何内容。若用户要剪辑后的逐字稿、最终稿、当前字幕全文，优先调用 get_script_blocks 一次读完整当前脚本，再直接输出。若用户要知道当前删了什么、剩下什么或当前版本状态，优先调用 get_project_context、get_timeline_detail、必要时补充 get_script_blocks，再据实回答。');
  } else if (requestProfile?.requiresMutation) {
    lines.push('这是一条自定义项目操作请求：需要通过工具真实落地，但只做用户明确要求的动作。默认保持当前结果和当前顺序，不要顺手重做整版，也不要扩展成口播拼稿。完成后请简要说明做了什么，并在必要时重新读取结果确认没有误伤。');
  } else {
    lines.push('这是一条普通问答或解释请求。如果不需要项目上下文，直接回答即可；不要为了调用工具而调用工具。如果你确实需要引用当前项目信息，再调用最少量的只读工具补充事实。');
  }
  if (assembleRetryPass && String(mode || '').trim() === 'assemble_script') {
    lines.push('上一轮没有真正修改项目或没有完成自审清单。这一轮禁止只读取候选摘要后结束，必须自己读完整脚本块、读完整字幕块，再调用一次 get_assemble_candidates，然后真正调用删改工具。');
  }
  return lines.join('\n');
}

function getPrimaryAppliedSummary(appliedChanges = []) {
  const primaryChange = [...appliedChanges].reverse().find((change) => didChangeApply(change)) || appliedChanges[appliedChanges.length - 1];
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
  const tools = appliedChanges
    .filter((change) => didChangeApply(change))
    .map((change) => String(change?.tool || '').trim())
    .filter(Boolean);
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

function didChangeApply(change = {}) {
  return change?.success !== false && change?.changed !== false;
}

function isMutatingChange(change = {}) {
  const tool = String(change.tool || change.change || change.type || '').trim();
  return didChangeApply(change) && new Set([
    'delete_subtitle_blocks',
    'restore_subtitle_blocks',
    'create_project_slice',
    'update_project_slice',
    'delete_project_slice',
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
  return didChangeApply(change) && new Set([
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

function requestExplicitPauseCleanup({ prompt = '', topic = '' } = {}) {
  const text = `${String(prompt || '').trim()} ${String(topic || '').trim()}`.toLowerCase();
  if (!text) return false;
  const mentionsPause = /(停顿|间隙|空白|节奏)/.test(text);
  const mentionsCleanup = /(删|删除|去掉|切掉|清理|压紧|收紧|去除|处理)/.test(text);
  return mentionsPause && mentionsCleanup;
}

function requestIsPauseOnly({ prompt = '', topic = '' } = {}) {
  if (!requestExplicitPauseCleanup({ prompt, topic })) return false;
  const text = `${String(prompt || '').trim()} ${String(topic || '').trim()}`.toLowerCase();
  return !/(拼稿|去重|重复|重做|重剪|精简内容|删整句|删整段|大幅删减|压缩时长|目标分钟|整理口播|多版本)/.test(text);
}

function hasAppliedPauseCleanup(appliedChanges = []) {
  return appliedChanges.some((change) => (
    didChangeApply(change) &&
    String(change.tool || change.change || '').trim() === 'remove_pauses' &&
    Number(change.deleted_gap_count || 0) > 0
  ));
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
    '如果当前任务包含“删停顿 / 删间隙 / 压紧节奏”，必须确认本轮真的通过 remove_pauses 切掉了 gap，而不是只删了字词。',
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
  approvedHighRisk = true,
  persistAssistantMessage = true,
  forceCompactContext = false
}) {
  const requestProfile = classifyProjectAgentRequest({ mode, prompt, topic, targetMinutes });
  const normalizedMode = requestProfile.effectiveMode;
  if (!SUPPORTED_PROJECT_AGENT_MODES.has(normalizedMode)) {
    throw new Error(`Unsupported project agent mode: ${normalizedMode}. Only custom, assemble_script and live_slicing are supported.`);
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
  const pauseOnlyRequest = requestIsPauseOnly({ prompt, topic });
  let bumpProgress = () => {};
  const shouldPreemptivelyCompactContext = shouldCompactConversationMemory(sessionDetail, { mode: normalizedMode });
  const autoCompactContext = forceCompactContext || shouldPreemptivelyCompactContext;
  const memoryProfile = autoCompactContext ? 'compact' : 'standard';

  if (autoCompactContext && resumeSessionId) {
    resumeSessionId = '';
    await touchAgentSession(sessionId, {
      memory: {
        ...(sessionDetail.memory || {}),
        claude_sdk_session_id: ''
      }
    });
  }

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
    let claudeSessionId = assembleRetryPass || autoCompactContext ? '' : resumeSessionId;
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
          systemPrompt: buildSystemPrompt({ mode: normalizedMode, preferencePrompt, assembleRetryPass, pauseOnlyRequest, requestProfile }),
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
        if (autoCompactContext) {
          await emit({
            type: 'stage',
            step: 'context_compacted',
            message: forceCompactContext
              ? '检测到上下文过长，已自动压缩会话历史并从精简上下文重新执行。'
              : '当前会话历史较长，已自动启用精简上下文，避免模型提示词过长。',
            payload: {
              force_compacted: Boolean(forceCompactContext),
              message_count: Array.isArray(sessionDetail?.messages) ? sessionDetail.messages.length : 0,
              summary_chars: String(sessionDetail?.summary || '').length
            }
          });
        }
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
          prompt: buildUserPrompt({ mode: normalizedMode, prompt, topic, targetMinutes, sessionDetail, assembleRetryPass, pauseOnlyRequest, requestProfile, memoryProfile }),
          options: {
            cwd: getProjectRoot(),
            permissionMode: 'bypassPermissions',
            tools: [],
            model: candidate.model,
            maxTurns: 120,
            resume: claudeSessionId || undefined,
            abortController,
            systemPrompt: buildSystemPrompt({ mode: normalizedMode, preferencePrompt, assembleRetryPass, pauseOnlyRequest, requestProfile }),
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
          if (persistAssistantMessage) {
            await appendAgentMessage({
              sessionId,
              runId,
              role: 'assistant',
              content: reply,
              metadata: {
                status: 'waiting_confirmation'
              }
            });
          }
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
        const requiresToolUse = requestProfile.requiresToolUse;
        const requiresMutation = requestProfile.requiresMutation;
        const requiresPauseCleanup = requestExplicitPauseCleanup({ prompt, topic });
        const pauseOnlyCleanup = requestIsPauseOnly({ prompt, topic });
        if (requiresToolUse && !appliedChanges.length) {
          throw new Error('本次 Agent 没有真正调用需要的工具，请重试。');
        }
        const mutationSatisfied = normalizedMode === 'assemble_script'
          ? appliedChanges.some(isTimelineEditingChange)
          : appliedChanges.some(isMutatingChange);
        if (requiresMutation && !mutationSatisfied) {
          throw new Error('本次 Agent 没有产生任何实际修改，请重试或换更明确的指令。');
        }
        if (requiresPauseCleanup && !hasAppliedPauseCleanup(appliedChanges)) {
          throw new Error('本次请求明确要求处理停顿/间隙，但 Agent 没有真正切掉任何 gap。请先读取停顿候选，再用 gap_keys 定点调用 remove_pauses。');
        }
        if (pauseOnlyCleanup && appliedChanges.some((change) => (
          didChangeApply(change) &&
          ['delete_subtitle_blocks', 'restore_subtitle_blocks', 'remove_project_asset', 'reorder_project_assets', 'clear_deleted'].includes(String(change.tool || change.change || '').trim())
        ))) {
          throw new Error('本轮请求只要求清理停顿/间隙，不应删除整句或整段内容。请仅使用停顿候选和定点 gap 删除，必要时最多只清理独立口头禅。');
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
        if (persistAssistantMessage) {
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
        }
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
      if (isPromptTooLongError(error) && !hasMutatedProject) {
        throw error;
      }
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
        if (persistAssistantMessage) {
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
        }
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
