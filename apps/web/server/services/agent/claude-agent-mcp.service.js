import { createSdkMcpServer, tool as sdkTool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  toolGetAssembleCandidates,
  toolGetDeletedSubtitleBlocks,
  toolDeleteSubtitleBlocks,
  toolDeleteWordsByPhrase,
  toolExportPackage,
  toolExportVideo,
  toolClearDeleted,
  toolGetProjectContext,
  toolGetScriptBlocks,
  toolGetSubtitleBlocks,
  toolGetTimelineDetail,
  toolListProjectAssets,
  toolRemovePauses,
  toolRemoveProjectAsset,
  toolReorderProjectAssets,
  toolSearchProjectSubtitles,
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

function compactResultPayload(toolName, result = {}) {
  switch (toolName) {
    case 'get_project_context':
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
        sentence_group_count: result.sentence_group_count
      };
    case 'search_project_subtitles':
      return {
        match_count: Array.isArray(result.matches) ? result.matches.length : 0
      };
    default:
      return {
        success: result?.success !== false,
        change: result?.change || toolName,
        deleted_block_count: Array.isArray(result?.deleted_block_ids) ? result.deleted_block_ids.length : undefined,
        restored_block_count: Array.isArray(result?.restored_block_ids) ? result.restored_block_ids.length : undefined,
        removed_asset_title: result?.removed_asset_title || undefined,
        reordered_asset_titles: Array.isArray(result?.ordered_asset_titles) ? result.ordered_asset_titles : undefined,
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
    case 'get_subtitle_blocks':
    case 'get_script_blocks':
    case 'get_deleted_subtitle_blocks':
      return [result.summary || '', formatSubtitleLikeBlocks(result.blocks || [])].filter(Boolean).join('\n\n');
    case 'get_assemble_candidates': {
      const takeLines = (result.take_groups || []).map((group, index) => {
        const versions = (group.versions || []).map((version) => {
          const preview = String(version.text || '').trim().replace(/\s+/g, ' ').slice(0, 80);
          return `${version.id} [${version.asset_title}] ${formatTime(version.start)}-${formatTime(version.end)} ${preview}`;
        }).join(' | ');
        return `${index + 1}. ${versions}`;
      });
      const sentenceLines = (result.sentence_groups || []).map((group, index) => {
        const versions = (group.versions || []).map((version) => {
          const preview = String(version.text || '').trim().replace(/\s+/g, ' ').slice(0, 60);
          return `${version.id} [${version.asset_title}] ${preview}`;
        }).join(' | ');
        return `${index + 1}. ${versions}`;
      });
      return [
        result.summary || '',
        takeLines.length ? `重复 take 候选：\n${takeLines.join('\n')}` : '',
        sentenceLines.length ? `重复句候选：\n${sentenceLines.join('\n')}` : ''
      ].filter(Boolean).join('\n\n');
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
  search_project_subtitles: {
    description: '在当前项目字幕流里按文本搜索某句内容。',
    schema: {
      query: z.string(),
      limit: z.number().optional()
    },
    execute: (projectId, args) => toolSearchProjectSubtitles(projectId, args)
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
    description: '读取口播拼稿候选，返回重复 take 候选组和重复句候选组。它只是辅助参考，不是主观察来源；默认先直接读取 get_script_blocks 和 get_subtitle_blocks，再在确实需要比对候选时使用它。',
    schema: {
      take_limit: z.number().optional(),
      sentence_limit: z.number().optional()
    },
    mutatesProject: false,
    execute: (projectId, args) => toolGetAssembleCandidates(projectId, args)
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
    description: '按字幕文本删除一段内容，适合删口头禅、寒暄、口气词和明确多余的一句话。默认保持原顺序，只做删除，不做改写。',
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
    description: '按阈值切掉明显停顿。口播剪辑在做完主要语义删减后，必须检查是否还残留明显长停顿；若有，就调用它做收尾清理。',
    schema: {
      min_gap_seconds: z.number().optional()
    },
    mutatesProject: true,
    execute: (projectId, args) => toolRemovePauses(projectId, args)
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
      note: z.string().optional()
    },
    mutatesProject: true,
    execute: (projectId, args) => toolSaveSnapshot(projectId, args)
  },
  export_video: {
    description: '导出当前项目成片视频。',
    schema: {},
    mutatesProject: true,
    execute: (projectId) => toolExportVideo(projectId)
  },
  export_project_package: {
    description: '导出项目工程包。',
    schema: {},
    mutatesProject: true,
    execute: (projectId) => toolExportPackage(projectId)
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

        if (definition.mutatesProject) {
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
