import { createSdkMcpServer, tool as sdkTool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  toolAutoAssembleScript,
  toolGetAssetScriptMap,
  toolGetAssembleCandidates,
  toolGetDeletedSubtitleBlocks,
  toolGetPauseCandidates,
  toolDeleteSubtitleBlocks,
  toolDeleteWordsByPhrase,
  toolCreateProjectSlice,
  toolDeleteProjectSlice,
  toolExportVideo,
  toolGetProjectSliceDetail,
  toolClearDeleted,
  toolGetProjectContext,
  toolGetScriptBlocks,
  toolListProjectSlices,
  toolGetSubtitleBlocks,
  toolGetTimelineDetail,
  toolListProjectAssets,
  toolRemoveAllPauses,
  toolRemovePauses,
  toolRemoveProjectAsset,
  toolReorderProjectAssets,
  toolSearchProjectSubtitles,
  toolSuggestProjectSlices,
  toolReplaceSubtitleText,
  toolRestoreSubtitleBlocks,
  toolRestoreWordsByPhrase,
  toolSaveSnapshot
} from './project-agent-tools.service.js';

function formatTime(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return '0.00';
  return number.toFixed(2);
}

function formatSubtitleLikeBlocks(blocks = []) {
  return (blocks || [])
    .map((block) => {
      const order = block.order != null ? `#${block.order}` : block.id;
      const asset = block.asset_title ? `[${block.asset_title}] ` : '';
      const text = String(block.text || '').trim().replace(/\s+/g, ' ');
      const preview = text.length > 120 ? `${text.slice(0, 120)}…` : text;
      return `${order} ${asset}${formatTime(block.start)}-${formatTime(block.end)} ${preview}`;
    })
    .join('\n');
}

function formatPauseCandidates(candidates = []) {
  return (candidates || [])
    .map((candidate, index) => {
      const asset = candidate.asset_title ? `[${candidate.asset_title}] ` : '';
      const left = String(candidate.left_preview || '').trim();
      const right = String(candidate.right_preview || '').trim();
      const tags = [
        candidate.recommended ? '推荐' : '',
        candidate.safety_level ? `安全:${candidate.safety_level}` : '',
        ...(Array.isArray(candidate.suggestion_reasons) ? candidate.suggestion_reasons.slice(0, 2) : [])
      ].filter(Boolean);
      return `${index + 1}. ${asset}${formatTime(candidate.start)}-${formatTime(candidate.end)} gap ${formatTime(candidate.gap_seconds)}s${tags.length ? ` [${tags.join(' / ')}]` : ''} | gap_key=${candidate.gap_key} | ${left} ⇢ ${right}`;
    })
    .join('\n');
}

function compactResultPayload(toolName, result = {}) {
  switch (toolName) {
    case 'get_project_context':
    case 'get_asset_script_map':
      return {
        project_name: result.project_name,
        project_description: result.project_description,
        asset_count: result.asset_count,
        clip_count: result.clip_count,
        kept_word_count: result.kept_word_count,
        total_word_count: result.total_word_count,
        current_cut_duration_seconds: result.current_cut_duration_seconds,
        assets: result.assets || []
      };
    case 'get_timeline_detail':
      return {
        clip_count: result.clip_count,
        current_cut_duration_seconds: result.current_cut_duration_seconds,
        offset: result.offset ?? 0,
        has_more: result.has_more ?? false,
        next_offset: result.next_offset ?? null
      };
    case 'list_project_assets':
      return {
        asset_count: Array.isArray(result.assets) ? result.assets.length : 0,
        assets: result.assets || []
      };
    case 'list_project_slices':
      return {
        slice_count: Array.isArray(result.slices) ? result.slices.length : Number(result.slice_count || 0)
      };
    case 'suggest_project_slices':
      return {
        suggestion_count: Array.isArray(result.suggestions) ? result.suggestions.length : Number(result.suggestion_count || 0)
      };
    case 'get_project_slice_detail':
      return {
        slice: result.slice
          ? {
              id: result.slice.id,
              title: result.slice.title,
              total_duration: result.slice.total_duration,
              clip_count: result.slice.clip_count
            }
          : undefined
      };
    case 'get_subtitle_blocks':
    case 'get_script_blocks':
    case 'get_deleted_subtitle_blocks':
    case 'get_assemble_candidates':
      return {
        total: result.total,
        offset: result.offset,
        has_more: result.has_more,
        next_offset: result.next_offset,
        block_count: Number(result.script_block_count || 0) || (Array.isArray(result.blocks) ? result.blocks.length : 0),
        take_group_count: result.take_group_count,
        block_group_count: result.block_group_count,
        sentence_group_count: result.sentence_group_count,
        restart_fragment_count: result.restart_fragment_count,
        pause_candidate_count: result.pause_candidate_count,
        recommended_pause_candidate_count: result.recommended_pause_candidate_count
      };
    case 'get_pause_candidates':
      return {
        total: result.total,
        min_gap_seconds: result.min_gap_seconds,
        candidate_count: Array.isArray(result.candidates) ? result.candidates.length : 0,
        recommended_count: result.recommended_count
      };
    case 'auto_assemble_script':
      return {
        success: result?.success !== false,
        changed: result?.changed !== false,
        deleted_take_version_count: Array.isArray(result?.deleted_take_version_ids) ? result.deleted_take_version_ids.length : 0,
        deleted_sentence_version_count: Array.isArray(result?.deleted_sentence_version_ids) ? result.deleted_sentence_version_ids.length : 0,
        deleted_gap_count: Number(result?.deleted_gap_count || 0),
        removed_seconds: result?.removed_seconds,
        timeline: result?.timeline || undefined
      };
    case 'search_project_subtitles':
      return {
        match_count: Array.isArray(result.matches) ? result.matches.length : 0
      };
    default:
      return {
        success: result?.success !== false,
        changed: result?.changed !== false,
        change: result?.change || toolName,
        deleted_block_count: Array.isArray(result?.deleted_block_ids) ? result.deleted_block_ids.length : undefined,
        restored_block_count: Array.isArray(result?.restored_block_ids) ? result.restored_block_ids.length : undefined,
        deleted_match_count: result?.deleted_match_count,
        restored_match_count: result?.restored_match_count,
        replaced_match_count: result?.replaced_match_count,
        deleted_gap_count: result?.deleted_gap_count,
        deleted_gap_keys: Array.isArray(result?.deleted_gap_keys) ? result.deleted_gap_keys : undefined,
        removed_seconds: result?.removed_seconds,
        targeted: result?.targeted,
        requested_gap_key_count: result?.requested_gap_key_count,
        removed_asset_title: result?.removed_asset_title || undefined,
        ordered_asset_ids: Array.isArray(result?.ordered_asset_ids) ? result.ordered_asset_ids : undefined,
        reordered_asset_titles: Array.isArray(result?.ordered_asset_titles) ? result.ordered_asset_titles : undefined,
        slice_id: result?.slice_id || undefined,
        slice_title: result?.slice_title || undefined,
        exported_path: result?.output_path || result?.zip_path || undefined,
        timeline: result?.timeline || undefined
      };
  }
}

function toolResultToText(result = {}, toolName = '') {
  switch (toolName) {
    case 'get_project_context': {
      const assets = Array.isArray(result.assets) ? result.assets : [];
      const assetLines = assets.map((asset, index) => `${index + 1}. ${asset.title} (${formatTime(asset.duration_seconds)}s)`);
      return [
        result.summary || '',
        assetLines.length ? `素材列表：\n${assetLines.join('\n')}` : ''
      ].filter(Boolean).join('\n\n');
    }
    case 'get_asset_script_map': {
      const assets = Array.isArray(result.assets) ? result.assets : [];
      const lines = assets.map((asset) => [
        `${asset.order}. ${asset.title} | ${formatTime(asset.duration_seconds)}s | 口播块 ${asset.script_block_count} | 字幕块 ${asset.subtitle_block_count} | 保留 ${asset.kept_word_count} 字`,
        `起止：${formatTime(asset.start)}-${formatTime(asset.end)}`,
        `首句：${asset.first_line || '—'}`,
        `末句：${asset.last_line || '—'}`,
        `预览：${asset.preview || '—'}`
      ].join('\n'));
      return [result.summary || '', lines.join('\n\n')].filter(Boolean).join('\n\n');
    }
    case 'get_timeline_detail': {
      const clips = Array.isArray(result.clips) ? result.clips : [];
      const clipLines = clips.map((clip) => {
        return `${clip.order}. [${clip.asset_title}] ${formatTime(clip.timeline_start)}-${formatTime(clip.timeline_end)} | source ${formatTime(clip.source_start)}-${formatTime(clip.source_end)} | ${clip.label || ''}`;
      });
      return [
        result.summary || '',
        clipLines.length ? `时间线片段：\n${clipLines.join('\n')}` : ''
      ].filter(Boolean).join('\n\n');
    }
    case 'list_project_assets': {
      const assets = Array.isArray(result.assets) ? result.assets : [];
      const assetLines = assets.map((asset) => `${asset.sort_order}. ${asset.title} (${formatTime(asset.duration_seconds)}s)`);
      return [result.summary || '', assetLines.join('\n')].filter(Boolean).join('\n\n');
    }
    case 'list_project_slices': {
      const slices = Array.isArray(result.slices) ? result.slices : [];
      const lines = slices.map((slice, index) => `${index + 1}. ${slice.title} | ${formatTime(slice.total_duration)}s | ${slice.clip_count} 段 | id=${slice.id}`);
      return [result.summary || '', lines.join('\n')].filter(Boolean).join('\n\n');
    }
    case 'suggest_project_slices': {
      const suggestions = Array.isArray(result.suggestions) ? result.suggestions : [];
      const lines = suggestions.map((slice, index) => `${index + 1}. ${slice.title} | ${formatTime(slice.duration_seconds)}s | ${String(slice.summary || '').trim()}`);
      return [result.summary || '', lines.join('\n')].filter(Boolean).join('\n\n');
    }
    case 'get_project_slice_detail': {
      const slice = result.slice || null;
      if (!slice) return result.summary || '未找到切片。';
      const blockLines = (slice.transcript_blocks || []).map((block, index) => `${index + 1}. ${formatTime(block.start)}-${formatTime(block.end)} ${block.text}`);
      return [
        result.summary || '',
        `标题：${slice.title}\n时长：${formatTime(slice.total_duration)}s\n片段数：${slice.clip_count}`,
        String(slice.transcript_text || '').trim() ? `正文：\n${String(slice.transcript_text || '').trim()}` : '',
        blockLines.length ? `分块：\n${blockLines.join('\n')}` : ''
      ].filter(Boolean).join('\n\n');
    }
    case 'get_subtitle_blocks':
    case 'get_script_blocks':
    case 'get_deleted_subtitle_blocks':
      return [result.summary || '', formatSubtitleLikeBlocks(result.blocks || [])].filter(Boolean).join('\n\n');
    case 'get_assemble_candidates': {
      const takeLines = (result.take_groups || []).map((group, index) => {
        const versions = (group.versions || []).map((version) => {
          const preview = String(version.text || '').trim().replace(/\s+/g, ' ').slice(0, 80);
          return `#${version.order || '?'} ${version.id} [${version.asset_title}] ${formatTime(version.start)}-${formatTime(version.end)} ${preview}`;
        }).join(' | ');
        return `${index + 1}. ${versions}`;
      });
      const blockLines = (result.block_groups || []).map((group, index) => {
        const versions = (group.versions || []).map((version) => {
          const preview = String(version.text || '').trim().replace(/\s+/g, ' ').slice(0, 90);
          return `#${version.order || '?'} ${version.id} [${version.asset_title}] ${formatTime(version.start)}-${formatTime(version.end)} ${preview}`;
        }).join(' | ');
        return `${index + 1}. ${versions}`;
      });
      const sentenceLines = (result.sentence_groups || []).map((group, index) => {
        const versions = (group.versions || []).map((version) => {
          const preview = String(version.text || '').trim().replace(/\s+/g, ' ').slice(0, 60);
          return `#${version.order || '?'} ${version.id} [${version.asset_title}] ${preview}`;
        }).join(' | ');
        return `${index + 1}. ${versions}`;
      });
      const restartLines = (result.restart_candidates || []).map((candidate, index) => {
        const preview = String(candidate.text || '').trim().replace(/\s+/g, ' ').slice(0, 100);
        return `${index + 1}. #${candidate.order || '?'} [${candidate.asset_title}] ${formatTime(candidate.start)}-${formatTime(candidate.end)} ${preview}`;
      });
      return [
        result.summary || '',
        takeLines.length ? `重复 take 候选：\n${takeLines.join('\n')}` : '',
        blockLines.length ? `重复段落候选：\n${blockLines.join('\n')}` : '',
        sentenceLines.length ? `重复句候选：\n${sentenceLines.join('\n')}` : '',
        restartLines.length ? `起手重说碎片候选：\n${restartLines.join('\n')}` : '',
        Array.isArray(result.pause_candidates) && result.pause_candidates.length
          ? `停顿候选：\n${formatPauseCandidates(result.pause_candidates)}`
          : ''
      ].filter(Boolean).join('\n\n');
    }
    case 'get_pause_candidates':
      return [result.summary || '', formatPauseCandidates(result.candidates || [])].filter(Boolean).join('\n\n');
    case 'auto_assemble_script': {
      return [
        result.summary || '',
        `删除重复 take：${Array.isArray(result.deleted_take_version_ids) ? result.deleted_take_version_ids.length : 0}`,
        `删除重复句：${Array.isArray(result.deleted_sentence_version_ids) ? result.deleted_sentence_version_ids.length : 0}`,
        `清理停顿：${Number(result.deleted_gap_count || 0)} 个`
      ].filter(Boolean).join('\n');
    }
    case 'search_project_subtitles': {
      const matches = Array.isArray(result.matches) ? result.matches : [];
      const lines = matches.map((match, index) => `${index + 1}. [${match.asset_title}] ${formatTime(match.start)}-${formatTime(match.end)} ${match.text}`);
      return [result.summary || '', lines.join('\n')].filter(Boolean).join('\n\n');
    }
    default:
      return JSON.stringify(result, null, 2);
  }
}

export const TOOL_DEFINITIONS = {
  get_project_context: {
    description: '读取当前项目概览、素材顺序、当前成片字数和时长。这里反映的是当前已剪结果，不是未剪的完整原始素材顺序。',
    schema: {},
    execute: (projectId) => toolGetProjectContext(projectId)
  },
  get_timeline_detail: {
    description: '读取当前时间线片段顺序、片段时长和当前成片总时长。',
    schema: {
      offset: z.number().optional(),
      limit: z.number().optional()
    },
    execute: (projectId, args) => toolGetTimelineDetail(projectId, args)
  },
  list_project_assets: {
    description: '列出项目素材标题与时长。',
    schema: {},
    execute: (projectId) => toolListProjectAssets(projectId)
  },
  list_project_slices: {
    description: '列出当前项目已经存在的直播切片。',
    schema: {},
    execute: (projectId) => toolListProjectSlices(projectId)
  },
  suggest_project_slices: {
    description: '基于当前项目全文内容给出直播切片候选。默认先给建议，不直接创建切片。',
    schema: {
      query: z.string().optional(),
      count: z.number().optional(),
      min_duration: z.number().optional(),
      max_duration: z.number().optional()
    },
    execute: (projectId, args) => toolSuggestProjectSlices(projectId, args)
  },
  get_project_slice_detail: {
    description: '读取某个已创建切片的标题、时长、正文和分块内容。',
    schema: {
      slice_id: z.string()
    },
    execute: (projectId, args) => toolGetProjectSliceDetail(projectId, args)
  },
  create_project_slice: {
    description: '根据指定时间范围创建一个新的直播切片。ranges 使用母片时间范围数组，每项包含 start/end 秒数。',
    schema: {
      title: z.string().optional(),
      summary: z.string().optional(),
      query: z.string().optional(),
      generated_by: z.string().optional(),
      generatedBy: z.string().optional(),
      target_duration_seconds: z.number().optional(),
      ranges: z.array(z.object({
        start: z.number(),
        end: z.number()
      })).min(1)
    },
    mutatesProject: true,
    execute: (projectId, args) => toolCreateProjectSlice(projectId, args)
  },
  delete_project_slice: {
    description: '删除一个已存在的直播切片。',
    schema: {
      slice_id: z.string()
    },
    mutatesProject: true,
    execute: (projectId, args) => toolDeleteProjectSlice(projectId, args)
  },
  search_project_subtitles: {
    description: '在当前项目字幕流里按文本搜索某句内容。',
    schema: {
      query: z.string(),
      limit: z.number().optional()
    },
    execute: (projectId, args) => toolSearchProjectSubtitles(projectId, args)
  },
  get_asset_script_map: {
    description: '按当前素材顺序读取每个视频各自的脚本地图：每个素材讲了什么、首尾句是什么、当前保留了多少口播块。适合多素材口播拼稿时先快速判断每个视频的角色、顺序和是否需要整段重排，再决定要不要继续完整读稿。',
    schema: {},
    mutatesProject: false,
    execute: (projectId) => toolGetAssetScriptMap(projectId)
  },
  get_subtitle_blocks: {
    description: '读取当前项目字幕流的连续字幕块。这里返回的是当前已保留内容，顺序与当前成片一致，不是完整原始素材全文。默认直接返回当前项目的全部字幕块；只有在你明确传 offset/limit 时才分页，适合在当前结果上继续局部修改、定位重复片段和规划删改。',
    schema: {
      offset: z.number().optional(),
      limit: z.number().optional()
    },
    mutatesProject: false,
    execute: (projectId, args) => toolGetSubtitleBlocks(projectId, args)
  },
  get_script_blocks: {
    description: '读取更大的口播脚本块。这里返回的是当前项目**当前成片**的脚本块顺序，不是完整原始素材全文。默认直接返回当前项目的全部口播块；只有在你明确传 offset/limit 时才分页，适合在当前结果上继续修改、比较重复 take、整段重复和版本差异。',
    schema: {
      offset: z.number().optional(),
      limit: z.number().optional()
    },
    mutatesProject: false,
    execute: (projectId, args) => toolGetScriptBlocks(projectId, args)
  },
  get_deleted_subtitle_blocks: {
    description: '读取当前已经被删掉的字幕块，适合复查误删和做审查补回。',
    schema: {
      offset: z.number().optional(),
      limit: z.number().optional()
    },
    mutatesProject: false,
    execute: (projectId, args) => toolGetDeletedSubtitleBlocks(projectId, args)
  },
  get_assemble_candidates: {
    description: '读取口播拼稿候选，返回重复 take 候选组和重复句候选组。它不是主观察来源，但口播拼稿在读完整个 get_script_blocks 和 get_subtitle_blocks 之后，必须再调用它复查一次；决定 no-op 前不能跳过这一步。',
    schema: {
      take_limit: z.number().optional(),
      block_limit: z.number().optional(),
      sentence_limit: z.number().optional(),
      pause_limit: z.number().optional(),
      min_pause_seconds: z.number().optional()
    },
    mutatesProject: false,
    execute: (projectId, args) => toolGetAssembleCandidates(projectId, args)
  },
  auto_assemble_script: {
    description: '执行一轮保守的口播拼稿。它会基于当前结果优先删除明显重复 take、明显重复句，并顺手清理推荐停顿；适合用户只说“执行口播拼稿”但没有给更细约束时先落一轮安全修改。',
    schema: {
      take_limit: z.number().optional(),
      block_limit: z.number().optional(),
      sentence_limit: z.number().optional(),
      pause_limit: z.number().optional(),
      min_pause_seconds: z.number().optional(),
      max_passes: z.number().optional(),
      take_window_limit: z.number().optional()
    },
    mutatesProject: true,
    execute: (projectId, args, context) => toolAutoAssembleScript(projectId, args, context)
  },
  get_pause_candidates: {
    description: '读取当前项目中仍然保留的明显停顿候选，适合在“删除停顿 / 压紧节奏 / 去掉间隙”前先定位具体 gap，再定点调用 remove_pauses。优先看带“推荐”标签的候选；如果用户明确要“一键去掉全部停顿”，改用 remove_all_pauses。',
    schema: {
      min_gap_seconds: z.number().optional(),
      limit: z.number().optional(),
      asset_title: z.string().optional()
    },
    mutatesProject: false,
    execute: (projectId, args) => toolGetPauseCandidates(projectId, args)
  },
  delete_subtitle_blocks: {
    description: '按字幕块 id 或 order 删除当前项目里的字幕块。',
    schema: {
      block_ids: z.array(z.string()).optional(),
      orders: z.array(z.number()).optional()
    },
    mutatesProject: true,
    execute: (projectId, args) => toolDeleteSubtitleBlocks(projectId, args)
  },
  restore_subtitle_blocks: {
    description: '按字幕块 id 或 order 恢复当前项目里的字幕块。',
    schema: {
      block_ids: z.array(z.string()).optional(),
      orders: z.array(z.number()).optional()
    },
    mutatesProject: true,
    execute: (projectId, args) => toolRestoreSubtitleBlocks(projectId, args)
  },
  remove_project_asset: {
    description: '从项目中删除某个素材。',
    schema: {
      asset_id: z.string().optional(),
      asset_title: z.string().optional()
    },
    mutatesProject: true,
    execute: (projectId, args) => toolRemoveProjectAsset(projectId, args)
  },
  reorder_project_assets: {
    description: '重排项目素材顺序。它只用于调整整段素材 / 整个文件之间的顺序；不要把它理解成可以改单个素材内部的句子顺序或片段顺序。只有用户明确要求调整素材顺序时才使用。',
    schema: {
      asset_titles: z.array(z.string()).optional(),
      ordered_titles: z.array(z.string()).optional()
    },
    mutatesProject: true,
    execute: (projectId, args) => toolReorderProjectAssets(projectId, args)
  },
  delete_words_by_phrase: {
    description: '按字幕文本删除一段内容。它只适合删除独立短口头禅和语气词，例如“嗯”“啊”“呃”“就是”“那个”；不要用它删除句中实词、主谓宾、半句结构或整句内容。删整句、删重复句、删半句时改用 delete_subtitle_blocks。',
    schema: {
      phrase: z.string(),
      asset_title: z.string().optional()
    },
    mutatesProject: true,
    execute: (projectId, args) => toolDeleteWordsByPhrase(projectId, args)
  },
  replace_subtitle_text: {
    description: '把某段字幕文本改成另一段文本。只用于真正的字幕纠错，不要把它当作剪辑工具；不要用它代替删除内容，也不要为了“更顺”而重写原句。',
    schema: {
      find_text: z.string(),
      replacement_text: z.string(),
      asset_title: z.string().optional()
    },
    mutatesProject: true,
    execute: (projectId, args) => toolReplaceSubtitleText(projectId, args)
  },
  restore_words_by_phrase: {
    description: '按字幕文本恢复一段之前删掉的内容。',
    schema: {
      phrase: z.string(),
      asset_title: z.string().optional()
    },
    mutatesProject: true,
    execute: (projectId, args) => toolRestoreWordsByPhrase(projectId, args)
  },
  remove_pauses: {
    description: '切掉明显停顿。口播拼稿模式下默认先用 get_pause_candidates 或 get_assemble_candidates 读取候选 gap，再把 gap_keys 传给它做 3-8 个间隙的小批量定点删除。它适合局部、保守、可控的节奏清理。',
    schema: {
      min_gap_seconds: z.number().optional(),
      gap_keys: z.array(z.string()).optional(),
      asset_title: z.string().optional(),
      limit: z.number().optional(),
      aggressive: z.boolean().optional()
    },
    mutatesProject: true,
    execute: (projectId, args) => toolRemovePauses(projectId, args)
  },
  remove_all_pauses: {
    description: '一键去除当前项目里所有可删停顿。它是确定性的全量脚本，不需要先传 gap_keys；当用户明确要求“把所有/全部停顿都删掉”“一键去除停顿”“彻底去掉间隙”时，优先用它，而不是循环调用 remove_pauses。',
    schema: {
      min_gap_seconds: z.number().optional(),
      asset_title: z.string().optional()
    },
    mutatesProject: true,
    execute: (projectId, args) => toolRemoveAllPauses(projectId, args)
  },
  clear_deleted: {
    description: '恢复整条项目时间线到完整素材状态，清空所有当前删减。只有用户明确要求“重来 / 从头开始 / 恢复完整”时才使用，平时不要擅自调用。',
    schema: {},
    mutatesProject: true,
    execute: (projectId) => toolClearDeleted(projectId)
  },
  save_snapshot: {
    description: '保存当前项目时间线快照。',
    schema: {
      note: z.string().optional(),
      metadata: z.record(z.any()).optional(),
      archived_slices: z.array(z.any()).optional()
    },
    mutatesProject: true,
    execute: (projectId, args) => toolSaveSnapshot(projectId, args)
  },
  export_video: {
    description: '导出当前项目成片视频。',
    schema: {},
    mutatesProject: true,
    execute: (projectId) => toolExportVideo(projectId)
  }
};

function toSdkToolDefinition(name, projectId, runtimeContext) {
  const definition = TOOL_DEFINITIONS[name];
  const zodSchema = definition.schema || {};

  return sdkTool(
    name,
    definition.description,
    zodSchema,
    async (args = {}) => {
      await runtimeContext.emit({
        type: 'tool_call',
        step: name,
        message: `执行 ${name}`,
        payload: {
          tool: name,
          args
        }
      });

      const stageBridge = async (stage) => {
        await runtimeContext.emit({
          type: 'stage',
          step: stage?.step || name,
          message: stage?.message || '',
          payload: {
            tool: name,
            ...stage
          }
        });
      };

      try {
        const result = await definition.execute(projectId, args, {
          signal: runtimeContext.signal,
          onStage: stageBridge,
          llm_provider: runtimeContext.llmProvider,
          llm_model: runtimeContext.llmModel,
          requestContext: runtimeContext.requestContext
        });

        if (definition.mutatesProject && result?.success !== false && result?.changed !== false) {
          runtimeContext.mutatedProject.current = true;
        }
        runtimeContext.appliedChanges.push({
          tool: name,
          summary: result?.summary || '',
          change: result?.change || name,
          ...compactResultPayload(name, result)
        });
        await runtimeContext.emit({
          type: 'tool_result',
          step: name,
          message: result?.summary || `${name} 已执行`,
          payload: {
            tool: name,
            summary: result?.summary || '',
            result: compactResultPayload(name, result)
          }
        });

        return {
          content: [
            {
              type: 'text',
              text: toolResultToText(result, name)
            }
          ]
        };
      } catch (error) {
        await runtimeContext.emit({
          type: 'error',
          step: name,
          message: String(error?.message || `${name} failed`),
          payload: {
            tool: name
          }
        });
        throw error;
      }
    }
  );
}

export function createProjectAgentMcpServer(projectId, runtimeContext, toolNames = Object.keys(TOOL_DEFINITIONS)) {
  return createSdkMcpServer({
    name: 'autoedit-project-tools',
    version: '1.0.0',
    tools: toolNames
      .filter((name) => TOOL_DEFINITIONS[name])
      .map((name) => toSdkToolDefinition(name, projectId, runtimeContext))
  });
}

export async function executeProjectAgentToolDirect(projectId, toolName, args = {}, context = {}) {
  const definition = TOOL_DEFINITIONS[toolName];
  if (!definition) {
    throw new Error(`Unknown project agent tool: ${toolName}`);
  }

  return definition.execute(projectId, args, context);
}

export function compactProjectAgentToolResult(toolName, result = {}) {
  return compactResultPayload(toolName, result);
}
