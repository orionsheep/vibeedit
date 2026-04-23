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

async function runAssemblePlannerQuery({
  prompt = '',
  preferredProvider = '',
  preferredModel = '',
  signal = null
}) {
  const candidate = getHealthyGlmCandidate(preferredModel, preferredProvider);
  const settings = getAgentLlmSettings();
  const plannerTimeoutMs = Math.min(30000, Math.max(12000, Number(settings.timeoutMs || 90000) - 20000));
  const runtimeDir = path.join(candidate.runtimeDir, 'planning');
  fs.mkdirSync(runtimeDir, { recursive: true });
  const abortController = new AbortController();
  let timedOut = false;
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

  const toolContext = {
    llmProvider: requestedProvider,
    llmModel: requestedModel,
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
  const maxRounds = 3;

  for (let round = 1; round <= maxRounds; round += 1) {
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

    const [projectContext, assetMap, scriptBlocks, assembleCandidates] = await Promise.all([
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
    ]);

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
        signal
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
    max_passes: 2
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

  const mutationSignatureBefore = await readProjectMutationSignature(projectId);
  const abortController = new AbortController();
  activeRunAbortControllers.set(run.id, abortController);
  cancellationRequestedRuns.delete(run.id);

  try {
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
      const routingMessage = requestProfile.routingReason === 'assemble_script_intent'
        ? '检测到口播剪辑意图，已自动切换到口播拼稿主链。'
        : requestProfile.routingReason === 'live_slicing_intent'
          ? '检测到直播切片意图，已自动切换到直播切片模式。'
        : requestProfile.routingReason === 'read_only_project_query'
          ? '检测到当前请求是读取/分析型项目问题，已切换到自由指令只读模式，不会强行改时间线。'
        : requestProfile.routingReason === 'non_assemble_project_task'
            ? '检测到当前请求不是口播拼稿，而是通用项目任务，已切换到自由指令模式处理。'
          : '检测到当前请求不是剪辑改动任务，已切换到自由指令模式处理。';
      await appendAgentEvent({
        sessionId,
        runId: run.id,
        type: 'stage',
        step: 'mode_routed',
        message: routingMessage,
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

  const result = await executeProjectAgentToolDirect(projectId, pendingTool.tool, pendingTool.args || {}, {
    approvedHighRisk: true,
    requestContext: {
      mode: run.mode,
      prompt: run.prompt,
      sessionId: run.session_id,
      runId
    }
  });
  const appliedChanges = [...(run.applied_changes || []), result];
  const reply = String(result?.summary || '高风险操作已确认并执行。').trim();

  await updateAgentRunRecord(runId, {
    status: 'completed',
    result: {
      reply,
      summary: reply,
      applied_changes: appliedChanges
    },
    requiresConfirmation: false,
    appliedChanges,
    finished: true
  });
  await appendAgentEvent({
    sessionId: run.session_id,
    runId,
    type: 'tool_result',
    step: pendingTool.tool,
    message: reply,
    payload: {
      tool: pendingTool.tool,
      result
    }
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
    applied_changes: appliedChanges
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
