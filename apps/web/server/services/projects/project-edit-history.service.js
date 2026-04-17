import { withDatabase } from '../core/database.service.js';

function cloneJson(value) {
  if (value === undefined || value === null) return null;
  return JSON.parse(JSON.stringify(value));
}

function normalizeStringArray(values = []) {
  return Array.isArray(values)
    ? values.map((value) => String(value || '').trim()).filter(Boolean).sort()
    : [];
}

function buildStringArrayDiff(before = [], after = []) {
  const beforeSet = new Set(normalizeStringArray(before));
  const afterSet = new Set(normalizeStringArray(after));
  return {
    added: [...afterSet].filter((value) => !beforeSet.has(value)),
    removed: [...beforeSet].filter((value) => !afterSet.has(value))
  };
}

function buildTimelineSignature(timeline = {}) {
  const clips = Array.isArray(timeline?.clips) ? timeline.clips : [];
  return clips.map((clip) => ([
    String(clip.asset_id || ''),
    Number(clip.source_start || 0),
    Number(clip.source_end || 0),
    Number(clip.timeline_start || 0),
    Number(clip.timeline_end || 0),
    Number(clip.sort_order || 0),
    String(clip.label || '')
  ]));
}

function buildTimelineClipSummary(timeline = {}) {
  return (Array.isArray(timeline?.clips) ? timeline.clips : []).map((clip) => ({
    asset_id: String(clip.asset_id || ''),
    asset_title: String(clip.asset_title || ''),
    label: String(clip.label || ''),
    source_start: Number(clip.source_start || 0),
    source_end: Number(clip.source_end || 0),
    timeline_start: Number(clip.timeline_start || 0),
    timeline_end: Number(clip.timeline_end || 0),
    sort_order: Number(clip.sort_order || 0)
  }));
}

function buildDiffSummary({
  beforeEditState = null,
  afterEditState = null,
  beforeTimeline = null,
  afterTimeline = null
} = {}) {
  const wordDiff = buildStringArrayDiff(beforeEditState?.deleted_word_keys || [], afterEditState?.deleted_word_keys || []);
  const gapDiff = buildStringArrayDiff(beforeEditState?.deleted_gap_keys || [], afterEditState?.deleted_gap_keys || []);
  const beforeTimelineSignature = JSON.stringify(buildTimelineSignature(beforeTimeline));
  const afterTimelineSignature = JSON.stringify(buildTimelineSignature(afterTimeline));

  return {
    before_version: Number(beforeEditState?.version || 0),
    after_version: Number(afterEditState?.version || 0),
    deleted_word_count_before: normalizeStringArray(beforeEditState?.deleted_word_keys || []).length,
    deleted_word_count_after: normalizeStringArray(afterEditState?.deleted_word_keys || []).length,
    deleted_gap_count_before: normalizeStringArray(beforeEditState?.deleted_gap_keys || []).length,
    deleted_gap_count_after: normalizeStringArray(afterEditState?.deleted_gap_keys || []).length,
    added_deleted_word_keys: wordDiff.added,
    removed_deleted_word_keys: wordDiff.removed,
    added_deleted_gap_keys: gapDiff.added,
    removed_deleted_gap_keys: gapDiff.removed,
    clip_count_before: Array.isArray(beforeTimeline?.clips) ? beforeTimeline.clips.length : 0,
    clip_count_after: Array.isArray(afterTimeline?.clips) ? afterTimeline.clips.length : 0,
    total_duration_before: Number(beforeTimeline?.total_duration || 0),
    total_duration_after: Number(afterTimeline?.total_duration || 0),
    timeline_changed: beforeTimelineSignature !== afterTimelineSignature,
    before_timeline_signature: buildTimelineClipSummary(beforeTimeline),
    after_timeline_signature: buildTimelineClipSummary(afterTimeline)
  };
}

function hasMeaningfulHistoryDiff(diffSummary = {}) {
  return Boolean(
    (diffSummary.added_deleted_word_keys || []).length ||
    (diffSummary.removed_deleted_word_keys || []).length ||
    (diffSummary.added_deleted_gap_keys || []).length ||
    (diffSummary.removed_deleted_gap_keys || []).length ||
    Number(diffSummary.before_version || 0) !== Number(diffSummary.after_version || 0) ||
    Boolean(diffSummary.timeline_changed) ||
    Number(diffSummary.clip_count_before || 0) !== Number(diffSummary.clip_count_after || 0) ||
    Math.abs(Number(diffSummary.total_duration_before || 0) - Number(diffSummary.total_duration_after || 0)) > 0.001
  );
}

function mapProjectEditHistory(record) {
  if (!record) return null;
  return {
    id: record.id,
    project_id: record.projectId,
    source: record.source,
    actor_type: record.actorType || '',
    operation_type: record.operationType,
    note: record.note || '',
    session_id: record.sessionId || '',
    run_id: record.runId || '',
    before_version: record.beforeVersion || 0,
    after_version: record.afterVersion || 0,
    diff_summary: record.diffSummary || {},
    before_edit_state: record.beforeEditState || null,
    after_edit_state: record.afterEditState || null,
    before_timeline: record.beforeTimeline || null,
    after_timeline: record.afterTimeline || null,
    metadata: record.metadata || {},
    created_at: record.createdAt
  };
}

export async function recordProjectEditHistoryTx(db, {
  projectId,
  source = 'system',
  actorType = '',
  operationType = 'edit_state_update',
  note = '',
  sessionId = '',
  runId = '',
  beforeEditState = null,
  afterEditState = null,
  beforeTimeline = null,
  afterTimeline = null,
  metadata = null,
  force = false
} = {}) {
  const diffSummary = buildDiffSummary({
    beforeEditState,
    afterEditState,
    beforeTimeline,
    afterTimeline
  });

  if (!force && !hasMeaningfulHistoryDiff(diffSummary)) {
    return null;
  }

  const created = await db.projectEditHistory.create({
    data: {
      projectId,
      source: String(source || 'system').trim() || 'system',
      actorType: String(actorType || '').trim() || null,
      operationType: String(operationType || 'edit_state_update').trim() || 'edit_state_update',
      note: String(note || '').trim() || null,
      sessionId: String(sessionId || '').trim() || null,
      runId: String(runId || '').trim() || null,
      beforeVersion: Number(beforeEditState?.version || 0) || null,
      afterVersion: Number(afterEditState?.version || 0) || null,
      diffSummary,
      beforeEditState: cloneJson(beforeEditState),
      afterEditState: cloneJson(afterEditState),
      beforeTimeline: cloneJson(beforeTimeline),
      afterTimeline: cloneJson(afterTimeline),
      metadata: cloneJson(metadata)
    }
  });

  return mapProjectEditHistory(created);
}

export async function recordProjectEditHistory(payload = {}) {
  return withDatabase((db) => recordProjectEditHistoryTx(db, payload));
}

export async function listProjectEditHistories(projectId, { limit = 100, source = '' } = {}) {
  return withDatabase(async (db) => {
    const records = await db.projectEditHistory.findMany({
      where: {
        projectId,
        ...(String(source || '').trim() ? { source: String(source).trim() } : {})
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(200, Math.max(1, Number(limit || 100)))
    });
    return records.map(mapProjectEditHistory);
  });
}
