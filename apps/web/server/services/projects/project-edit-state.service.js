import { withDatabase } from '../core/database.service.js';
import { recordProjectEditHistoryTx } from './project-edit-history.service.js';
import { getOrCreatePrimaryTimeline } from './project.service.js';

function roundTime(value) {
  return Number(Number(value || 0).toFixed(3));
}

function tokenizeSegmentText(text = '') {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return [];
  if (/\s/.test(value)) {
    return value.split(/\s+/).filter(Boolean);
  }
  return Array.from(value).filter((char) => /\S/.test(char));
}

export function flattenCaptionWords(payload = {}, assetId = '', durationSeconds = 0) {
  if (Array.isArray(payload?.words)) {
    return payload.words.map((word, index) => ({
      id: `${assetId}:word:${index}`,
      asset_word_index: index,
      text: String(word?.text || ''),
      start_time: roundTime(Number(word?.start_time || 0)),
      end_time: roundTime(Math.max(Number(word?.start_time || 0) + 0.01, Number(word?.end_time || word?.start_time || 0)))
    }));
  }

  if (Array.isArray(payload?.segments)) {
    const nested = payload.segments.flatMap((segment) => segment?.words || []);
    if (nested.length) {
      return nested.map((word, index) => ({
        id: `${assetId}:word:${index}`,
        asset_word_index: index,
        text: String(word?.text || ''),
        start_time: roundTime(Number(word?.start_time || 0)),
        end_time: roundTime(Math.max(Number(word?.start_time || 0) + 0.01, Number(word?.end_time || word?.start_time || 0)))
      }));
    }

    const synthetic = payload.segments.flatMap((segment, segmentIndex) => {
      const tokens = tokenizeSegmentText(segment?.text || segment?.transcript || '');
      if (!tokens.length) return [];

      const start = Number(segment?.start ?? segment?.start_time ?? 0);
      const end = Math.max(start + 0.04, Number(segment?.end ?? segment?.end_time ?? start + Math.max(tokens.length * 0.12, 0.4)));
      const unit = Math.max(0.04, (end - start) / tokens.length);

      return tokens.map((token, tokenIndex) => ({
        id: `${assetId}:synthetic:${segmentIndex}:${tokenIndex}`,
        text: token,
        start_time: roundTime(start + unit * tokenIndex),
        end_time: roundTime(tokenIndex === tokens.length - 1 ? end : start + unit * (tokenIndex + 1))
      }));
    });

    return synthetic.map((word, index) => ({
      ...word,
      id: `${assetId}:word:${index}`,
      asset_word_index: index
    }));
  }

  const fallbackText = String(payload?.text || '').trim();
  if (fallbackText) {
    const tokens = tokenizeSegmentText(fallbackText);
    const totalDuration = Math.max(Number(durationSeconds || 0), tokens.length * 0.12);
    const unit = Math.max(0.04, totalDuration / Math.max(tokens.length, 1));
    return tokens.map((token, index) => ({
      id: `${assetId}:word:${index}`,
      asset_word_index: index,
      text: token,
      start_time: roundTime(unit * index),
      end_time: roundTime(index === tokens.length - 1 ? totalDuration : unit * (index + 1))
    }));
  }

  return [];
}

function normalizeStringArray(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean))];
}

function normalizeReplacementArray(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => ({
      assetId: String(item?.assetId || item?.asset_id || '').trim(),
      startWordIndex: Number(item?.startWordIndex ?? item?.start_word_index ?? -1),
      endWordIndex: Number(item?.endWordIndex ?? item?.end_word_index ?? -1),
      replacementText: String(item?.replacementText ?? item?.replacement_text ?? '').trim()
    }))
    .filter((item) => item.assetId && Number.isInteger(item.startWordIndex) && Number.isInteger(item.endWordIndex) && item.endWordIndex >= item.startWordIndex);
}

function normalizeEditStateRecord(record = {}) {
  return {
    id: record.id,
    project_id: record.projectId,
    asset_order: normalizeStringArray(record.assetOrder),
    deleted_word_keys: normalizeStringArray(record.deletedWordKeys),
    deleted_gap_keys: normalizeStringArray(record.deletedGapKeys),
    text_replacements: normalizeReplacementArray(record.textReplacements),
    version: Number(record.version || 1),
    created_at: record.createdAt,
    updated_at: record.updatedAt
  };
}

function areStringArraysEqual(left = [], right = []) {
  if (left.length !== right.length) return false;
  return left.every((item, index) => item === right[index]);
}

function areReplacementArraysEqual(left = [], right = []) {
  if (left.length !== right.length) return false;
  return left.every((item, index) => (
    item.assetId === right[index]?.assetId &&
    Number(item.startWordIndex) === Number(right[index]?.startWordIndex) &&
    Number(item.endWordIndex) === Number(right[index]?.endWordIndex) &&
    String(item.replacementText || '') === String(right[index]?.replacementText || '')
  ));
}

function mergeAssetOrder(savedOrder = [], activeAssetIds = []) {
  const activeSet = new Set(activeAssetIds);
  const merged = normalizeStringArray(savedOrder).filter((assetId) => activeSet.has(assetId));
  for (const assetId of activeAssetIds) {
    if (!merged.includes(assetId)) {
      merged.push(assetId);
    }
  }
  return merged;
}

function makeWordKey(assetId, assetWordIndex) {
  return `${assetId}:word:${Number(assetWordIndex || 0)}`;
}

function makeGapKey(assetId, assetWordIndex) {
  return `${assetId}:gap:${Number(assetWordIndex || 0)}`;
}

function findReplacementWindowByText(originalWords = [], replacementText = '') {
  const normalizedOriginal = originalWords.map((word) => String(word?.text || '')).join('');
  const normalizedReplacement = tokenizeSegmentText(replacementText).join('');
  if (!normalizedOriginal || !normalizedReplacement) return null;

  const matches = [];
  let cursor = normalizedOriginal.indexOf(normalizedReplacement);
  while (cursor !== -1) {
    matches.push({
      startChar: cursor,
      endChar: cursor + normalizedReplacement.length
    });
    cursor = normalizedOriginal.indexOf(normalizedReplacement, cursor + 1);
  }

  if (matches.length !== 1) return null;

  const [{ startChar, endChar }] = matches;
  let charCursor = 0;
  let start = -1;
  let end = -1;

  for (let index = 0; index < originalWords.length; index += 1) {
    const wordText = String(originalWords[index]?.text || '');
    const wordLength = wordText.length;
    const wordStart = charCursor;
    const wordEnd = charCursor + wordLength;

    if (start === -1 && startChar < wordEnd) {
      start = index;
    }

    if (start !== -1 && endChar <= wordEnd) {
      end = index;
      break;
    }

    charCursor = wordEnd;
  }

  if (start === -1 || end === -1) return null;

  return { start, end };
}

function normalizeComparableToken(token = '') {
  return String(token || '')
    .replace(/\s+/g, '')
    .replace(/[，。！？、,.!?;；:：“”"'‘’（）()【】\[\]<>《》]/g, '')
    .trim();
}

function findReplacementWindowByTokenSequence(originalWords = [], replacementText = '') {
  const originalTokens = originalWords.map((word) => normalizeComparableToken(word?.text || ''));
  const replacementTokens = tokenizeSegmentText(replacementText).map((token) => normalizeComparableToken(token)).filter(Boolean);
  if (!originalTokens.length || !replacementTokens.length) return null;

  const matches = [];
  for (let start = 0; start <= originalTokens.length - replacementTokens.length; start += 1) {
    let same = true;
    for (let offset = 0; offset < replacementTokens.length; offset += 1) {
      if (originalTokens[start + offset] !== replacementTokens[offset]) {
        same = false;
        break;
      }
    }
    if (same) {
      matches.push({
        start,
        end: start + replacementTokens.length - 1
      });
    }
  }

  if (matches.length !== 1) return null;
  return matches[0];
}

function findReplacementSubsequence(originalWords = [], replacementText = '') {
  const originalTokens = originalWords.map((word) => normalizeComparableToken(word?.text || ''));
  const replacementTokens = tokenizeSegmentText(replacementText)
    .map((token) => normalizeComparableToken(token))
    .filter(Boolean);

  if (!originalTokens.length || !replacementTokens.length) return null;

  const matchedIndices = [];
  let cursor = 0;

  for (const replacementToken of replacementTokens) {
    let foundAt = -1;
    for (let index = cursor; index < originalTokens.length; index += 1) {
      if (originalTokens[index] === replacementToken) {
        foundAt = index;
        break;
      }
    }
    if (foundAt === -1) {
      return null;
    }
    matchedIndices.push(foundAt);
    cursor = foundAt + 1;
  }

  return {
    matchedIndices,
    start: matchedIndices[0],
    end: matchedIndices[matchedIndices.length - 1]
  };
}

function canonicalizeEditStateAgainstProject(project, editState) {
  const relationMap = new Map((project.projectAssets || []).map((relation) => [relation.assetId, relation]));
  const nextDeletedWordKeys = new Set(normalizeStringArray(editState.deleted_word_keys));
  const nextTextReplacements = [];

  for (const replacement of normalizeReplacementArray(editState.text_replacements)) {
    const relation = relationMap.get(replacement.assetId);
    const asset = relation?.asset;
    if (!asset) continue;

    const payload = asset.captions?.[0]?.payload || {};
    const baseWords = flattenCaptionWords(payload, asset.id, Number(asset.durationSeconds || 0));
    const spanWords = baseWords.slice(replacement.startWordIndex, replacement.endWordIndex + 1);
    if (!spanWords.length) continue;

    const replacementTokens = tokenizeSegmentText(replacement.replacementText);

    if (!replacementTokens.length) {
      for (let index = replacement.startWordIndex; index <= replacement.endWordIndex; index += 1) {
        nextDeletedWordKeys.add(makeWordKey(replacement.assetId, index));
      }
      continue;
    }

    const subsequence = findReplacementSubsequence(spanWords, replacement.replacementText);
    if (subsequence) {
      const keptIndexSet = new Set(subsequence.matchedIndices);
      const keptWholeSpan = subsequence.matchedIndices.length === spanWords.length;
      if (!keptWholeSpan) {
        for (let offset = 0; offset < spanWords.length; offset += 1) {
          if (keptIndexSet.has(offset)) continue;
          nextDeletedWordKeys.add(makeWordKey(replacement.assetId, replacement.startWordIndex + offset));
        }
      }
      continue;
    }

    const window = findReplacementWindowByTokenSequence(spanWords, replacement.replacementText)
      || findReplacementWindowByText(spanWords, replacement.replacementText);
    if (window) {
      const keptWholeSpan = window.start === 0 && window.end === spanWords.length - 1;
      if (!keptWholeSpan) {
        for (let offset = 0; offset < spanWords.length; offset += 1) {
          if (offset >= window.start && offset <= window.end) continue;
          nextDeletedWordKeys.add(makeWordKey(replacement.assetId, replacement.startWordIndex + offset));
        }
      }
      continue;
    }

    nextTextReplacements.push(replacement);
  }

  return {
    ...editState,
    deleted_word_keys: normalizeStringArray([...nextDeletedWordKeys]),
    text_replacements: normalizeReplacementArray(nextTextReplacements)
  };
}

async function loadProjectGraph(db, projectId) {
  return db.project.findUnique({
    where: { id: projectId },
    include: {
      projectAssets: {
        orderBy: { sortOrder: 'asc' },
        include: {
          asset: {
            include: {
              files: true,
              captions: {
                orderBy: { createdAt: 'desc' },
                take: 1
              }
            }
          }
        }
      },
      captionOverrides: true
    }
  });
}

async function ensureProjectEditStateRecord(db, projectId) {
  const project = await loadProjectGraph(db, projectId);
  if (!project) {
    throw new Error('Project not found');
  }

  const activeAssetIds = project.projectAssets.map((relation) => relation.assetId);
  const existing = await db.projectEditState.findUnique({
    where: { projectId }
  });

  if (!existing) {
    let created = null;
    try {
      created = await db.projectEditState.create({
        data: {
          projectId,
          assetOrder: activeAssetIds,
          deletedWordKeys: [],
          deletedGapKeys: [],
          textReplacements: []
        }
      });
    } catch (error) {
      if (String(error?.code || '') !== 'P2002') {
        throw error;
      }
      created = await db.projectEditState.findUnique({
        where: { projectId }
      });
      if (!created) {
        throw error;
      }
    }
    return {
      project,
      record: created
    };
  }

  const mergedOrder = mergeAssetOrder(existing.assetOrder, activeAssetIds);
  const orderChanged = JSON.stringify(mergedOrder) !== JSON.stringify(normalizeStringArray(existing.assetOrder));
  if (!orderChanged) {
    return {
      project,
      record: existing
    };
  }

  const updated = await db.projectEditState.update({
    where: { projectId },
    data: {
      assetOrder: mergedOrder,
      version: { increment: 1 }
    }
  });

  return {
    project,
    record: updated
  };
}

export function applyProjectTextReplacements(baseWords = [], replacements = [], assetId = '') {
  if (!replacements.length) {
    return baseWords.map((word, index) => ({
      ...word,
      id: makeWordKey(assetId, index),
      asset_word_index: index
    }));
  }

  const words = baseWords.map((word) => ({ ...word }));
  const byAsset = replacements
    .filter((item) => item.assetId === assetId)
    .sort((left, right) => right.startWordIndex - left.startWordIndex);

  for (const replacement of byAsset) {
    const leftWord = words[replacement.startWordIndex];
    const rightWord = words[replacement.endWordIndex];
    if (!leftWord || !rightWord) continue;

    const tokens = tokenizeSegmentText(replacement.replacementText);
    if (!tokens.length) continue;

    const spanStart = Number(leftWord.start_time || 0);
    const spanEnd = Math.max(spanStart + 0.04, Number(rightWord.end_time || spanStart + 0.04));
    const unit = Math.max(0.04, (spanEnd - spanStart) / tokens.length);

    const replacementWords = tokens.map((token, tokenIndex) => ({
      text: token,
      start_time: roundTime(spanStart + unit * tokenIndex),
      end_time: roundTime(tokenIndex === tokens.length - 1 ? spanEnd : spanStart + unit * (tokenIndex + 1))
    }));

    words.splice(replacement.startWordIndex, replacement.endWordIndex - replacement.startWordIndex + 1, ...replacementWords);
  }

  return words.map((word, index) => ({
    ...word,
    id: makeWordKey(assetId, index),
    asset_word_index: index
  }));
}

function buildProjectSourceState(project, editState) {
  const relationMap = new Map((project.projectAssets || []).map((relation) => [relation.assetId, relation]));
  const orderedAssetIds = mergeAssetOrder(editState.asset_order, project.projectAssets.map((relation) => relation.assetId));
  const orderedRelations = orderedAssetIds
    .map((assetId) => relationMap.get(assetId))
    .filter(Boolean);

  let cursor = 0;
  const assetTimelineRanges = [];
  const words = [];

  for (const relation of orderedRelations) {
    const asset = relation.asset;
    const payload = asset.captions?.[0]?.payload || {};
    const replacementWords = applyProjectTextReplacements(
      flattenCaptionWords(payload, asset.id, Number(asset.durationSeconds || 0)),
      editState.text_replacements,
      asset.id
    );
    const assetDuration = Math.max(
      Number(asset.durationSeconds || 0),
      replacementWords.length ? Number(replacementWords[replacementWords.length - 1].end_time || 0) : 0
    );
    const assetStart = cursor;
    const assetEnd = roundTime(assetStart + assetDuration);

    assetTimelineRanges.push({
      asset_id: asset.id,
      asset_title: asset.title,
      asset_source_url: `/api/library/assets/${asset.id}/source`,
      timeline_start: roundTime(assetStart),
      timeline_end: assetEnd,
      source_start: 0,
      source_end: roundTime(assetDuration),
      duration: roundTime(assetDuration)
    });

    for (const word of replacementWords) {
      words.push({
        id: word.id,
        word_key: word.id,
        gap_key_after: makeGapKey(asset.id, word.asset_word_index),
        asset_id: asset.id,
        asset_title: asset.title,
        asset_word_index: word.asset_word_index,
        text: String(word.text || ''),
        start_time: roundTime(assetStart + Number(word.start_time || 0)),
        end_time: roundTime(assetStart + Number(word.end_time || word.start_time || 0)),
        source_start_time: roundTime(Number(word.start_time || 0)),
        source_end_time: roundTime(Number(word.end_time || word.start_time || 0))
      });
    }

    cursor = assetEnd;
  }

  return {
    project_id: project.id,
    asset_order: orderedAssetIds,
    asset_timeline_ranges: assetTimelineRanges,
    words,
    duration: roundTime(cursor),
    deleted_word_keys: editState.deleted_word_keys,
    deleted_gap_keys: editState.deleted_gap_keys,
    text_replacements: editState.text_replacements,
    version: editState.version
  };
}

function buildAssetTranscriptMap(sourceState = {}) {
  const transcriptMap = new Map();
  for (const word of sourceState.words || []) {
    const assetId = String(word.asset_id || '').trim();
    if (!assetId) continue;
    const current = transcriptMap.get(assetId) || '';
    transcriptMap.set(assetId, `${current}${String(word.text || '')}`);
  }
  return transcriptMap;
}

async function syncProjectCaptionOverrideSummaries(db, project, sourceState) {
  const trackedAssetIds = new Set([
    ...(project.captionOverrides || []).map((item) => item.assetId),
    ...((sourceState.text_replacements || []).map((item) => item.assetId))
  ]);

  if (!trackedAssetIds.size) return;

  const transcriptMap = buildAssetTranscriptMap(sourceState);
  for (const assetId of trackedAssetIds) {
    await db.projectCaptionOverride.upsert({
      where: {
        projectId_assetId: {
          projectId: project.id,
          assetId
        }
      },
      update: {
        transcriptText: transcriptMap.get(assetId) || '',
        payload: {}
      },
      create: {
        projectId: project.id,
        assetId,
        transcriptText: transcriptMap.get(assetId) || '',
        payload: {}
      }
    });
  }
}

async function ensureProjectEditStateConsistencyWithDb(db, projectId) {
  const { project, record } = await ensureProjectEditStateRecord(db, projectId);
  const currentState = normalizeEditStateRecord(record);
  const canonicalState = canonicalizeEditStateAgainstProject(project, currentState);
  const mergedAssetOrder = mergeAssetOrder(canonicalState.asset_order, project.projectAssets.map((relation) => relation.assetId));

  const validationSource = buildProjectSourceState(project, {
    ...canonicalState,
    asset_order: mergedAssetOrder
  });
  const validWordKeys = new Set(validationSource.words.map((word) => word.word_key));
  const validGapKeys = new Set(validationSource.words.map((word) => word.gap_key_after));

  const nextState = {
    asset_order: mergedAssetOrder,
    deleted_word_keys: normalizeStringArray(canonicalState.deleted_word_keys).filter((key) => validWordKeys.has(key)),
    deleted_gap_keys: normalizeStringArray(canonicalState.deleted_gap_keys).filter((key) => validGapKeys.has(key)),
    text_replacements: normalizeReplacementArray(canonicalState.text_replacements)
  };

  const stateChanged =
    !areStringArraysEqual(currentState.asset_order, nextState.asset_order) ||
    !areStringArraysEqual(currentState.deleted_word_keys, nextState.deleted_word_keys) ||
    !areStringArraysEqual(currentState.deleted_gap_keys, nextState.deleted_gap_keys) ||
    !areReplacementArraysEqual(currentState.text_replacements, nextState.text_replacements);

  if (!stateChanged) {
    const source_state = buildProjectSourceState(project, currentState);
    return {
      project,
      record,
      edit_state: currentState,
      source_state,
      changed: false
    };
  }

  const updated = await db.projectEditState.update({
    where: { projectId },
    data: {
      assetOrder: nextState.asset_order,
      deletedWordKeys: nextState.deleted_word_keys,
      deletedGapKeys: nextState.deleted_gap_keys,
      textReplacements: nextState.text_replacements,
      version: { increment: 1 }
    }
  });

  const normalized = normalizeEditStateRecord(updated);
  const source_state = buildProjectSourceState(project, normalized);
  await materializeTimelineClips(db, projectId, buildTimelineClipSpecsFromSource(source_state));
  await syncProjectCaptionOverrideSummaries(db, project, source_state);
  const timeline = await readMaterializedTimeline(db, projectId);

  return {
    project,
    record: updated,
    edit_state: normalized,
    source_state,
    timeline,
    changed: true
  };
}

function buildTimelineClipSpecsFromSource(sourceState) {
  const deletedWordKeys = new Set(sourceState.deleted_word_keys || []);
  const deletedGapKeys = new Set(sourceState.deleted_gap_keys || []);
  const words = Array.isArray(sourceState.words) ? sourceState.words : [];
  const clips = [];
  let current = null;

  const pushCurrent = () => {
    if (!current) return;
    clips.push({
      asset_id: current.asset_id,
      label: current.asset_title,
      source_start: roundTime(current.source_start),
      source_end: roundTime(current.source_end)
    });
    current = null;
  };

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const kept = !deletedWordKeys.has(word.word_key);
    const nextWord = words[index + 1];
    const nextKept = nextWord ? !deletedWordKeys.has(nextWord.word_key) : false;
    const breakAfter = deletedGapKeys.has(word.gap_key_after) || !nextWord || nextWord.asset_id !== word.asset_id;

    if (!kept) {
      pushCurrent();
      continue;
    }

    if (!current) {
      current = {
        asset_id: word.asset_id,
        asset_title: word.asset_title,
        source_start: word.source_start_time,
        source_end: word.source_end_time
      };
    } else {
      current.source_end = word.source_end_time;
    }

    if (breakAfter || !nextKept) {
      pushCurrent();
    }
  }

  return clips.filter((clip) => Number(clip.source_end || 0) - Number(clip.source_start || 0) > 0.001);
}

async function materializeTimelineClips(db, projectId, clipSpecs = []) {
  const timeline = await getOrCreatePrimaryTimeline(projectId);
  const videoTrack = timeline.tracks.find((track) => track.kind === 'video') || timeline.tracks[0];
  const existing = await db.timelineClip.findMany({
    where: {
      timelineId: timeline.id,
      trackId: videoTrack.id
    },
    orderBy: { sortOrder: 'asc' }
  });

  let cursor = 0;
  const desired = clipSpecs.map((clip, index) => {
    const safeStart = Number(clip.source_start ?? clip.start ?? 0);
    const safeEnd = Number(clip.source_end ?? clip.end ?? safeStart);
    const duration = Math.max(0.1, safeEnd - safeStart);
    const value = {
      assetId: clip.asset_id,
      label: clip.label || null,
      sourceStartSeconds: roundTime(safeStart),
      sourceEndSeconds: roundTime(safeEnd),
      timelineStartSeconds: roundTime(cursor),
      timelineEndSeconds: roundTime(cursor + duration),
      sortOrder: index + 1
    };
    cursor += duration;
    return value;
  });

  const overlap = Math.min(existing.length, desired.length);
  for (let index = 0; index < overlap; index += 1) {
    const current = existing[index];
    const next = desired[index];
    const needsUpdate =
      current.assetId !== next.assetId ||
      String(current.label || '') !== String(next.label || '') ||
      Math.abs(Number(current.sourceStartSeconds || 0) - Number(next.sourceStartSeconds || 0)) > 0.001 ||
      Math.abs(Number(current.sourceEndSeconds || 0) - Number(next.sourceEndSeconds || 0)) > 0.001 ||
      Math.abs(Number(current.timelineStartSeconds || 0) - Number(next.timelineStartSeconds || 0)) > 0.001 ||
      Math.abs(Number(current.timelineEndSeconds || 0) - Number(next.timelineEndSeconds || 0)) > 0.001 ||
      Number(current.sortOrder || 0) !== Number(next.sortOrder || 0);
    if (!needsUpdate) continue;
    await db.timelineClip.update({
      where: { id: current.id },
      data: next
    });
  }

  for (let index = overlap; index < desired.length; index += 1) {
    await db.timelineClip.create({
      data: {
        timelineId: timeline.id,
        trackId: videoTrack.id,
        ...desired[index]
      }
    });
  }

  for (let index = overlap; index < existing.length; index += 1) {
    await db.timelineClip.delete({
      where: { id: existing[index].id }
    });
  }
}

async function readMaterializedTimeline(db, projectId) {
  const timeline = await db.timeline.findFirst({
    where: {
      projectId,
      isPrimary: true
    },
    include: {
      clips: {
        orderBy: { sortOrder: 'asc' },
        include: {
          asset: {
            include: {
              files: true
            }
          }
        }
      }
    }
  });

  const clips = (timeline?.clips || []).map((clip) => ({
    id: clip.id,
    asset_id: clip.assetId,
    asset_title: clip.asset.title,
    asset_source_url: `/api/library/assets/${clip.assetId}/source`,
    label: clip.label || clip.asset.title,
    source_start: clip.sourceStartSeconds,
    source_end: clip.sourceEndSeconds,
    timeline_start: clip.timelineStartSeconds,
    timeline_end: clip.timelineEndSeconds,
    duration: roundTime(clip.timelineEndSeconds - clip.timelineStartSeconds),
    sort_order: clip.sortOrder
  }));

  return {
    id: timeline?.id || null,
    project_id: projectId,
    name: timeline?.name || 'Main Timeline',
    total_duration: clips.length ? clips[clips.length - 1].timeline_end : 0,
    clips
  };
}

export async function getProjectEditState(projectId) {
  return withDatabase(async (db) => {
    const { edit_state } = await ensureProjectEditStateConsistencyWithDb(db, projectId);
    return edit_state;
  });
}

export async function loadProjectEditSource(projectId) {
  return withDatabase(async (db) => {
    const { source_state } = await ensureProjectEditStateConsistencyWithDb(db, projectId);
    return source_state;
  });
}

export async function ensureProjectEditStateConsistency(projectId) {
  return withDatabase(async (db) => ensureProjectEditStateConsistencyWithDb(db, projectId));
}

export async function saveProjectEditState(projectId, payload = {}) {
  return withDatabase(async (db) => {
    const { project, record } = await ensureProjectEditStateRecord(db, projectId);
    const currentState = normalizeEditStateRecord(record);
    const currentTimeline = await readMaterializedTimeline(db, projectId);
    const assetOrder = mergeAssetOrder(
      payload.assetOrder ?? payload.asset_order ?? currentState.asset_order,
      project.projectAssets.map((relation) => relation.assetId)
    );
    const sourceForValidation = buildProjectSourceState(project, {
      ...currentState,
      asset_order: assetOrder,
      deleted_word_keys: currentState.deleted_word_keys,
      deleted_gap_keys: currentState.deleted_gap_keys,
      text_replacements: currentState.text_replacements
    });
    const validWordKeys = new Set(sourceForValidation.words.map((word) => word.word_key));
    const validGapKeys = new Set(sourceForValidation.words.map((word) => word.gap_key_after));

    const nextState = canonicalizeEditStateAgainstProject(project, {
      asset_order: assetOrder,
      deleted_word_keys: normalizeStringArray(payload.deletedWordKeys ?? payload.deleted_word_keys ?? currentState.deleted_word_keys)
        .filter((key) => validWordKeys.has(key)),
      deleted_gap_keys: normalizeStringArray(payload.deletedGapKeys ?? payload.deleted_gap_keys ?? currentState.deleted_gap_keys)
        .filter((key) => validGapKeys.has(key)),
      text_replacements: normalizeReplacementArray(payload.textReplacements ?? payload.text_replacements ?? currentState.text_replacements)
    });

    const stateChanged =
      !areStringArraysEqual(currentState.asset_order, nextState.asset_order) ||
      !areStringArraysEqual(currentState.deleted_word_keys, nextState.deleted_word_keys) ||
      !areStringArraysEqual(currentState.deleted_gap_keys, nextState.deleted_gap_keys) ||
      !areReplacementArraysEqual(currentState.text_replacements, nextState.text_replacements);

    if (!stateChanged) {
      return {
        edit_state: currentState,
        timeline: currentTimeline
      };
    }

    const updated = await db.projectEditState.update({
      where: { projectId },
      data: {
        assetOrder: nextState.asset_order,
        deletedWordKeys: nextState.deleted_word_keys,
        deletedGapKeys: nextState.deleted_gap_keys,
        textReplacements: nextState.text_replacements,
        version: { increment: 1 }
      }
    });

    const normalized = normalizeEditStateRecord(updated);
    const sourceState = buildProjectSourceState(project, normalized);
    await materializeTimelineClips(db, projectId, buildTimelineClipSpecsFromSource(sourceState));
    await syncProjectCaptionOverrideSummaries(db, project, sourceState);
    const timeline = await readMaterializedTimeline(db, projectId);
    await recordProjectEditHistoryTx(db, {
      projectId,
      source: payload.source || 'system',
      actorType: payload.actorType || payload.actor_type || '',
      operationType: payload.operationType || payload.operation_type || 'edit_state_update',
      note: payload.note || '',
      sessionId: payload.sessionId || payload.session_id || '',
      runId: payload.runId || payload.run_id || '',
      beforeEditState: currentState,
      afterEditState: normalized,
      beforeTimeline: currentTimeline,
      afterTimeline: timeline,
      metadata: payload.metadata || null,
      force: Boolean(payload.forceHistory)
    });

    return {
      edit_state: normalized,
      timeline
    };
  });
}

export async function realignProjectEditState(projectId) {
  return withDatabase(async (db) => {
    const { project, record } = await ensureProjectEditStateRecord(db, projectId);
    const normalized = normalizeEditStateRecord(record);
    const canonicalState = canonicalizeEditStateAgainstProject(project, normalized);
    const mergedOrder = mergeAssetOrder(canonicalState.asset_order, project.projectAssets.map((relation) => relation.assetId));
    const validationSource = buildProjectSourceState(project, {
      ...canonicalState,
      asset_order: mergedOrder
    });
    const validWordKeys = new Set(validationSource.words.map((word) => word.word_key));
    const validGapKeys = new Set(validationSource.words.map((word) => word.gap_key_after));

    const updated = await db.projectEditState.update({
      where: { projectId },
      data: {
        assetOrder: mergedOrder,
        deletedWordKeys: canonicalState.deleted_word_keys.filter((key) => validWordKeys.has(key)),
        deletedGapKeys: canonicalState.deleted_gap_keys.filter((key) => validGapKeys.has(key)),
        textReplacements: canonicalState.text_replacements,
        version: { increment: 1 }
      }
    });

    const nextState = normalizeEditStateRecord(updated);
    const sourceState = buildProjectSourceState(project, nextState);
    await materializeTimelineClips(db, projectId, buildTimelineClipSpecsFromSource(sourceState));
    await syncProjectCaptionOverrideSummaries(db, project, sourceState);
    const timeline = await readMaterializedTimeline(db, projectId);
    return {
      edit_state: nextState,
      timeline
    };
  });
}

export function buildDeletedWordKeysFromMask(words = [], keptMask = []) {
  return words.flatMap((word, index) => (keptMask[index] ? [] : [String(word.word_key || word.id || '')])).filter(Boolean);
}

export function buildDeletedGapKeysFromSet(words = [], deletedGapIndices = new Set()) {
  const keys = [];
  deletedGapIndices.forEach((index) => {
    const word = words[index];
    if (!word) return;
    keys.push(String(word.gap_key_after || makeGapKey(word.asset_id, word.asset_word_index)));
  });
  return normalizeStringArray(keys);
}

export function buildDeletedGapKeySet(sourceState = {}) {
  return new Set(normalizeStringArray(sourceState.deleted_gap_keys));
}

export function buildDeletedWordKeySet(sourceState = {}) {
  return new Set(normalizeStringArray(sourceState.deleted_word_keys));
}
