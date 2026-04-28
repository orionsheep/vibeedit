import fs from 'fs';
import path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  appendAgentEvent,
  appendAgentMessage,
  createAgentRunRecord,
  getAgentRunRecord,
  getProjectAgentSession,
  touchAgentSession,
  updateAgentRunRecord
} from './agent-session.service.js';
import { runClaudeAgentSession } from './claude-agent-runtime.service.js';
import {
  getHealthyGlmCandidate,
  markGlmCandidateFailure,
  markGlmCandidateHealthy,
  getProjectAgentModel,
  getProjectAgentProvider
} from './glm-claude-rotation.service.js';
import {
  classifyProjectAgentRequest,
  normalizeProjectAgentMode
} from './project-agent-intent.service.js';
import { buildClaudeSdkPermissionOptions } from './claude-agent-permissions.service.js';
import { executeProjectAgentToolDirect } from './claude-agent-mcp.service.js';
import { getProjectRoot } from '../editor/config.js';
import { getAgentLlmSettings } from '../editor/llm.service.js';
import { getProjectTimeline } from '../projects/timeline.service.js';
import { getProjectEditState } from '../projects/project-edit-state.service.js';
import { getProjectById } from '../projects/project.service.js';

const activeRunAbortControllers = new Map();
const cancellationRequestedRuns = new Set();

class AgentRunCancelledError extends Error {
  constructor(message = 'Agent run cancelled') {
    super(message);
    this.name = 'AgentRunCancelledError';
  }
}

function normalizeSessionText(text = '') {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .trim();
}

function stripMarkdownForSessionSummary(text = '') {
  return normalizeSessionText(text)
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

function truncateSessionSummary(text = '', maxChars = 220) {
  const normalized = String(text || '').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

function summarizeTimelineSignature(timeline = null) {
  const clips = Array.isArray(timeline?.clips) ? timeline.clips : [];
  return JSON.stringify({
    clip_count: clips.length,
    total_duration: Number(timeline?.total_duration || 0),
    clips: clips.map((clip) => [
      String(clip.asset_id || ''),
      Number(clip.source_start || 0),
      Number(clip.source_end || 0),
      Number(clip.timeline_start || 0),
      Number(clip.timeline_end || 0),
      Number(clip.sort_order || 0),
      String(clip.label || '')
    ])
  });
}

async function readProjectMutationSignature(projectId) {
  const [timeline, editState, project] = await Promise.all([
    getProjectTimeline(projectId),
    getProjectEditState(projectId),
    getProjectById(projectId)
  ]);
  const sliceSignature = (project?.timelines || [])
    .filter((item) => String(item.kind || '') === 'slice')
    .map((item) => [
      String(item.id || ''),
      String(item.title || item.name || ''),
      String(item.color || ''),
      Number(item.clip_count || 0),
      Number(item.total_duration || 0)
    ]);
  return JSON.stringify({
    timeline: JSON.parse(summarizeTimelineSignature(timeline)),
    slices: sliceSignature,
    edit_state_version: Number(editState?.version || 0),
    deleted_word_count: Array.isArray(editState?.deleted_word_keys) ? editState.deleted_word_keys.length : 0,
    deleted_gap_count: Array.isArray(editState?.deleted_gap_keys) ? editState.deleted_gap_keys.length : 0
  });
}

function mergeSessionSummary(previousSummary, userMessage, assistantReply, appliedChanges = []) {
  const previousLines = normalizeSessionText(previousSummary)
    .split('\n')
    .map((line) => truncateSessionSummary(stripMarkdownForSessionSummary(line), 240))
    .filter(Boolean)
    .slice(-5);
  const actionSummary = appliedChanges.length
    ? truncateSessionSummary(appliedChanges.map((item) => item.change || item.type || '修改').join('、'), 100)
    : '';
  const mergedLine = [
    `用户:${truncateSessionSummary(stripMarkdownForSessionSummary(userMessage), 120)}`,
    actionSummary ? `动作:${actionSummary}` : '',
    `结果:${truncateSessionSummary(stripMarkdownForSessionSummary(assistantReply), 220)}`
  ].filter(Boolean).join(' | ');
  return [...previousLines, mergedLine].slice(-6).join('\n');
}

async function appendAcceptedAssistantReply({ sessionId, runId, reply, run = null }) {
  const content = String(reply || '').trim();
  if (!content) return null;
  const result = run?.result || {};
  return appendAgentMessage({
    sessionId,
    runId,
    role: 'assistant',
    content,
    metadata: {
      status: String(run?.status || 'completed'),
      model: result.actual_model || run?.model || null,
      provider: result.actual_provider || run?.provider || null,
      fallback_run: Boolean(result.fallback_run),
      noop: Boolean(result.noop),
      recovered_from_stall: Boolean(result.recovered_from_stall),
      recovered_from_review_failure: Boolean(result.recovered_from_review_failure)
    }
  });
}

async function finalizeCancelledRun(projectId, sessionId, runId, message = '已停止本次 Agent 执行，当前项目保持在停止前的状态。') {
  const run = await getAgentRunRecord(projectId, runId);
  if (!run) {
    return {
      success: true,
      status: 'cancelled',
      run_id: runId
    };
  }

  const alreadyFinal = ['cancelled', 'completed', 'failed'].includes(String(run.status || ''));
  if (alreadyFinal) {
    return {
      success: true,
      status: run.status,
      run_id: runId,
      result: run.result || null
    };
  }

  await updateAgentRunRecord(runId, {
    status: 'cancelled',
    result: {
      ...(run.result || {}),
      reply: message,
      summary: message
    },
    requiresConfirmation: false,
    finished: true
  });
  await appendAgentEvent({
    sessionId,
    runId,
    type: 'cancelled',
    step: 'cancel',
    message,
    payload: {}
  });
  await appendAgentMessage({
    sessionId,
    runId,
    role: 'assistant',
    content: message,
    metadata: {
      status: 'cancelled'
    }
  });

  return {
    success: true,
    status: 'cancelled',
    run_id: runId,
    reply: message
  };
}

function resultRequiresMutation(mode, result = {}) {
  if (mode === 'assemble_script') return true;
  const changes = Array.isArray(result?.applied_changes) ? result.applied_changes : [];
  return changes.some((change) => {
    const tool = String(change?.tool || change?.change || change?.type || '').trim();
    return Boolean(
      change?.mutates_project ||
      change?.timeline ||
      change?.removed_asset_title ||
      change?.reordered_asset_titles ||
      change?.replacement_text ||
      ['create_project_slice', 'update_project_slice', 'delete_project_slice'].includes(tool)
    );
  });
}

function isDirectDocumentOpenRequest({ prompt = '', topic = '' } = {}) {
  const text = `${String(prompt || '').trim()} ${String(topic || '').trim()}`.trim();
  if (!text) return false;
  if (/^(?:请)?(?:帮我)?(?:直接)?(?:打开|查看|显示|展开)(?:一下)?(?:当前|项目|切片|成片|最终)?(?:文稿|脚本|逐字稿|字幕稿|全文|全稿)$/i.test(text)) {
    return true;
  }
  return /(打开|查看|显示|展开)(?:一下)?(?:当前|项目|切片|成片|最终)?.{0,6}(文稿|脚本|逐字稿|字幕稿|全文|全稿)/i.test(text);
}

async function finalizeDirectDocumentOpenRun({
  session,
  sessionId,
  runId,
  userPrompt,
  mode = 'custom'
}) {
  const normalizedMode = String(mode || 'custom').trim();
  const reply = normalizedMode === 'live_slicing'
    ? '已为你打开当前切片文稿，可直接在文稿面板查看当前切片的段落内容。'
    : '已为你打开当前文稿，可直接在文稿面板查看当前成片内容。';
  const result = {
    reply,
    summary: reply,
    open_document_preview: true,
    document_scope: normalizedMode === 'live_slicing' ? 'slice' : 'master',
    applied_changes: []
  };

  await updateAgentRunRecord(runId, {
    status: 'completed',
    result,
    requiresConfirmation: false,
    appliedChanges: [],
    finished: true
  });
  await appendAgentEvent({
    sessionId,
    runId,
    type: 'complete',
    step: 'open_document_preview',
    message: normalizedMode === 'live_slicing'
      ? '已准备好当前切片文稿预览。'
      : '已准备好当前文稿预览。',
    payload: {
      open_document_preview: true,
      document_scope: result.document_scope
    }
  });
  await appendAgentMessage({
    sessionId,
    runId,
    role: 'assistant',
    content: reply,
    metadata: {
      status: 'completed',
      open_document_preview: true,
      document_scope: result.document_scope
    }
  });
  await touchAgentSession(sessionId, {
    summary: mergeSessionSummary(session.summary, userPrompt, reply, [])
  });

  return {
    success: true,
    session_id: sessionId,
    run_id: runId,
    reply,
    status: 'completed',
    requires_confirmation: false,
    applied_changes: [],
    open_document_preview: true,
    document_scope: result.document_scope,
    result
  };
}

async function appendAndEmitAgentEvent(onEvent, event) {
  const appended = await appendAgentEvent(event);
  if (typeof onEvent === 'function') {
    onEvent(appended);
  }
  return appended;
}

function buildRoutingMessage(requestProfile = {}) {
  if (requestProfile.routingReason === 'assemble_script_intent') {
    return '检测到口播剪辑意图，已自动切换到口播拼稿主链。';
  }
  if (requestProfile.routingReason === 'generic_recut_current_timeline') {
    return '检测到这是对当前成片的重切反馈，已从切片模式切回口播拼稿主链。';
  }
  if (requestProfile.routingReason === 'live_slicing_intent') {
    return '检测到直播切片意图，已自动切换到直播切片模式。';
  }
  if (requestProfile.routingReason === 'read_only_project_query') {
    return '检测到当前请求是读取/分析型项目问题，已切换到自由指令只读模式，不会强行改时间线。';
  }
  if (requestProfile.routingReason === 'non_assemble_project_task') {
    return '检测到当前请求不是口播拼稿，而是通用项目任务，已切换到自由指令模式处理。';
  }
  return '检测到当前请求不是剪辑改动任务，已切换到自由指令模式处理。';
}

function buildConservativeAssembleArgs() {
  return {
    take_limit: 12,
    block_limit: 10,
    sentence_limit: 14,
    pause_limit: 12,
    min_pause_seconds: 0.35,
    max_passes: 1,
    take_window_limit: 360
  };
}

function isLongAssembleProjectContext(context = {}) {
  const keptWordCount = Number(context.kept_word_count || context.total_word_count || 0);
  const clipCount = Number(context.clip_count || 0);
  const durationSeconds = Number(context.current_cut_duration_seconds || 0);
  return keptWordCount >= 12000 || clipCount >= 300 || durationSeconds >= 1800;
}

function summarizeAssemblePlanInputs({ context = {}, assembleCandidates = null, pauseCandidates = null } = {}) {
  const pauseList = Array.isArray(pauseCandidates?.candidates)
    ? pauseCandidates.candidates
    : Array.isArray(assembleCandidates?.pause_candidates)
      ? assembleCandidates.pause_candidates
      : [];
  return {
    project_name: String(context.project_name || '').trim(),
    asset_count: Number(context.asset_count || 0),
    clip_count: Number(context.clip_count || 0),
    kept_word_count: Number(context.kept_word_count || 0),
    total_word_count: Number(context.total_word_count || 0),
    current_cut_duration_seconds: Number(context.current_cut_duration_seconds || 0),
    take_group_count: Number(assembleCandidates?.take_group_count || 0),
    block_group_count: Number(assembleCandidates?.block_group_count || 0),
    sentence_group_count: Number(assembleCandidates?.sentence_group_count || 0),
    restart_fragment_count: Number(assembleCandidates?.restart_fragment_count || 0),
    pause_candidate_count: Number(pauseCandidates?.total || assembleCandidates?.pause_candidate_count || pauseList.length || 0),
    recommended_pause_candidate_count: Number(
      pauseCandidates?.recommended_count ||
      assembleCandidates?.recommended_pause_candidate_count ||
      pauseList.filter((candidate) => candidate?.recommended).length ||
      0
    )
  };
}

function buildAssemblePlanConfirmationPrompt({
  context = {},
  assembleCandidates = null,
  pauseCandidates = null,
  longProject = false,
  genericRecutFeedback = false
} = {}) {
  const summary = summarizeAssemblePlanInputs({ context, assembleCandidates, pauseCandidates });
  const durationText = summary.current_cut_duration_seconds
    ? `${formatPlannerTime(summary.current_cut_duration_seconds)}s`
    : String(context.current_cut_duration || context.total_duration || '未知');
  const candidateLine = assembleCandidates
    ? `候选扫描：重复 take ${summary.take_group_count} 组、重复段落 ${summary.block_group_count} 组、重复句 ${summary.sentence_group_count} 组、起手重说 ${summary.restart_fragment_count} 个、明显停顿 ${summary.pause_candidate_count} 个。`
    : `停顿快扫：明显停顿 ${summary.pause_candidate_count} 个，其中推荐优先处理 ${summary.recommended_pause_candidate_count} 个。`;
  const reason = longProject
    ? '这个项目属于长视频/长时间线，直接让模型长上下文重试容易不稳定。'
    : genericRecutFeedback
      ? '你这次是在反馈当前成片“切得不够好”，更适合先给出可确认的保守重切计划。'
      : '这次会改动当前时间线，需要先确认执行。';

  return [
    `${reason}我已先做只读预检查，暂时没有修改项目。`,
    '',
    `当前概况：${summary.asset_count} 个素材，${summary.clip_count} 个时间线片段，当前成片约 ${durationText}，保留 ${summary.kept_word_count}/${summary.total_word_count} 个字。`,
    candidateLine,
    '',
    '确认后我会先保存快照，然后执行一轮保守重切：清理明显重复 take、重复句、起手重说碎片和推荐停顿；本轮不改写原文、不做直播切片、不主动重排素材顺序。',
    '执行完成后会重新输出顺序、通顺、逻辑、断句、重复、停顿、误删和改进点这 8 项自审。'
  ].join('\n');
}

async function maybeCreateAssemblePlanConfirmation({
  projectId,
  session,
  sessionId,
  run,
  userPrompt,
  requestedMode = 'custom',
  requestedProvider = '',
  requestedModel = '',
  requestProfile = {},
  onEvent = () => {}
}) {
  if (requestProfile.effectiveMode !== 'assemble_script' || !requestProfile.requiresMutation) {
    return null;
  }

  const toolContext = {
    llmProvider: requestedProvider,
    llmModel: requestedModel,
    requestContext: {
      mode: 'assemble_script',
      prompt: userPrompt,
      sessionId,
      runId: run.id
    }
  };

  let context = null;
  try {
    await appendAndEmitAgentEvent(onEvent, {
      sessionId,
      runId: run.id,
      type: 'stage',
      step: 'assemble_confirmation_context',
      message: '正在读取当前项目概况，判断是否需要先确认再重切。',
      payload: {}
    });
    context = await withTimeout(
      () => executeProjectAgentToolDirect(projectId, 'get_project_context', {}, toolContext),
      8000,
      'Assemble confirmation context timed out'
    );
  } catch (error) {
    await appendAndEmitAgentEvent(onEvent, {
      sessionId,
      runId: run.id,
      type: 'stage',
      step: 'assemble_confirmation_context_failed',
      message: `确认计划预检查失败，改用常规 Agent 流程：${String(error?.message || 'unknown error')}`,
      payload: {}
    });
    return null;
  }

  const longProject = isLongAssembleProjectContext(context);
  const genericRecutFeedback = Boolean(requestProfile.genericRecutFeedback);
  if (!longProject && !genericRecutFeedback) {
    return null;
  }

  if (requestedMode !== requestProfile.effectiveMode) {
    await appendAndEmitAgentEvent(onEvent, {
      sessionId,
      runId: run.id,
      type: 'stage',
      step: 'mode_routed',
      message: buildRoutingMessage(requestProfile),
      payload: {
        requested_mode: requestedMode,
        effective_mode: requestProfile.effectiveMode,
        routing_reason: requestProfile.routingReason || ''
      }
    });
  }

  await appendAndEmitAgentEvent(onEvent, {
    sessionId,
    runId: run.id,
    type: 'stage',
    step: 'assemble_confirmation_scan',
    message: longProject
      ? '项目较长，正在做轻量停顿快扫，避免长上下文模型重试。'
      : '正在扫描当前成片的重复和停顿候选，用于生成确认计划。',
    payload: {
      long_project: longProject,
      generic_recut_feedback: genericRecutFeedback
    }
  });

  let assembleCandidates = null;
  let pauseCandidates = null;
  try {
    if (longProject) {
      pauseCandidates = await withTimeout(
        () => executeProjectAgentToolDirect(projectId, 'get_pause_candidates', {
          min_gap_seconds: 0.35,
          limit: 24
        }, toolContext),
        10000,
        'Pause candidate scan timed out'
      );
    } else {
      assembleCandidates = await withTimeout(
        () => executeProjectAgentToolDirect(projectId, 'get_assemble_candidates', buildConservativeAssembleArgs(), toolContext),
        14000,
        'Assemble candidate scan timed out'
      );
    }
  } catch (error) {
    await appendAndEmitAgentEvent(onEvent, {
      sessionId,
      runId: run.id,
      type: 'stage',
      step: 'assemble_confirmation_scan_partial',
      message: `候选扫描未完整返回，仍会使用保守确认计划：${String(error?.message || 'unknown error')}`,
      payload: {
        long_project: longProject
      }
    });
  }

  const planSummary = summarizeAssemblePlanInputs({ context, assembleCandidates, pauseCandidates });
  const confirmationPrompt = buildAssemblePlanConfirmationPrompt({
    context,
    assembleCandidates,
    pauseCandidates,
    longProject,
    genericRecutFeedback
  });
  const pendingTool = {
    tool: 'auto_assemble_script',
    args: buildConservativeAssembleArgs(),
    pre_tools: [
      {
        tool: 'save_snapshot',
        args: {
          note: '确认执行口播重切前快照'
        }
      }
    ],
    plan_kind: 'assemble_recut_confirmation',
    plan_summary: planSummary
  };
  const result = {
    reply: confirmationPrompt,
    summary: '等待确认后执行保守口播重切。',
    confirmation_prompt: confirmationPrompt,
    pending_tool: pendingTool,
    plan_summary: {
      ...planSummary,
      long_project: longProject,
      generic_recut_feedback: genericRecutFeedback
    },
    applied_changes: []
  };

  await updateAgentRunRecord(run.id, {
    status: 'waiting_confirmation',
    result,
    requiresConfirmation: true,
    appliedChanges: []
  });
  await appendAndEmitAgentEvent(onEvent, {
    sessionId,
    runId: run.id,
    type: 'waiting_confirmation',
    step: 'assemble_recut_confirmation',
    message: '已生成保守重切计划，等待你确认后再修改时间线。',
    payload: {
      pending_tool: pendingTool,
      plan_summary: result.plan_summary
    }
  });
  await appendAgentMessage({
    sessionId,
    runId: run.id,
    role: 'assistant',
    content: confirmationPrompt,
    metadata: {
      status: 'waiting_confirmation',
      pending_tool: pendingTool.tool,
      plan_kind: pendingTool.plan_kind
    }
  });
  await touchAgentSession(sessionId, {
    summary: mergeSessionSummary(session.summary, userPrompt, confirmationPrompt, [])
  });

  return {
    success: true,
    session_id: sessionId,
    run_id: run.id,
    reply: confirmationPrompt,
    status: 'waiting_confirmation',
    requires_confirmation: true,
    applied_changes: [],
    result
  };
}

function isHighLevelAssembleEdit(change = {}) {
  const tool = String(change?.tool || change?.change || change?.type || '').trim();
  return [
    'delete_subtitle_blocks',
    'restore_subtitle_blocks',
    'delete_words_by_phrase',
    'restore_words_by_phrase',
    'replace_subtitle_text',
    'reorder_project_assets',
    'remove_project_asset'
  ].includes(tool);
}

function needsAssembleDeepening(appliedChanges = [], options = {}) {
  const succeededChanges = (Array.isArray(appliedChanges) ? appliedChanges : []).filter((change) => didAppliedChangeSucceed(change));
  const hasDeterministicCleanup = succeededChanges.some((change) => {
    const tool = String(change?.tool || change?.change || change?.type || '').trim();
    return ['auto_assemble_script', 'remove_pauses', 'remove_all_pauses'].includes(tool);
  });
  const hasHighLevelEdit = succeededChanges.some((change) => isHighLevelAssembleEdit(change));
  if (options?.mutationApplied && !hasHighLevelEdit) return true;
  if (!succeededChanges.length) return false;
  return hasDeterministicCleanup && !hasHighLevelEdit;
}

function buildAssembleDeepeningPrompt(prompt = '') {
  return [
    String(prompt || '').trim() || '执行 口播拼稿',
    '',
    '系统补充要求：上一轮只完成了保守清理，现在必须继续通读当前脚本和字幕。',
    '这一轮不能只做停顿清理，也不能直接结束；要重点删除悬空碎片、失败起手、重复解释、录制准备语句和弱过渡句。',
    '必要时请直接使用 delete_subtitle_blocks 做块级删减，并在结束前重新读稿确认主线是否更完整、更像可直接发布的视频。'
  ].join('\n');
}

function parseChineseInteger(text = '') {
  const value = String(text || '').trim();
  if (!value) return 0;
  const directMap = {
    一: 1,
    两: 2,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10
  };
  if (directMap[value]) return directMap[value];
  if (/^十[一二三四五六七八九]$/.test(value)) {
    return 10 + (directMap[value.slice(1)] || 0);
  }
  if (/^[一二三四五六七八九]十$/.test(value)) {
    return (directMap[value[0]] || 0) * 10;
  }
  if (/^[一二三四五六七八九]十[一二三四五六七八九]$/.test(value)) {
    return (directMap[value[0]] || 0) * 10 + (directMap[value[2]] || 0);
  }
  return 0;
}

function clampInteger(value, min, max) {
  const number = Math.round(Number(value || 0));
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

export function isCandidateOnlyLiveSlicingRequest({ prompt = '', topic = '' } = {}) {
  const text = `${String(prompt || '').trim()} ${String(topic || '').trim()}`.trim();
  if (!text) return false;
  const asksForCandidates = /(候选|建议|推荐|先分析|先看|先给|看看|列出|方案|选题)/i.test(text);
  const asksToCreate = /(执行|生成|创建|直接|落地|新建|切成|切几条|拆条|出片|做成|就按)/i.test(text);
  return asksForCandidates && !asksToCreate;
}

export function shouldUseDeterministicLiveSlicing({ mode = 'custom', prompt = '', topic = '', requestProfile = null } = {}) {
  const normalizedMode = String(requestProfile?.effectiveMode || mode || '').trim();
  if (normalizedMode !== 'live_slicing') return false;
  if (isCandidateOnlyLiveSlicingRequest({ prompt, topic })) return false;
  const text = `${String(prompt || '').trim()} ${String(topic || '').trim()}`.replace(/\s+/g, '');
  if (!text) return false;
  if (/^(执行|生成|创建|直接生成|直接创建)?直播切片$/.test(text)) return true;
  return /(执行|生成|创建|直接|落地|新建|切成|切几条|拆条|出片|做成).{0,12}(直播切片|切片|短视频|片段|高光|候选切片)/i.test(text) ||
    /(直播切片|切片|短视频|片段|高光).{0,12}(执行|生成|创建|直接|落地|新建|切成|切几条|拆条|出片|做成)/i.test(text);
}

export function buildDeterministicLiveSlicingArgs({ prompt = '', topic = '', targetMinutes = 0 } = {}) {
  const text = `${String(prompt || '').trim()} ${String(topic || '').trim()}`.trim();
  const countMatch = text.match(/(?:给我|生成|创建|切成|切|拆成|出)\s*(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*(?:个|条|段|支)?/) ||
    text.match(/(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*(?:个|条|段|支)\s*(?:直播切片|切片|短视频|片段|高光)?/);
  const requestedCount = countMatch
    ? (/^\d+$/.test(countMatch[1]) ? Number(countMatch[1]) : parseChineseInteger(countMatch[1]))
    : 0;
  const count = clampInteger(requestedCount || 4, 1, 8);
  const targetSeconds = Number(targetMinutes || 0) > 0 ? Number(targetMinutes || 0) * 60 : 0;
  const maxDuration = clampInteger(targetSeconds || 75, 25, 120);
  const minDuration = clampInteger(Math.min(25, Math.max(12, maxDuration * 0.35)), 8, Math.max(8, maxDuration - 5));
  const query = String(topic || '').trim();
  return {
    query,
    count,
    min_duration: minDuration,
    max_duration: maxDuration
  };
}

function shouldBootstrapDeterministicAssemble({
  prompt = '',
  topic = '',
  targetMinutes = 0,
  preferencePrompt = ''
} = {}) {
  if (String(topic || '').trim()) return false;
  if (Number(targetMinutes || 0) > 0) return false;
  if (String(preferencePrompt || '').trim()) return false;
  const normalizedPrompt = String(prompt || '')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase();
  if (!normalizedPrompt) return true;
  return [
    '执行口播拼稿',
    '口播拼稿',
    '执行口播剪辑',
    '口播剪辑',
    '执行拼稿',
    '拼口播稿',
    '剪口播稿'
  ].includes(normalizedPrompt);
}

function formatPlannerTime(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return '0.00';
  return number.toFixed(2);
}

function previewPlannerText(text = '', maxChars = 96) {
  const normalized = String(text || '').trim().replace(/\s+/g, ' ');
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

function formatAssetScriptMapForPlanner(assetMap = {}) {
  const assets = Array.isArray(assetMap.assets) ? assetMap.assets : [];
  return assets.map((asset) => [
    `${asset.order}. ${asset.title} | ${formatPlannerTime(asset.duration_seconds)}s | 口播块 ${asset.script_block_count} | 字幕块 ${asset.subtitle_block_count} | 保留 ${asset.kept_word_count} 字`,
    `首句：${previewPlannerText(asset.first_line || '—', 80)}`,
    `末句：${previewPlannerText(asset.last_line || '—', 80)}`,
    `预览：${previewPlannerText(asset.preview || '—', 160)}`
  ].join('\n')).join('\n\n');
}

function formatScriptBlocksForPlanner(scriptBlocks = {}) {
  const blocks = Array.isArray(scriptBlocks.blocks) ? scriptBlocks.blocks : [];
  return blocks.map((block) => (
    `#${block.order}. [${block.asset_title || block.asset_id || '素材'}] ${formatPlannerTime(block.start)}-${formatPlannerTime(block.end)} | ${previewPlannerText(block.text || '', 180)}`
  )).join('\n');
}

function formatAssembleCandidatesForPlanner(candidates = {}) {
  const blockGroups = (candidates.block_groups || []).map((group, index) => {
    const versions = (group.versions || []).map((version) => (
      `#${version.order || '?'} ${previewPlannerText(version.text || '', 72)}`
    )).join(' | ');
    return `${index + 1}. ${versions}`;
  });
  const sentenceGroups = (candidates.sentence_groups || []).map((group, index) => {
    const versions = (group.versions || []).map((version) => (
      `#${version.order || '?'} ${previewPlannerText(version.text || '', 56)}`
    )).join(' | ');
    return `${index + 1}. ${versions}`;
  });
  const restartCandidates = (candidates.restart_candidates || []).map((candidate, index) => (
    `${index + 1}. #${candidate.order || '?'} ${previewPlannerText(candidate.text || '', 84)}`
  ));
  return [
    blockGroups.length ? `重复段落候选：\n${blockGroups.join('\n')}` : '',
    sentenceGroups.length ? `重复句候选：\n${sentenceGroups.join('\n')}` : '',
    restartCandidates.length ? `起手重说碎片候选：\n${restartCandidates.join('\n')}` : ''
  ].filter(Boolean).join('\n\n');
}

function extractFirstJsonObject(text = '') {
  const source = String(text || '').trim();
  if (!source) return '';
  const fencedMatch = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch ? fencedMatch[1].trim() : source;
  const start = candidate.indexOf('{');
  if (start < 0) return '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < candidate.length; index += 1) {
    const char = candidate[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return candidate.slice(start, index + 1);
      }
    }
  }
  return '';
}

function parseStructuredAssemblePlan(text = '') {
  const payload = extractFirstJsonObject(text);
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload);
    const deleteBlockOrders = Array.from(new Set((Array.isArray(parsed?.delete_block_orders) ? parsed.delete_block_orders : [])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0)))
      .slice(0, 14);
    const reorderAssetTitles = Array.from(new Set((Array.isArray(parsed?.reorder_asset_titles) ? parsed.reorder_asset_titles : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)));
    return {
      delete_block_orders: deleteBlockOrders,
      reorder_asset_titles: reorderAssetTitles,
      reason: String(parsed?.reason || '').trim(),
      confidence: String(parsed?.confidence || '').trim()
    };
  } catch {
    return null;
  }
}

function buildDeterministicStructuredAssemblePlan({
  assembleCandidates = {},
  scriptBlocks = {},
  round = 1,
  currentDuration = 0,
  totalAssetDuration = 0
} = {}) {
  const orders = [];
  const seen = new Set();
  const addOrder = (value) => {
    const order = Number(value);
    if (!Number.isFinite(order) || order <= 0 || seen.has(order)) return;
    seen.add(order);
    orders.push(order);
  };

  for (const candidate of (assembleCandidates.restart_candidates || [])) {
    addOrder(candidate?.order);
    if (orders.length >= 12) break;
  }

  for (const group of (assembleCandidates.block_groups || [])) {
    const versions = (group?.versions || [])
      .map((version) => ({
        order: Number(version?.order || 0),
        text: String(version?.text || '').trim()
      }))
      .filter((version) => Number.isFinite(version.order) && version.order > 0)
      .sort((left, right) => left.order - right.order);
    for (const version of versions.slice(1)) {
      addOrder(version.order);
      if (orders.length >= 12) break;
    }
    if (orders.length >= 12) break;
  }

  const durationRatio = totalAssetDuration > 0 ? currentDuration / totalAssetDuration : 1;
  if (round >= 2 && durationRatio > 0.58 && orders.length < 10) {
    const weakPrefixPattern = /^(那(么)?|然后|所以|好(了|那)?|ok|嗯|呃|额|就是|其实|如果说|那我们|那么我们|然后我们|那这个|那么这个|然后这个)/i;
    const importantPattern = /(产品|模型|方案|流程|步骤|场景|功能|效果|价格|订阅|使用|网站|平台|agent|claude|openai|gemini|google|anthropic)/i;
    for (const block of (scriptBlocks.blocks || [])) {
      const text = String(block?.text || '').trim();
      const duration = Number(block?.duration || 0);
      if (!text || importantPattern.test(text)) continue;
      if (duration <= 0 || duration > 4.2) continue;
      if (!weakPrefixPattern.test(text)) continue;
      addOrder(block?.order);
      if (orders.length >= 12) break;
    }
  }

  if (!orders.length) return null;
  return {
    reorder_asset_titles: [],
    delete_block_orders: orders.slice(0, 12),
    reason: round === 1
      ? '根据确定性候选自动删除起手重说和重复段落。'
      : '根据确定性候选继续删除起手重说、重复段落和弱过渡短块。',
    confidence: 'medium'
  };
}

async function withTimeout(taskFactory, timeoutMs, label = 'Operation timed out') {
  let timeoutId = null;
  try {
    return await Promise.race([
      Promise.resolve().then(taskFactory),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(label));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function runAssemblePlannerQuery({
  prompt = '',
  preferredProvider = '',
  preferredModel = '',
  signal = null,
  onProgress = null
}) {
  const candidate = getHealthyGlmCandidate(preferredModel, preferredProvider);
  const settings = getAgentLlmSettings();
  const plannerTimeoutMs = Math.min(30000, Math.max(12000, Number(settings.timeoutMs || 90000) - 20000));
  const runtimeDir = path.join(candidate.runtimeDir, 'planning');
  fs.mkdirSync(runtimeDir, { recursive: true });
  const abortController = new AbortController();
  let timedOut = false;
  let heartbeatId = null;
  const onAbort = () => abortController.abort(signal?.reason || new Error('Planning query aborted'));
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    abortController.abort(new Error(`Assemble planner timed out after ${plannerTimeoutMs}ms`));
  }, plannerTimeoutMs);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let stream = null;
  let finalResultText = '';
  try {
    if (typeof onProgress === 'function') {
      await onProgress({
        step: 'assemble_planner_running',
        message: '结构精修规划器已启动，正在分析素材地图与当前脚本块。',
        payload: {
          model: candidate.model,
          provider: candidate.provider
        }
      });
      heartbeatId = setInterval(() => {
        Promise.resolve(onProgress({
          step: 'assemble_planner_running',
          message: '结构精修规划器仍在分析当前成片，尚未返回最终计划。',
          payload: {
            model: candidate.model,
            provider: candidate.provider,
            heartbeat: true
          }
        })).catch(() => {});
      }, 8000);
    }
    stream = query({
      prompt,
      options: {
        cwd: getProjectRoot(),
        tools: [],
        model: candidate.model,
        maxTurns: 2,
        abortController,
        systemPrompt: [
          '你是中文口播视频精修规划器。',
          '你的任务不是直接编辑，而是阅读给定的素材地图、当前口播块和候选信息，输出一份保守但有效的结构精修计划。',
          '只能删除明显安全的弱块：悬空碎片、失败起手、重复解释、录制准备句、无信息量弱过渡。',
          '绝对不要删除主线信息：产品定位、方案差异、操作流程、典型使用场景、关键结论。',
          '只返回 JSON，不要输出解释性 prose，也不要输出 markdown。'
        ].join('\n'),
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: candidate.baseUrl,
          ANTHROPIC_API_KEY: '',
          ANTHROPIC_AUTH_TOKEN: candidate.key,
          CLAUDE_CONFIG_DIR: runtimeDir,
          CLAUDE_AGENT_SDK_CLIENT_APP: 'autoedit/assemble-planner'
        },
        ...buildClaudeSdkPermissionOptions()
      }
    });

    for await (const message of stream) {
      if (typeof onProgress === 'function' && message?.type !== 'result') {
        await onProgress({
          step: 'assemble_planner_progress',
          message: '结构精修规划器正在持续生成计划。',
          payload: {
            model: candidate.model,
            provider: candidate.provider
          }
        });
      }
      if (message?.type === 'result') {
        if (message.subtype !== 'success') {
          throw new Error((message.errors || []).join('\n') || `Claude SDK planning failed: ${message.subtype}`);
        }
        finalResultText = String(message.result || '').trim();
      }
    }
    markGlmCandidateHealthy(candidate);
    return {
      provider: candidate.provider,
      model: candidate.model,
      text: finalResultText
    };
  } catch (error) {
    markGlmCandidateFailure(candidate, error);
    if (timedOut) {
      throw new Error(`Assemble planner timed out after ${plannerTimeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
    if (heartbeatId) {
      clearInterval(heartbeatId);
      heartbeatId = null;
    }
    if (signal) {
      signal.removeEventListener('abort', onAbort);
    }
    try {
      stream?.close?.();
    } catch {
      // ignore close errors
    }
  }
}

function isNoMutationError(error) {
  const message = String(error?.message || '');
  return message.includes('没有产生任何实际修改') || message.includes('没有真正调用需要的工具');
}

function isRecoverableMutationError(error) {
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

function isPromptTooLongError(error) {
  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('prompt is too long') ||
    message.includes('context length') ||
    message.includes('maximum context') ||
    message.includes('too many tokens')
  );
}

async function runAgentWithAutoContextCompression(args = {}) {
  try {
    return await runClaudeAgentSession({
      ...args,
      forceCompactContext: false
    });
  } catch (error) {
    if (!isPromptTooLongError(error)) {
      throw error;
    }
    await appendAgentEvent({
      sessionId: args.sessionId,
      runId: args.runId,
      type: 'stage',
      step: 'context_compact_retry',
      message: '检测到上下文过长，已自动压缩历史并重新执行本轮请求。',
      payload: {}
    });
    return runClaudeAgentSession({
      ...args,
      forceCompactContext: true
    });
  }
}

function didAppliedChangeSucceed(change = {}) {
  return change?.success !== false && change?.changed !== false;
}

function buildMutationRecoveryReply(mode, appliedChanges = [], error = null) {
  const normalizedMode = String(mode || 'custom').trim();
  const reason = String(error?.message || '模型收尾阶段不稳定').trim();

  if (normalizedMode === 'live_slicing') {
    const createdCount = appliedChanges.filter((change) => (
      didAppliedChangeSucceed(change) &&
      String(change.tool || change.change || '').trim() === 'create_project_slice'
    )).length;
    const deletedCount = appliedChanges.filter((change) => (
      didAppliedChangeSucceed(change) &&
      String(change.tool || change.change || '').trim() === 'delete_project_slice'
    )).length;
    if (createdCount > 0 && deletedCount === 0) {
      return `已完成直播切片创建，但模型在收尾阶段超时；本次实际生成 ${createdCount} 个切片。`;
    }
    if (createdCount > 0 || deletedCount > 0) {
      return `已完成直播切片调整，但模型在收尾阶段超时；本次切片变更已经保留。`;
    }
  }

  return `已完成本次项目修改，但模型在收尾阶段未稳定返回（${reason}）；当前变更已经保留。`;
}

function buildAssembleNoopReply() {
  return [
    '本轮已复查当前口播稿，但没有发现需要继续落地的明显删减项，所以保持当前时间线不变。',
    '',
    '顺序：保持当前顺序，未做调整。',
    '通顺：当前保留内容未新增切口，整体可直接连读。',
    '逻辑：未发现必须删除的重复段影响主线表达。',
    '断句：本轮未新增剪切点，现有衔接保持不变。',
    '重复：未识别到可以安全删除的明确重复 take 或重复句。',
    '停顿：未检测到必须立即处理的明显长停顿；如果你想更紧，可以继续指定段落或目标时长。',
    '误删：本轮未执行删除，因此没有新增误删风险。',
    '改进：如果你希望继续压缩，请直接说明想压哪一段，或给出更明确的删减标准。'
  ].join('\n');
}

function seedAppliedChanges(existingRun = null, existingResult = null) {
  const runChanges = Array.isArray(existingRun?.applied_changes) ? existingRun.applied_changes : [];
  if (runChanges.length) return [...runChanges];
  const resultChanges = Array.isArray(existingResult?.applied_changes) ? existingResult.applied_changes : [];
  return [...resultChanges];
}

async function finalizeAssembleNoopRun({
  projectId,
  session,
  sessionId,
  runId,
  userPrompt,
  existingRun = null,
  existingResult = null
}) {
  const runRecord = existingRun || await getAgentRunRecord(projectId, runId);
  const appliedChanges = seedAppliedChanges(runRecord, existingResult);
  const reply = buildAssembleNoopReply();
  const summary = '本轮复查后未发现需要继续执行的口播拼稿修改，已保持当前时间线不变。';
  const result = {
    ...(runRecord?.result || existingResult || {}),
    reply,
    summary,
    noop: true,
    noop_reason: 'assemble-script-noop',
    applied_changes: appliedChanges
  };

  await updateAgentRunRecord(runId, {
    status: 'completed',
    result,
    requiresConfirmation: false,
    appliedChanges,
    finished: true
  });
  await appendAgentEvent({
    sessionId,
    runId,
    type: 'complete',
    step: 'noop_complete',
    message: summary,
    payload: {
      noop: true,
      mode: 'assemble_script'
    }
  });
  await appendAgentMessage({
    sessionId,
    runId,
    role: 'assistant',
    content: reply,
    metadata: {
      status: 'completed',
      noop: true
    }
  });
  await touchAgentSession(sessionId, {
    summary: mergeSessionSummary(session.summary, userPrompt, reply, appliedChanges)
  });

  return {
    success: true,
    session_id: sessionId,
    run_id: runId,
    reply,
    status: 'completed',
    requires_confirmation: false,
    applied_changes: appliedChanges,
    result
  };
}

async function runStructuredAssembleDeepeningFallback({
  projectId,
  session,
  sessionId,
  runId,
  userPrompt,
  requestedProvider = '',
  requestedModel = '',
  signal = null,
  existingRun = null,
  existingResult = null
}) {
  const runRecord = existingRun || await getAgentRunRecord(projectId, runId);
  const appliedChanges = seedAppliedChanges(runRecord, existingResult);
  const toolStageBridge = async (stage = {}) => {
    await appendAgentEvent({
      sessionId,
      runId,
      type: 'stage',
      step: stage.step || 'tool_progress',
      message: stage.message || '工具正在处理当前项目…',
      payload: stage.payload || {}
    });
  };

  const toolContext = {
    llmProvider: requestedProvider,
    llmModel: requestedModel,
    onStage: toolStageBridge,
    requestContext: {
      mode: 'assemble_script',
      prompt: userPrompt,
      sessionId,
      runId
    }
  };

  let completedRounds = 0;
  let lastPlan = null;
  let lastPlanningMeta = null;
  const planReasons = [];
  const maxRounds = 2;
  const structuredBudgetMs = 105000;
  const contextReadTimeoutMs = 18000;
  const structuredStartedAt = Date.now();

  for (let round = 1; round <= maxRounds; round += 1) {
    const elapsedMs = Date.now() - structuredStartedAt;
    if (elapsedMs >= structuredBudgetMs) {
      await appendAgentEvent({
        sessionId,
        runId,
        type: 'stage',
        step: 'assemble_planner_budget_reached',
        message: '结构精修已达到本轮总预算，系统将保留当前改动并直接收口。',
        payload: {
          round,
          elapsed_ms: elapsedMs
        }
      });
      break;
    }

    await appendAgentEvent({
      sessionId,
      runId,
      type: 'stage',
      step: 'assemble_planner',
      message: round === 1
        ? '系统正在生成第二轮结构精修计划，准备删除悬空碎片、弱过渡和重复解释。'
        : `系统正在继续第 ${round} 轮结构精修，进一步压缩弱过渡和空转解释。`,
      payload: { round }
    });

    await appendAgentEvent({
      sessionId,
      runId,
      type: 'stage',
      step: 'assemble_context_refresh',
      message: `正在刷新第 ${round} 轮结构精修所需的上下文。`,
      payload: { round }
    });

    let projectContext;
    let assetMap;
    let scriptBlocks;
    let assembleCandidates;
    try {
      [projectContext, assetMap, scriptBlocks, assembleCandidates] = await withTimeout(
        () => Promise.all([
          executeProjectAgentToolDirect(projectId, 'get_project_context', {}, toolContext),
          executeProjectAgentToolDirect(projectId, 'get_asset_script_map', {}, toolContext),
          executeProjectAgentToolDirect(projectId, 'get_script_blocks', {}, toolContext),
          executeProjectAgentToolDirect(projectId, 'get_assemble_candidates', {
            take_limit: 14,
            block_limit: 16,
            sentence_limit: 18,
            pause_limit: 12,
            min_pause_seconds: 0.35
          }, toolContext)
        ]),
        contextReadTimeoutMs,
        `Assemble context refresh timed out after ${contextReadTimeoutMs}ms`
      );
      await appendAgentEvent({
        sessionId,
        runId,
        type: 'stage',
        step: 'assemble_context_ready',
        message: `第 ${round} 轮结构精修上下文已刷新完成。`,
        payload: { round }
      });
    } catch (error) {
      await appendAgentEvent({
        sessionId,
        runId,
        type: 'stage',
        step: 'assemble_context_timeout',
        message: `第 ${round} 轮结构精修在刷新上下文时超时，系统将保留当前改动并直接收口。`,
        payload: {
          round,
          error: String(error?.message || 'context refresh failed')
        }
      });
      break;
    }

    const totalAssetDuration = Array.isArray(assetMap.assets)
      ? assetMap.assets.reduce((sum, asset) => sum + Number(asset.duration_seconds || 0), 0)
      : 0;
    const currentDuration = Number(projectContext.current_cut_duration_seconds || 0);
    const durationRatio = totalAssetDuration > 0 ? currentDuration / totalAssetDuration : 1;
    const plannerPrompt = [
      `用户要求：${String(userPrompt || '').trim() || '执行 口播拼稿'}`,
      '',
      `任务：基于当前项目结果，规划第 ${round} 轮结构精修，只返回一个 JSON。`,
      '目标是让视频更像可直接发布的成片，而不是只停留在去停顿。',
      '优先删除：悬空碎片、失败起手、重复解释、录制准备语句、无信息量弱过渡、口头确认、自我重复铺垫。',
      '优先保留：产品定位/核心价值、与现有方案的差异点、实际操作流程、典型使用场景、关键结论。',
      '对多素材产品介绍视频，允许继续删除表达同一个意思但信息增量很低的重复解释。',
      `当前成片时长约 ${formatPlannerTime(currentDuration)}s，总素材时长约 ${formatPlannerTime(totalAssetDuration)}s，当前压缩比例约 ${(durationRatio * 100).toFixed(0)}%。`,
      '对于这种多素材产品介绍视频，如果逻辑仍完整，目标可以压到原始总时长的 45%-60% 区间；不要为了“保守”把明显冗余段落留住。',
      '如果当前仍明显偏长，并且还有安全的弱块，可以继续给出删减计划；不要因为已经做过一轮就保守停住。',
      '当压缩比例仍高于 60% 时，可以更积极地删除：重复卖点解释、同义重复补充、录制过程中的自我确认、没有信息增量的延展句。',
      '如果素材顺序明显不合理，可以给出 reorder_asset_titles；只能改素材之间的顺序，不能改单素材内部顺序。',
      'delete_block_orders 里只能填写当前 SCRIPT_BLOCKS 中出现的 order，最多 18 个。',
      '如果暂时没有足够安全的删减，就返回空数组，不要乱删。',
      '',
      `PROJECT_CONTEXT:\n${String(projectContext.summary || '').trim()}`,
      '',
      `ASSET_SCRIPT_MAP:\n${formatAssetScriptMapForPlanner(assetMap) || '无'}`,
      '',
      `SCRIPT_BLOCKS:\n${formatScriptBlocksForPlanner(scriptBlocks) || '无'}`,
      '',
      `ASSEMBLE_CANDIDATES:\n${formatAssembleCandidatesForPlanner(assembleCandidates) || '无'}`,
      '',
      '只输出 JSON，格式如下：',
      '{"reorder_asset_titles":[],"delete_block_orders":[],"reason":"","confidence":"high|medium|low"}'
    ].join('\n');

    let planningText = '';
    let planningMeta = null;
    try {
      planningMeta = await runAssemblePlannerQuery({
        prompt: plannerPrompt,
      preferredProvider: requestedProvider,
      preferredModel: requestedModel,
      signal,
      onProgress: toolStageBridge
    });
      planningText = String(planningMeta?.text || '').trim();
      lastPlanningMeta = planningMeta;
    } catch (error) {
      const deterministicPlan = buildDeterministicStructuredAssemblePlan({
        assembleCandidates,
        scriptBlocks,
        round,
        currentDuration,
        totalAssetDuration
      });
      await appendAgentEvent({
        sessionId,
        runId,
        type: 'stage',
        step: 'assemble_planner_failed',
        message: `第 ${round} 轮结构精修计划生成失败：${String(error?.message || 'unknown error')}`,
        payload: { round }
      });
      if (!deterministicPlan) break;
      await appendAgentEvent({
        sessionId,
        runId,
        type: 'stage',
        step: 'assemble_planner_fallback',
        message: `第 ${round} 轮结构精修改用确定性兜底计划：${deterministicPlan.reason}`,
        payload: {
          round,
          delete_block_orders: deterministicPlan.delete_block_orders
        }
      });
      lastPlan = deterministicPlan;
      planningMeta = {
        provider: 'deterministic_fallback',
        model: 'rule-based',
        text: JSON.stringify(deterministicPlan)
      };
      lastPlanningMeta = planningMeta;
      planningText = planningMeta.text;
    }

    let plan = parseStructuredAssemblePlan(planningText);
    if (!plan || (!plan.delete_block_orders.length && !plan.reorder_asset_titles.length)) {
      const deterministicPlan = buildDeterministicStructuredAssemblePlan({
        assembleCandidates,
        scriptBlocks,
        round,
        currentDuration,
        totalAssetDuration
      });
      if (deterministicPlan) {
        await appendAgentEvent({
          sessionId,
          runId,
          type: 'stage',
          step: 'assemble_planner_fallback',
          message: `第 ${round} 轮结构精修改用确定性兜底计划：${deterministicPlan.reason}`,
          payload: {
            round,
            delete_block_orders: deterministicPlan.delete_block_orders
          }
        });
        plan = deterministicPlan;
      }
    }
    lastPlan = plan;
    if (!plan || (!plan.delete_block_orders.length && !plan.reorder_asset_titles.length)) {
      await appendAgentEvent({
        sessionId,
        runId,
        type: 'stage',
        step: 'assemble_planner_empty',
        message: round === 1
          ? '第二轮结构精修没有识别到足够安全的块级删减计划，本轮保持当前结果。'
          : `第 ${round} 轮结构精修未再识别到足够安全的删减计划。`,
        payload: {
          round,
          planner_preview: previewPlannerText(planningText, 220)
        }
      });
      break;
    }

    if (plan.reorder_asset_titles.length) {
      await appendAgentEvent({
        sessionId,
        runId,
        type: 'tool_call',
        step: 'reorder_project_assets',
        message: '执行 reorder_project_assets',
        payload: {
          tool: 'reorder_project_assets',
          args: {
            ordered_titles: plan.reorder_asset_titles
          },
          round
        }
      });
      const reorderResult = await executeProjectAgentToolDirect(projectId, 'reorder_project_assets', {
        ordered_titles: plan.reorder_asset_titles
      }, toolContext);
      await appendAgentEvent({
        sessionId,
        runId,
        type: 'tool_result',
        step: 'reorder_project_assets',
        message: reorderResult?.summary || '已更新素材顺序。',
        payload: {
          tool: 'reorder_project_assets',
          round,
          result: reorderResult
        }
      });
      if (didAppliedChangeSucceed(reorderResult) && reorderResult?.changed) {
        appliedChanges.push({
          tool: 'reorder_project_assets',
          ...reorderResult
        });
      }
    }

    if (plan.delete_block_orders.length) {
      await appendAgentEvent({
        sessionId,
        runId,
        type: 'tool_call',
        step: 'delete_subtitle_blocks',
        message: '执行 delete_subtitle_blocks',
        payload: {
          tool: 'delete_subtitle_blocks',
          args: {
            orders: plan.delete_block_orders
          },
          round
        }
      });
      const deleteResult = await executeProjectAgentToolDirect(projectId, 'delete_subtitle_blocks', {
        orders: plan.delete_block_orders
      }, toolContext);
      await appendAgentEvent({
        sessionId,
        runId,
        type: 'tool_result',
        step: 'delete_subtitle_blocks',
        message: deleteResult?.summary || '已删除结构精修选中的口播块。',
        payload: {
          tool: 'delete_subtitle_blocks',
          round,
          result: deleteResult
        }
      });
      if (didAppliedChangeSucceed(deleteResult) && deleteResult?.changed) {
        appliedChanges.push({
          tool: 'delete_subtitle_blocks',
          ...deleteResult
        });
      }
    }

    if (plan.reason) {
      planReasons.push(`第 ${round} 轮：${plan.reason}`);
    }
    completedRounds += 1;
  }

  if (!appliedChanges.some((change) => isHighLevelAssembleEdit(change))) {
    return null;
  }

  const reply = [
    `系统已自动执行 ${completedRounds || 1} 轮结构精修：${planReasons.join('；') || lastPlan?.reason || '删除了悬空碎片、弱过渡和重复解释。'}`,
    '',
    `顺序：${lastPlan?.reorder_asset_titles?.length ? `已按素材级顺序调整为 ${lastPlan.reorder_asset_titles.join(' → ')}` : '保持素材顺序不变。'}`,
    '通顺：本轮按块级删减，避免句中抠词；建议重点抽查删改交界处。',
    '逻辑：本轮删除的是弱过渡、失败起手或重复解释，主线表达应更集中。',
    '断句：本轮使用字幕块级删除，断句风险低于句中删词。',
    '重复：已继续清理仍残留的重复解释和起手重说。',
    '停顿：保留上一轮停顿清理结果，本轮重点做语义级精修。',
    '误删：这是结构精修结果，建议你复听核心论述段确认没有删掉关键细节。',
    '改进：如还想继续逼近人工终稿，我下一轮可以再专门删弱承接句和空转解释。'
  ].join('\n');

  const result = {
    ...(runRecord?.result || existingResult || {}),
    reply,
    summary: String(planReasons.join('；') || lastPlan?.reason || '已自动完成结构精修。').trim(),
    applied_changes: appliedChanges,
    structured_assemble_plan: {
      ...(lastPlan || {}),
      rounds_applied: completedRounds,
      provider: lastPlanningMeta?.provider || requestedProvider,
      model: lastPlanningMeta?.model || requestedModel
    },
    recovered_from_no_mutation: true
  };

  await updateAgentRunRecord(runId, {
    status: 'completed',
    result,
    requiresConfirmation: false,
    appliedChanges,
    finished: true
  });
  await appendAgentEvent({
    sessionId,
    runId,
    type: 'complete',
    step: 'assemble_planner_complete',
    message: '第二轮结构精修已完成，本轮结果已写回项目。',
    payload: {
      rounds_applied: completedRounds,
      reordered_asset_titles: lastPlan?.reorder_asset_titles || [],
      deleted_block_orders: lastPlan?.delete_block_orders || []
    }
  });
  await appendAgentMessage({
    sessionId,
    runId,
    role: 'assistant',
    content: reply,
    metadata: {
      status: 'completed',
      recovered_from_no_mutation: true,
      structured_assemble_plan: true
    }
  });
  await touchAgentSession(sessionId, {
    summary: mergeSessionSummary(session.summary, userPrompt, reply, appliedChanges)
  });

  return {
    success: true,
    session_id: sessionId,
    run_id: runId,
    reply,
    status: 'completed',
    requires_confirmation: false,
    applied_changes: appliedChanges,
    result
  };
}

function buildDeterministicLiveSlicingReply(createdSlices = [], suggestionResult = {}) {
  if (!createdSlices.length) {
    return [
      '我已经执行直播切片流程，但当前没有找到满足时长和文本条件的可落地切片候选。',
      '',
      String(suggestionResult?.summary || '').trim() || '建议确认素材已经完成转写，或放宽切片时长范围后再试。'
    ].join('\n');
  }
  const lines = createdSlices.map((change, index) => {
    const slice = change.slice || {};
    const duration = Number(slice.total_duration || 0);
    const durationText = duration > 0 ? `${formatPlannerTime(duration)}s` : '未知时长';
    return `${index + 1}. ${change.slice_title || slice.title || `切片 ${index + 1}`} · ${durationText}`;
  });
  return [
    `已按直播切片流程创建 ${createdSlices.length} 个切片：`,
    ...lines,
    '',
    '这些切片已写入项目左侧切片列表，可逐条打开文稿、预览或导出。'
  ].join('\n');
}

async function runDeterministicLiveSlicingFallback({
  projectId,
  session,
  sessionId,
  runId,
  userPrompt,
  topic = '',
  targetMinutes = 0,
  requestedProvider = '',
  requestedModel = '',
  existingRun = null,
  existingResult = null
}) {
  const runRecord = existingRun || await getAgentRunRecord(projectId, runId);
  const appliedChanges = seedAppliedChanges(runRecord, existingResult);
  const toolContext = {
    llmProvider: requestedProvider,
    llmModel: requestedModel,
    requestContext: {
      mode: 'live_slicing',
      prompt: userPrompt,
      topic,
      targetMinutes,
      sessionId,
      runId
    }
  };
  const suggestionArgs = buildDeterministicLiveSlicingArgs({
    prompt: userPrompt,
    topic,
    targetMinutes
  });

  await appendAgentEvent({
    sessionId,
    runId,
    type: 'stage',
    step: 'deterministic_live_slicing_fallback',
    message: '模型没有稳定调用直播切片工具，系统正在用确定性切片流程直接生成切片。',
    payload: suggestionArgs
  });

  await appendAgentEvent({
    sessionId,
    runId,
    type: 'tool_call',
    step: 'suggest_project_slices',
    message: '执行 suggest_project_slices',
    payload: {
      tool: 'suggest_project_slices',
      args: suggestionArgs
    }
  });
  const suggestionResult = await executeProjectAgentToolDirect(projectId, 'suggest_project_slices', suggestionArgs, toolContext);
  await appendAgentEvent({
    sessionId,
    runId,
    type: 'tool_result',
    step: 'suggest_project_slices',
    message: suggestionResult?.summary || '已生成切片候选。',
    payload: {
      tool: 'suggest_project_slices',
      result: suggestionResult
    }
  });
  appliedChanges.push({
    tool: 'suggest_project_slices',
    ...suggestionResult
  });

  const suggestions = Array.isArray(suggestionResult?.suggestions) ? suggestionResult.suggestions : [];
  const createdSlices = [];
  for (let index = 0; index < suggestions.length; index += 1) {
    const suggestion = suggestions[index];
    const createArgs = {
      title: suggestion.title || `切片 ${index + 1}`,
      summary: suggestion.summary || '',
      query: suggestionArgs.query || '',
      target_duration_seconds: Number(suggestion.duration_seconds || 0),
      ranges: Array.isArray(suggestion.ranges) ? suggestion.ranges : []
    };
    if (!createArgs.ranges.length) continue;
    await appendAgentEvent({
      sessionId,
      runId,
      type: 'tool_call',
      step: 'create_project_slice',
      message: '执行 create_project_slice',
      payload: {
        tool: 'create_project_slice',
        args: createArgs
      }
    });
    const createResult = await executeProjectAgentToolDirect(projectId, 'create_project_slice', createArgs, toolContext);
    await appendAgentEvent({
      sessionId,
      runId,
      type: 'tool_result',
      step: 'create_project_slice',
      message: createResult?.summary || '已创建直播切片。',
      payload: {
        tool: 'create_project_slice',
        result: createResult
      }
    });
    if (didAppliedChangeSucceed(createResult)) {
      const change = {
        tool: 'create_project_slice',
        ...createResult
      };
      createdSlices.push(change);
      appliedChanges.push(change);
    }
  }

  const reply = buildDeterministicLiveSlicingReply(createdSlices, suggestionResult);
  const result = {
    ...(runRecord?.result || existingResult || {}),
    reply,
    summary: createdSlices.length
      ? `已创建 ${createdSlices.length} 个直播切片。`
      : '直播切片流程未找到可落地候选。',
    applied_changes: appliedChanges,
    deterministic_live_slicing: true,
    suggested_slice_count: suggestions.length,
    created_slice_count: createdSlices.length
  };

  await updateAgentRunRecord(runId, {
    status: 'completed',
    result,
    requiresConfirmation: false,
    appliedChanges,
    finished: true
  });
  await appendAgentEvent({
    sessionId,
    runId,
    type: 'complete',
    step: 'deterministic_live_slicing_complete',
    message: createdSlices.length
      ? `确定性直播切片已完成，创建 ${createdSlices.length} 个切片。`
      : '确定性直播切片已完成，但没有找到可创建的候选。',
    payload: {
      suggested_slice_count: suggestions.length,
      created_slice_count: createdSlices.length
    }
  });
  await appendAgentMessage({
    sessionId,
    runId,
    role: 'assistant',
    content: reply,
    metadata: {
      status: 'completed',
      deterministic_live_slicing: true,
      created_slice_count: createdSlices.length
    }
  });
  await touchAgentSession(sessionId, {
    summary: mergeSessionSummary(session.summary, userPrompt, reply, appliedChanges)
  });

  return {
    success: true,
    session_id: sessionId,
    run_id: runId,
    reply,
    status: 'completed',
    requires_confirmation: false,
    applied_changes: appliedChanges,
    result
  };
}

async function runDeterministicAssembleFallback({
  projectId,
  session,
  sessionId,
  runId,
  userPrompt,
  requestedProvider = '',
  requestedModel = '',
  existingRun = null,
  existingResult = null
}) {
  const runRecord = existingRun || await getAgentRunRecord(projectId, runId);
  const appliedChanges = seedAppliedChanges(runRecord, existingResult);
  const toolStageBridge = async (stage = {}) => {
    await appendAgentEvent({
      sessionId,
      runId,
      type: 'stage',
      step: stage.step || 'tool_progress',
      message: stage.message || '工具正在处理当前项目…',
      payload: stage.payload || {}
    });
  };

  await appendAgentEvent({
    sessionId,
    runId,
    type: 'stage',
    step: 'deterministic_assemble_fallback',
    message: '模型没有稳定落地口播拼稿，系统正在自动补做确定性保守拼稿。',
    payload: {}
  });

  const toolContext = {
    llmProvider: requestedProvider,
    llmModel: requestedModel,
    onStage: toolStageBridge,
    requestContext: {
      mode: 'assemble_script',
      prompt: userPrompt,
      sessionId,
      runId
    }
  };

  if (!appliedChanges.some((change) => String(change?.tool || change?.change || '').trim() === 'save_snapshot')) {
    await appendAgentEvent({
      sessionId,
      runId,
      type: 'tool_call',
      step: 'save_snapshot',
      message: '执行 save_snapshot',
      payload: { tool: 'save_snapshot', args: { note: '系统自动补做口播拼稿前快照' } }
    });
    const snapshotResult = await executeProjectAgentToolDirect(projectId, 'save_snapshot', { note: '系统自动补做口播拼稿前快照' }, toolContext);
    await appendAgentEvent({
      sessionId,
      runId,
      type: 'tool_result',
      step: 'save_snapshot',
      message: snapshotResult?.summary || '已保存时间线快照。',
      payload: { tool: 'save_snapshot', result: snapshotResult }
    });
    if (snapshotResult?.changed) {
      appliedChanges.push({
        tool: 'save_snapshot',
        ...snapshotResult
      });
    }
  }

  const assembleArgs = {
    take_limit: 12,
    block_limit: 10,
    sentence_limit: 14,
    pause_limit: 12,
    min_pause_seconds: 0.35,
    max_passes: 1,
    take_window_limit: 360
  };
  await appendAgentEvent({
    sessionId,
    runId,
    type: 'tool_call',
    step: 'auto_assemble_script',
    message: '执行 auto_assemble_script',
    payload: { tool: 'auto_assemble_script', args: assembleArgs }
  });
  const assembleResult = await executeProjectAgentToolDirect(projectId, 'auto_assemble_script', assembleArgs, toolContext);
  await appendAgentEvent({
    sessionId,
    runId,
    type: 'tool_result',
    step: 'auto_assemble_script',
    message: assembleResult?.summary || '已执行一轮保守口播拼稿。',
    payload: { tool: 'auto_assemble_script', result: assembleResult }
  });

  if (assembleResult?.changed) {
    appliedChanges.push({
      tool: 'auto_assemble_script',
      ...assembleResult
    });
  }

  const structuredFallbackResult = await runStructuredAssembleDeepeningFallback({
    projectId,
    session,
    sessionId,
    runId,
    userPrompt,
    requestedProvider,
    requestedModel,
    existingRun: runRecord,
    existingResult: {
      ...(runRecord?.result || existingResult || {}),
      applied_changes: appliedChanges
    }
  });
  if (structuredFallbackResult) {
    return structuredFallbackResult;
  }

  if (!assembleResult?.changed) {
    return null;
  }

  const reply = [
    `系统已自动补做口播拼稿：${String(assembleResult.summary || '').trim()}`,
    '',
    '顺序：默认保持当前素材顺序不变。',
    '通顺：已先做保守清理，建议你重点抽查删改交界处是否顺耳。',
    '逻辑：本轮优先删除重复起手、失败重说和明显停顿，不会主动改写原句。',
    '断句：如仍有悬空碎片，我可以继续按段精修。',
    '重复：本轮已优先清掉确定性重复和重说片段。',
    '停顿：本轮已同步清理明显停顿。',
    '误删：这是保守自动清理结果，建议你再听一遍关键段落。',
    '改进：如果你要更接近人工终稿，我下一轮可以继续删弱过渡句和空转解释。'
  ].join('\n');
  const result = {
    ...(runRecord?.result || existingResult || {}),
    reply,
    summary: String(assembleResult.summary || '已自动补做一轮保守口播拼稿。').trim(),
    applied_changes: appliedChanges,
    recovered_from_no_mutation: true
  };

  await updateAgentRunRecord(runId, {
    status: 'completed',
    result,
    requiresConfirmation: false,
    appliedChanges,
    finished: true
  });
  await appendAgentEvent({
    sessionId,
    runId,
    type: 'complete',
    step: 'deterministic_assemble_complete',
    message: '系统自动保守拼稿已完成，本轮结果已写回项目。',
    payload: {
      recovered_from_no_mutation: true
    }
  });
  await appendAgentMessage({
    sessionId,
    runId,
    role: 'assistant',
    content: reply,
    metadata: {
      status: 'completed',
      recovered_from_no_mutation: true
    }
  });
  await touchAgentSession(sessionId, {
    summary: mergeSessionSummary(session.summary, userPrompt, reply, appliedChanges)
  });

  return {
    success: true,
    session_id: sessionId,
    run_id: runId,
    reply,
    status: 'completed',
    requires_confirmation: false,
    applied_changes: appliedChanges,
    result
  };
}

async function runProjectAgentInternal({
  projectId,
  sessionId,
  mode = 'custom',
  prompt = '',
  topic = '',
  target_minutes: targetMinutes = 0,
  preference_prompt: preferencePrompt = '',
  provider = '',
  model = '',
  onEvent = () => {}
}) {
  const session = await getProjectAgentSession(projectId, sessionId);
  if (!session) {
    throw new Error('Agent session not found');
  }

  const requestProfile = classifyProjectAgentRequest({ mode, prompt, topic, targetMinutes });
  const requestedMode = normalizeProjectAgentMode(mode);
  const normalizedMode = requestProfile.effectiveMode;
  const requestedProvider = getProjectAgentProvider();
  const requestedModel = getProjectAgentModel();
  let forcedRetryUsed = false;
  const userPrompt = String(prompt || '').trim() || `执行 ${normalizedMode}`;

  const run = await createAgentRunRecord({
    projectId,
    sessionId,
    mode: normalizedMode,
    prompt: userPrompt,
    provider: requestedProvider,
    model: requestedModel,
    input: {
      topic: String(topic || '').trim(),
      target_minutes: Number(targetMinutes || 0),
      preference_prompt: String(preferencePrompt || '').trim(),
      requested_provider: String(provider || '').trim(),
      requested_model: String(model || '').trim(),
      requested_mode: requestedMode
    }
  });
  await appendAgentMessage({
    sessionId,
    runId: run.id,
    role: 'user',
    content: userPrompt,
    metadata: {
      mode: normalizedMode,
      requested_mode: requestedMode,
      routing_reason: requestProfile.routingReason || ''
    }
  });

  if (isDirectDocumentOpenRequest({ prompt: userPrompt, topic })) {
    return finalizeDirectDocumentOpenRun({
      session,
      sessionId,
      runId: run.id,
      userPrompt,
      mode: normalizedMode
    });
  }

  const assemblePlanConfirmationResult = await maybeCreateAssemblePlanConfirmation({
    projectId,
    session,
    sessionId,
    run,
    userPrompt,
    requestedMode,
    requestedProvider,
    requestedModel,
    requestProfile,
    onEvent
  });
  if (assemblePlanConfirmationResult) {
    return assemblePlanConfirmationResult;
  }

  const mutationSignatureBefore = await readProjectMutationSignature(projectId);
  const abortController = new AbortController();
  activeRunAbortControllers.set(run.id, abortController);
  cancellationRequestedRuns.delete(run.id);

  try {
    if (
      normalizedMode === 'live_slicing' &&
      requestProfile.requiresMutation &&
      shouldUseDeterministicLiveSlicing({
        mode: normalizedMode,
        prompt: userPrompt,
        topic,
        requestProfile
      })
    ) {
      return await runDeterministicLiveSlicingFallback({
        projectId,
        session,
        sessionId,
        runId: run.id,
        userPrompt,
        topic: String(topic || '').trim(),
        targetMinutes: Number(targetMinutes || 0),
        requestedProvider,
        requestedModel
      });
    }

    if (
      normalizedMode === 'assemble_script'
      && shouldBootstrapDeterministicAssemble({
        prompt: userPrompt,
        topic,
        targetMinutes,
        preferencePrompt
      })
    ) {
      await appendAgentEvent({
        sessionId,
        runId: run.id,
        type: 'stage',
        step: 'assemble_bootstrap',
        message: '正在执行标准口播拼稿流程：先做确定性清理，再判断是否继续结构精修。',
        payload: {}
      });
      const deterministicBootstrapResult = await runDeterministicAssembleFallback({
        projectId,
        session,
        sessionId,
        runId: run.id,
        userPrompt,
        requestedProvider,
        requestedModel
      });
      if (deterministicBootstrapResult) {
        return deterministicBootstrapResult;
      }
    }

    if (requestedMode !== normalizedMode) {
      await appendAgentEvent({
        sessionId,
        runId: run.id,
        type: 'stage',
        step: 'mode_routed',
        message: buildRoutingMessage(requestProfile),
        payload: {
          requested_mode: requestedMode,
          effective_mode: normalizedMode,
          routing_reason: requestProfile.routingReason || ''
        }
      });
    }

    let result;
    try {
      result = await runAgentWithAutoContextCompression({
        projectId,
        sessionId,
        runId: run.id,
        mode: normalizedMode,
        prompt: userPrompt,
        topic: String(topic || '').trim(),
        targetMinutes: Number(targetMinutes || 0),
        preferencePrompt: String(preferencePrompt || '').trim(),
        preferredProvider: requestedProvider,
        preferredModel: requestedModel,
        signal: abortController.signal,
        onEvent,
        persistAssistantMessage: false
      });
    } catch (error) {
      if (normalizedMode === 'assemble_script' && !forcedRetryUsed && isNoMutationError(error)) {
        forcedRetryUsed = true;
        await appendAgentEvent({
          sessionId,
          runId: run.id,
          type: 'stage',
          step: 'retry_with_context',
          message: '上一轮没有真正修改项目，正在自动发起第二轮执行。',
          payload: {}
        });
        try {
          result = await runAgentWithAutoContextCompression({
            projectId,
            sessionId,
            runId: run.id,
            mode: normalizedMode,
            prompt: userPrompt,
            topic: String(topic || '').trim(),
            targetMinutes: Number(targetMinutes || 0),
            preferencePrompt: String(preferencePrompt || '').trim(),
            preferredProvider: requestedProvider,
            preferredModel: requestedModel,
            signal: abortController.signal,
            onEvent,
            persistAssistantMessage: false
          });
        } catch (retryError) {
          if (isNoMutationError(retryError)) {
            const deterministicFallbackResult = await runDeterministicAssembleFallback({
              projectId,
              session,
              sessionId,
              runId: run.id,
              userPrompt,
              requestedProvider,
              requestedModel
            });
            if (deterministicFallbackResult) {
              return deterministicFallbackResult;
            }
            return finalizeAssembleNoopRun({
              projectId,
              session,
              sessionId,
              runId: run.id,
              userPrompt
            });
          }
          throw retryError;
        }
      } else if (normalizedMode === 'live_slicing' && isNoMutationError(error)) {
        const deterministicFallbackResult = await runDeterministicLiveSlicingFallback({
          projectId,
          session,
          sessionId,
          runId: run.id,
          userPrompt,
          topic: String(topic || '').trim(),
          targetMinutes: Number(targetMinutes || 0),
          requestedProvider,
          requestedModel
        });
        if (deterministicFallbackResult) {
          return deterministicFallbackResult;
        }
      } else {
        throw error;
      }
    }

    let latestRun = await getAgentRunRecord(projectId, run.id);
    let assistantReply = String(result.reply || latestRun?.result?.reply || '').trim();
    let mutationSignatureAfter = await readProjectMutationSignature(projectId);
    const requiresMutation = requestProfile.requiresMutation || resultRequiresMutation(normalizedMode, latestRun?.result || result);

    if (requiresMutation && mutationSignatureAfter === mutationSignatureBefore) {
      if (normalizedMode === 'assemble_script' && !forcedRetryUsed) {
        forcedRetryUsed = true;
        await appendAgentEvent({
          sessionId,
          runId: run.id,
          type: 'stage',
          step: 'retry_with_context',
          message: '检测到上一轮没有真正改到项目，正在自动发起第二轮执行。',
          payload: {}
        });
        const retriedResult = await runAgentWithAutoContextCompression({
          projectId,
          sessionId,
          runId: run.id,
          mode: normalizedMode,
          prompt: userPrompt,
          topic: String(topic || '').trim(),
          targetMinutes: Number(targetMinutes || 0),
          preferencePrompt: String(preferencePrompt || '').trim(),
          preferredProvider: requestedProvider,
          preferredModel: requestedModel,
          signal: abortController.signal,
          onEvent,
          persistAssistantMessage: false
        });
        const retriedRun = await getAgentRunRecord(projectId, run.id);
        const retriedMutationSignature = await readProjectMutationSignature(projectId);
        if (resultRequiresMutation(normalizedMode, retriedRun?.result || retriedResult) && retriedMutationSignature === mutationSignatureBefore) {
          const deterministicFallbackResult = await runDeterministicAssembleFallback({
            projectId,
            session,
            sessionId,
            runId: run.id,
            userPrompt,
            requestedProvider,
            requestedModel,
            existingRun: retriedRun,
            existingResult: retriedResult
          });
          if (deterministicFallbackResult) {
            return deterministicFallbackResult;
          }
          return finalizeAssembleNoopRun({
            projectId,
            session,
            sessionId,
            runId: run.id,
            userPrompt,
            existingRun: retriedRun,
            existingResult: retriedResult
          });
        }
        const retriedReply = String(retriedResult.reply || retriedRun?.result?.reply || '').trim();
        if (String(retriedRun?.status || retriedResult.status || '') === 'completed') {
          await appendAcceptedAssistantReply({
            sessionId,
            runId: run.id,
            reply: retriedReply,
            run: retriedRun || {
              status: retriedResult.status,
              result: retriedResult,
              model: requestedModel,
              provider: requestedProvider
            }
          });
        }
        await touchAgentSession(sessionId, {
          summary: mergeSessionSummary(session.summary, userPrompt, retriedReply, retriedRun?.applied_changes || [])
        });
        return {
          success: true,
          session_id: sessionId,
          run_id: run.id,
          reply: retriedReply,
          status: retriedRun?.status || retriedResult.status,
          requires_confirmation: Boolean(retriedRun?.requires_confirmation),
          applied_changes: retriedRun?.applied_changes || retriedResult.applied_changes || [],
          result: retriedRun?.result || retriedResult
        };
      }
      if (normalizedMode === 'assemble_script') {
        return finalizeAssembleNoopRun({
          projectId,
          session,
          sessionId,
          runId: run.id,
          userPrompt,
          existingRun: latestRun,
          existingResult: result
        });
      }
      if (normalizedMode === 'live_slicing') {
        return runDeterministicLiveSlicingFallback({
          projectId,
          session,
          sessionId,
          runId: run.id,
          userPrompt,
          topic: String(topic || '').trim(),
          targetMinutes: Number(targetMinutes || 0),
          requestedProvider,
          requestedModel,
          existingRun: latestRun,
          existingResult: result
        });
      }
      throw new Error('本次 Agent 没有产生任何实际修改，请重试或换更明确的指令。');
    }

    if (
      normalizedMode === 'assemble_script'
      && needsAssembleDeepening(
        latestRun?.applied_changes || result.applied_changes || [],
        { mutationApplied: mutationSignatureAfter !== mutationSignatureBefore }
      )
    ) {
      await appendAgentEvent({
        sessionId,
        runId: run.id,
        type: 'stage',
        step: 'deepen_assemble',
        message: '保守清理已完成，系统正在自动发起第二轮精修，继续删除悬空碎片和弱过渡句。',
        payload: {}
      });
      try {
        const deepenedResult = await runAgentWithAutoContextCompression({
          projectId,
          sessionId,
          runId: run.id,
          mode: normalizedMode,
          prompt: buildAssembleDeepeningPrompt(userPrompt),
          topic: String(topic || '').trim(),
          targetMinutes: Number(targetMinutes || 0),
          preferencePrompt: String(preferencePrompt || '').trim(),
          preferredProvider: requestedProvider,
          preferredModel: requestedModel,
          signal: abortController.signal,
          onEvent,
          persistAssistantMessage: false
        });
        const deepenedRun = await getAgentRunRecord(projectId, run.id);
        const deepenedMutationSignature = await readProjectMutationSignature(projectId);
        if (deepenedMutationSignature !== mutationSignatureAfter) {
          result = deepenedResult;
          latestRun = deepenedRun;
          mutationSignatureAfter = deepenedMutationSignature;
          assistantReply = String(deepenedResult.reply || deepenedRun?.result?.reply || assistantReply).trim();
        } else {
          const structuredFallbackResult = await runStructuredAssembleDeepeningFallback({
            projectId,
            session,
            sessionId,
            runId: run.id,
            userPrompt,
            requestedProvider,
            requestedModel,
            signal: abortController.signal,
            existingRun: deepenedRun,
            existingResult: deepenedResult
          });
          if (structuredFallbackResult) {
            return structuredFallbackResult;
          }
        }
      } catch (deepenError) {
        await appendAgentEvent({
          sessionId,
          runId: run.id,
          type: 'stage',
          step: 'deepen_assemble_skipped',
          message: `第二轮精修未成功完成：${String(deepenError?.message || 'unknown error')}`,
          payload: {}
        });
        const structuredFallbackResult = await runStructuredAssembleDeepeningFallback({
          projectId,
          session,
          sessionId,
          runId: run.id,
          userPrompt,
          requestedProvider,
          requestedModel,
          signal: abortController.signal,
          existingRun: latestRun,
          existingResult: result
        });
        if (structuredFallbackResult) {
          return structuredFallbackResult;
        }
      }
    }

    if (String(latestRun?.status || result.status || '') === 'completed') {
      await appendAcceptedAssistantReply({
        sessionId,
        runId: run.id,
        reply: assistantReply,
        run: latestRun || {
          status: result.status,
          result,
          model: requestedModel,
          provider: requestedProvider
        }
      });
    }
    await touchAgentSession(sessionId, {
      summary: mergeSessionSummary(session.summary, userPrompt, assistantReply, latestRun?.applied_changes || [])
    });

    return {
      success: true,
      session_id: sessionId,
      run_id: run.id,
      reply: assistantReply,
      status: latestRun?.status || result.status,
      requires_confirmation: Boolean(latestRun?.requires_confirmation),
      applied_changes: latestRun?.applied_changes || result.applied_changes || [],
      result: latestRun?.result || result
    };
  } catch (error) {
    if (abortController.signal.aborted || cancellationRequestedRuns.has(run.id) || String(error?.name || '') === 'AbortError') {
      return finalizeCancelledRun(projectId, sessionId, run.id);
    }

    const mutationSignatureAfter = await readProjectMutationSignature(projectId).catch(() => mutationSignatureBefore);
    if (requestProfile.requiresMutation && mutationSignatureAfter !== mutationSignatureBefore && isRecoverableMutationError(error)) {
      const latestRun = await getAgentRunRecord(projectId, run.id);
      const appliedChanges = latestRun?.applied_changes || [];
      const recoveredReply = String(latestRun?.result?.reply || '').trim() || buildMutationRecoveryReply(normalizedMode, appliedChanges, error);
      const recoveredResult = {
        ...(latestRun?.result || {}),
        reply: recoveredReply,
        summary: String(latestRun?.result?.summary || '').trim() || recoveredReply,
        applied_changes: appliedChanges,
        recovered_from_stall: true
      };

      if (String(latestRun?.status || '') !== 'completed') {
        await updateAgentRunRecord(run.id, {
          status: 'completed',
          result: recoveredResult,
          requiresConfirmation: false,
          appliedChanges,
          finished: true
        });
        await appendAgentEvent({
          sessionId,
          runId: run.id,
          type: 'complete',
          step: 'recovered_complete',
          message: '本次 Agent 已实际改动项目；收尾阶段超时，已按完成态保底收口。',
          payload: {
            recovered_from_stall: true
          }
        });
      }

      await appendAcceptedAssistantReply({
        sessionId,
        runId: run.id,
        reply: recoveredReply,
        run: {
          ...(latestRun || {}),
          status: 'completed',
          result: recoveredResult,
          model: latestRun?.model || requestedModel,
          provider: latestRun?.provider || requestedProvider
        }
      });
      await touchAgentSession(sessionId, {
        summary: mergeSessionSummary(session.summary, userPrompt, recoveredReply, appliedChanges)
      });

      return {
        success: true,
        session_id: sessionId,
        run_id: run.id,
        reply: recoveredReply,
        status: 'completed',
        requires_confirmation: false,
        applied_changes: appliedChanges,
        result: recoveredResult
      };
    }

    const failureMessage = String(error?.message || 'Project agent failed');
    await updateAgentRunRecord(run.id, {
      status: 'failed',
      result: {
        reply: `执行失败：${failureMessage}`,
        summary: failureMessage
      },
      requiresConfirmation: false,
      finished: true
    });
    await appendAgentEvent({
      sessionId,
      runId: run.id,
      type: 'error',
      step: 'runtime',
      message: failureMessage,
      payload: {}
    });
    await appendAgentMessage({
      sessionId,
      runId: run.id,
      role: 'assistant',
      content: `执行失败：${failureMessage}`,
      metadata: {
        status: 'failed'
      }
    });
    throw error;
  } finally {
    activeRunAbortControllers.delete(run.id);
    cancellationRequestedRuns.delete(run.id);
  }
}

export async function runProjectAgentSessionWorkflow({
  projectId,
  sessionId,
  mode = 'custom',
  prompt = '',
  topic = '',
  target_minutes: targetMinutes = 0,
  preference_prompt: preferencePrompt = '',
  provider = '',
  model = '',
  onEvent = () => {}
}) {
  return runProjectAgentInternal({
    projectId,
    sessionId,
    mode,
    prompt,
    topic,
    target_minutes: targetMinutes,
    preference_prompt: preferencePrompt,
    provider,
    model,
    onEvent
  });
}

function buildConfirmedAssembleReply(primaryResult = {}) {
  const primarySummary = String(primaryResult?.summary || '').trim();
  const changed = primaryResult?.changed !== false;
  return [
    changed
      ? `已按确认计划执行重切：${primarySummary || '保守口播拼稿已写回当前时间线。'}`
      : `已按确认计划复查并执行重切流程：${primarySummary || '当前没有识别到可安全落地的新增删减项。'}`,
    '',
    '顺序：保持当前素材顺序不变，未主动重排。',
    '通顺：本轮只做保守删除和停顿清理，不改写原文。',
    '逻辑：优先保留主线信息，只清理重复 take、重复句和起手重说。',
    '断句：使用确定性工具按字幕/停顿边界处理，避免句中硬切。',
    '重复：已让 auto_assemble_script 重新检查并处理明确重复项。',
    '停顿：已按 0.35 秒以上候选做一轮推荐停顿清理。',
    '误删：执行前已保存快照；如某处不满意，可以用快照或后续指令恢复。',
    '改进：如还觉得偏长，下一轮建议直接指定“继续删弱过渡/空转解释”或给目标时长。'
  ].join('\n');
}

export async function confirmProjectAgentRun({ projectId, runId, approved = true }) {
  const run = await getAgentRunRecord(projectId, runId);
  if (!run) {
    throw new Error('Agent run not found');
  }

  if (String(run.status || '') !== 'waiting_confirmation') {
    return {
      success: true,
      run_id: runId,
      status: run.status,
      result: run.result || null
    };
  }

  const session = await getProjectAgentSession(projectId, run.session_id);
  if (!session) {
    throw new Error('Agent session not found');
  }

  const pendingTool = run.result?.pending_tool || null;
  if (!pendingTool?.tool) {
    throw new Error('No pending high-risk tool found for confirmation');
  }

  if (!approved) {
    return finalizeCancelledRun(projectId, run.session_id, runId, '你已取消本次高风险操作，项目保持在原状态。');
  }

  const toolStageBridge = async (stage = {}) => {
    await appendAgentEvent({
      sessionId: run.session_id,
      runId,
      type: 'stage',
      step: stage.step || 'tool_progress',
      message: stage.message || '工具正在处理当前项目…',
      payload: stage.payload || {}
    });
  };
  const toolContext = {
    approvedHighRisk: true,
    llmProvider: run.provider || '',
    llmModel: run.model || '',
    onStage: toolStageBridge,
    requestContext: {
      mode: run.mode,
      prompt: run.prompt,
      sessionId: run.session_id,
      runId
    }
  };

  const pendingExecutions = [
    ...(Array.isArray(pendingTool.pre_tools) ? pendingTool.pre_tools : []),
    {
      tool: pendingTool.tool,
      args: pendingTool.args || {}
    }
  ].filter((item) => item?.tool);
  const appliedChanges = [...(run.applied_changes || [])];
  const toolResults = [];

  for (const toolCall of pendingExecutions) {
    const toolName = String(toolCall.tool || '').trim();
    const toolArgs = toolCall.args || {};
    await appendAgentEvent({
      sessionId: run.session_id,
      runId,
      type: 'tool_call',
      step: toolName,
      message: `执行 ${toolName}`,
      payload: {
        tool: toolName,
        args: toolArgs,
        confirmed: true
      }
    });
    const toolResult = await executeProjectAgentToolDirect(projectId, toolName, toolArgs, toolContext);
    toolResults.push({
      tool: toolName,
      result: toolResult
    });
    await appendAgentEvent({
      sessionId: run.session_id,
      runId,
      type: 'tool_result',
      step: toolName,
      message: toolResult?.summary || `${toolName} 已执行。`,
      payload: {
        tool: toolName,
        result: toolResult,
        confirmed: true
      }
    });
    if (didAppliedChangeSucceed(toolResult) && toolResult?.changed !== false) {
      appliedChanges.push({
        tool: toolName,
        ...toolResult
      });
    }
  }

  const primaryResult = toolResults[toolResults.length - 1]?.result || {};
  const isAssembleRecutConfirmation = String(pendingTool.plan_kind || '') === 'assemble_recut_confirmation'
    && String(pendingTool.tool || '') === 'auto_assemble_script';
  const reply = isAssembleRecutConfirmation
    ? buildConfirmedAssembleReply(primaryResult)
    : String(primaryResult?.summary || '高风险操作已确认并执行。').trim();
  const previousResult = run.result || {};
  const finalResult = {
    ...previousResult,
    reply,
    summary: String(primaryResult?.summary || reply).trim(),
    applied_changes: appliedChanges,
    confirmed_tool_results: toolResults,
    confirmation_executed: true
  };
  delete finalResult.pending_tool;
  delete finalResult.confirmation_prompt;

  await updateAgentRunRecord(runId, {
    status: 'completed',
    result: finalResult,
    requiresConfirmation: false,
    appliedChanges,
    finished: true
  });
  await appendAgentEvent({
    sessionId: run.session_id,
    runId,
    type: 'complete',
    step: 'complete',
    message: '确认后的操作已执行完成。',
    payload: {}
  });
  await appendAgentMessage({
    sessionId: run.session_id,
    runId,
    role: 'assistant',
    content: reply,
    metadata: {
      status: 'completed'
    }
  });
  await touchAgentSession(run.session_id, {
    summary: mergeSessionSummary(session.summary, run.prompt, reply, appliedChanges)
  });

  return {
    success: true,
    run_id: runId,
    status: 'completed',
    reply,
    applied_changes: appliedChanges,
    result: finalResult
  };
}

export async function cancelProjectAgentRun({ projectId, runId }) {
  const run = await getAgentRunRecord(projectId, runId);
  if (!run) {
    throw new Error('Agent run not found');
  }

  if (['cancelled', 'completed', 'failed'].includes(String(run.status || ''))) {
    return {
      success: true,
      run_id: runId,
      status: run.status,
      result: run.result || null
    };
  }

  cancellationRequestedRuns.add(runId);
  const controller = activeRunAbortControllers.get(runId);
  if (controller && !controller.signal.aborted) {
    controller.abort(new AgentRunCancelledError());
  }

  await updateAgentRunRecord(runId, {
    status: 'cancelling',
    result: {
      ...(run.result || {}),
      reply: '已请求停止本次 Agent 执行。',
      summary: '已请求停止本次 Agent 执行。'
    }
  });

  return {
    success: true,
    run_id: runId,
    status: 'cancelling'
  };
}
