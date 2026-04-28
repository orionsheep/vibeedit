import { withDatabase } from '../core/database.service.js';
import { loadConfig } from '../editor/config.js';

function mapRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    session_id: run.sessionId,
    project_id: run.projectId,
    mode: run.mode,
    status: run.status,
    prompt: run.prompt,
    provider: run.provider,
    model: run.model,
    input: run.input || {},
    plan: run.plan || null,
    result: run.result || null,
    requires_confirmation: run.requiresConfirmation,
    applied_changes: run.appliedChanges || [],
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    finished_at: run.finishedAt
  };
}

function mapMessage(message) {
  return {
    id: message.id,
    session_id: message.sessionId,
    run_id: message.runId || null,
    role: message.role,
    content: message.content,
    metadata: message.metadata || {},
    created_at: message.createdAt
  };
}

function mapEvent(event) {
  return {
    id: event.id,
    session_id: event.sessionId,
    run_id: event.runId || null,
    type: event.type,
    step: event.step || '',
    message: event.message || '',
    payload: event.payload || {},
    created_at: event.createdAt
  };
}

function mapSession(session) {
  return {
    id: session.id,
    project_id: session.projectId,
    title: session.title || '项目主会话',
    status: session.status,
    summary: session.summary || '',
    memory: session.memory || {},
    created_at: session.createdAt,
    updated_at: session.updatedAt,
    last_active_at: session.lastActiveAt
  };
}

function getAgentRunStaleTimeoutMs(config = loadConfig()) {
  const configured = Number(config.agent_run_stale_timeout_ms || 0);
  if (configured > 0) return configured;
  const timeoutMs = Number(config.agent_llm_timeout_ms || 90000);
  const inactivityTimeoutMs = Number(config.agent_llm_inactivity_timeout_ms || 90000);
  return Math.max(timeoutMs, inactivityTimeoutMs) + 60000;
}

async function settleStaleAgentRuns(db, { projectId = null, sessionId = null } = {}) {
  const staleBefore = new Date(Date.now() - getAgentRunStaleTimeoutMs());
  const staleRuns = await db.agentRun.findMany({
    where: {
      ...(projectId ? { projectId } : {}),
      ...(sessionId ? { sessionId } : {}),
      status: {
        in: ['running', 'waiting_confirmation']
      },
      updatedAt: {
        lt: staleBefore
      }
    },
    select: {
      id: true,
      status: true,
      result: true
    }
  });

  for (const run of staleRuns) {
    await db.agentRun.update({
      where: { id: run.id },
      data: {
        status: 'failed',
        result: {
          ...(run.result || {}),
          reply: '执行失败：上一轮 Agent 任务长时间无进展，系统已自动结束旧任务，请重新执行。',
          summary: 'Stale agent run auto-failed on session load'
        },
        finishedAt: new Date()
      }
    });
  }
}

export class ActiveAgentRunExistsError extends Error {
  constructor(run, message = '当前会话已有任务在执行，请等待完成或先停止当前任务。') {
    super(message);
    this.name = 'ActiveAgentRunExistsError';
    this.code = 'agent_run_active';
    this.payload = {
      active_run: run ? mapRun(run) : null
    };
  }
}

export async function listProjectAgentSessions(projectId) {
  return withDatabase(async (db) => {
    await settleStaleAgentRuns(db, { projectId });
    const sessions = await db.agentSession.findMany({
      where: { projectId },
      orderBy: [
        { lastActiveAt: 'desc' },
        { updatedAt: 'desc' }
      ]
    });
    return sessions.map(mapSession);
  });
}

export async function createProjectAgentSession(projectId, payload = {}) {
  return withDatabase(async (db) => {
    const existing = await db.agentSession.findFirst({
      where: {
        projectId,
        status: 'active'
      },
      orderBy: [
        { lastActiveAt: 'desc' },
        { updatedAt: 'desc' }
      ]
    });

    if (existing && payload?.reuse !== false) {
      return mapSession(existing);
    }

    const session = await db.agentSession.create({
      data: {
        projectId,
        title: String(payload?.title || '').trim() || '项目主会话',
        status: 'active',
        summary: '',
        memory: payload?.memory || {},
        lastActiveAt: new Date()
      }
    });

    return mapSession(session);
  });
}

export async function getProjectAgentSession(projectId, sessionId) {
  return withDatabase(async (db) => {
    await settleStaleAgentRuns(db, { projectId, sessionId });
    const session = await db.agentSession.findFirst({
      where: {
        id: sessionId,
        projectId
      },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
          take: 200
        },
        runs: {
          orderBy: { createdAt: 'desc' },
          take: 20
        },
        events: {
          orderBy: { createdAt: 'desc' },
          take: 120
        }
      }
    });

    if (!session) {
      return null;
    }

    return {
      ...mapSession(session),
      messages: session.messages.map(mapMessage),
      runs: session.runs.map(mapRun),
      events: session.events.reverse().map(mapEvent)
    };
  });
}

export async function touchAgentSession(sessionId, patch = {}) {
  return withDatabase(async (db) => {
    const session = await db.agentSession.update({
      where: { id: sessionId },
      data: {
        ...(patch.title !== undefined ? { title: patch.title || null } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.summary !== undefined ? { summary: patch.summary || '' } : {}),
        ...(patch.memory !== undefined ? { memory: patch.memory || {} } : {}),
        lastActiveAt: new Date()
      }
    });

    return mapSession(session);
  });
}

export async function createAgentRunRecord({ projectId, sessionId, mode, prompt, provider, model, input }) {
  return withDatabase(async (db) => {
    let activeRun = await db.agentRun.findFirst({
      where: {
        sessionId,
        status: {
          in: ['running', 'waiting_confirmation']
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    if (activeRun) {
      const staleTimeoutMs = getAgentRunStaleTimeoutMs();
      const ageMs = Date.now() - new Date(activeRun.updatedAt || activeRun.createdAt).getTime();
      if (ageMs >= staleTimeoutMs) {
        await db.agentRun.update({
          where: { id: activeRun.id },
          data: {
            status: 'failed',
            result: {
              reply: '执行失败：上一轮 Agent 执行超时未收尾，系统已自动结束旧任务，请重试。',
              summary: 'Stale agent run auto-failed'
            },
            finishedAt: new Date()
          }
        });
        activeRun = null;
      }
    }

    if (activeRun) {
      throw new ActiveAgentRunExistsError(activeRun);
    }

    const run = await db.agentRun.create({
      data: {
        projectId,
        sessionId,
        mode,
        prompt,
        provider: provider || null,
        model: model || null,
        input: input || {},
        status: 'running'
      }
    });

    await db.agentSession.update({
      where: { id: sessionId },
      data: { lastActiveAt: new Date() }
    });

    return mapRun(run);
  });
}

export async function updateAgentRunRecord(runId, patch = {}) {
  return withDatabase(async (db) => {
    const run = await db.agentRun.update({
      where: { id: runId },
      data: {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.plan !== undefined ? { plan: patch.plan } : {}),
        ...(patch.result !== undefined ? { result: patch.result } : {}),
        ...(patch.requiresConfirmation !== undefined ? { requiresConfirmation: Boolean(patch.requiresConfirmation) } : {}),
        ...(patch.appliedChanges !== undefined ? { appliedChanges: patch.appliedChanges || [] } : {}),
        ...(patch.finished ? { finishedAt: new Date() } : {})
      }
    });

    return mapRun(run);
  });
}

export async function getAgentRunRecord(projectId, runId) {
  return withDatabase(async (db) => {
    const run = await db.agentRun.findFirst({
      where: {
        id: runId,
        projectId
      }
    });

    return mapRun(run);
  });
}

export async function appendAgentMessage({ sessionId, runId = null, role, content, metadata = {} }) {
  return withDatabase(async (db) => {
    const message = await db.agentMessage.create({
      data: {
        sessionId,
        runId,
        role,
        content,
        metadata
      }
    });

    await db.agentSession.update({
      where: { id: sessionId },
      data: { lastActiveAt: new Date() }
    });

    return mapMessage(message);
  });
}

export async function appendAgentEvent({ sessionId, runId = null, type, step = '', message = '', payload = {} }) {
  return withDatabase(async (db) => {
    const event = await db.agentEvent.create({
      data: {
        sessionId,
        runId,
        type,
        step,
        message,
        payload
      }
    });

    if (runId) {
      const currentRun = await db.agentRun.findUnique({
        where: { id: runId },
        select: { status: true }
      });
      if (currentRun) {
        await db.agentRun.update({
          where: { id: runId },
          data: {
            status: currentRun.status
          }
        });
      }
    }

    await db.agentSession.update({
      where: { id: sessionId },
      data: { lastActiveAt: new Date() }
    });

    return mapEvent(event);
  });
}

export async function listRunEvents(runId, sessionId = null) {
  return withDatabase(async (db) => {
    const events = await db.agentEvent.findMany({
      where: {
        runId,
        ...(sessionId ? { sessionId } : {})
      },
      orderBy: { createdAt: 'asc' }
    });

    return events.map(mapEvent);
  });
}
