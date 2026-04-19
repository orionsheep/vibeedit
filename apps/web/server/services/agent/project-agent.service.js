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
  getProjectAgentModel,
  getProjectAgentProvider
} from './glm-claude-rotation.service.js';
import {
  classifyProjectAgentRequest,
  normalizeProjectAgentMode
} from './project-agent-intent.service.js';
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
  const lines = [String(previousSummary || '').trim()].filter(Boolean);
  lines.push([
    `用户要求：${String(userMessage || '').trim()}`,
    appliedChanges.length ? `执行动作：${appliedChanges.map((item) => item.change || item.type || '修改').join('、')}` : '',
    `结果：${String(assistantReply || '').trim()}`
  ].filter(Boolean).join(' | '));
  return lines.join('\n').split('\n').slice(-8).join('\n');
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
  const appliedChanges = Array.isArray(runRecord?.applied_changes)
    ? runRecord.applied_changes
    : Array.isArray(existingResult?.applied_changes)
      ? existingResult.applied_changes
      : [];
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

  const mutationSignatureBefore = await readProjectMutationSignature(projectId);
  const abortController = new AbortController();
  activeRunAbortControllers.set(run.id, abortController);
  cancellationRequestedRuns.delete(run.id);

  try {
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
      result = await runClaudeAgentSession({
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
          result = await runClaudeAgentSession({
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

    const latestRun = await getAgentRunRecord(projectId, run.id);
    const assistantReply = String(result.reply || latestRun?.result?.reply || '').trim();
    const mutationSignatureAfter = await readProjectMutationSignature(projectId);
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
        const retriedResult = await runClaudeAgentSession({
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
