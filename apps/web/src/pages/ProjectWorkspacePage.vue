<template>
  <div class="project-workspace-page" @contextmenu.prevent="openGlobalContextMenu($event)">
    <AppConfirmDialog
      :visible="confirmDialog.visible"
      :title="confirmDialog.title"
      :message="confirmDialog.message"
      :confirm-text="confirmDialog.confirmText"
      :cancel-text="confirmDialog.cancelText"
      :danger="confirmDialog.danger"
      @confirm="handleConfirmDialogConfirm"
      @cancel="closeConfirmDialog"
    />
    <DocumentPreviewModal
      :visible="documentPreviewVisible"
      :loading="documentPreviewLoading"
      :title="documentPreviewTitle"
      :subtitle="documentPreviewSubtitle"
      :sections="documentPreviewSections"
      :active-section-id="documentPreviewSectionId"
      @close="documentPreviewVisible = false"
      @select-section="handleDocumentSectionSelect"
    />
    <div v-if="isLoading" class="state-shell">正在加载项目工作台...</div>
    <div v-else-if="error" class="state-shell error">{{ error }}</div>
    <div v-else class="workspace-shell">
      <header class="workspace-topbar">
        <div class="topbar-left">
          <router-link class="brand-link" to="/projects">AUTOEDIT</router-link>
          <nav class="workspace-nav">
            <router-link to="/projects">项目</router-link>
            <router-link to="/library">素材库</router-link>
          </nav>
          <div class="project-identity">
            <strong>{{ project?.name }}</strong>
            <span>{{ project?.description || '多素材字幕时间线工作台' }}</span>
          </div>
        </div>

        <div class="topbar-right">
          <span v-if="timelineDirty" class="stat-chip warning">未保存</span>
          <button class="ghost-btn danger-ghost-btn" :disabled="deletingProject" @click="deleteCurrentProject">
            {{ deletingProject ? '删除中...' : '删除项目' }}
          </button>
          <button class="ghost-btn" @click="reloadTimeline">重载</button>
          <button class="ghost-btn" :disabled="!timelineDirty || savingTimeline" @click="saveTimeline">
            {{ savingTimeline ? '保存中...' : '保存时间线' }}
          </button>
          <button class="ghost-btn" :disabled="importingProjectPackage" @click="triggerProjectPackageImport">
            {{ importingProjectPackage ? `导入中 ${projectPackageImportProgress}%` : '导入工程包' }}
          </button>
          <button class="ghost-btn" :disabled="!canOpenDocumentPreview" @click="openDocumentPreview()">
            {{ documentTriggerLabel }}
          </button>
          <input
            ref="projectPackageImportInputRef"
            class="project-upload-input"
            type="file"
            accept=".zip,application/zip"
            @change="handleProjectPackageImportSelection"
          />
          <div class="export-menu-shell" @click.stop>
            <button
              class="primary-btn export-trigger"
              :disabled="isExportingAny"
              @click="toggleExportMenu"
            >
              {{ exportTriggerLabel }}
            </button>
            <div v-if="exportMenuOpen" class="export-menu">
              <button class="context-item" :disabled="isExportingAny" @click="handleExportMenuVideo">
                {{ exportingVideo ? '视频导出中...' : '导出视频' }}
              </button>
              <button class="context-item" :disabled="isExportingAny" @click="handleExportMenuPackage">
                {{ exportingPackage ? '工程包导出中...' : '导出工程包' }}
              </button>
              <button class="context-item" :disabled="isExportingAny" @click="handleExportMenuInterchange('premiere_xml')">
                {{ exportingInterchangeFormat === 'premiere_xml' ? 'XML 导出中...' : '导出 Premiere / Resolve XML' }}
              </button>
              <button class="context-item" :disabled="isExportingAny" @click="handleExportMenuInterchange('edl')">
                {{ exportingInterchangeFormat === 'edl' ? 'EDL 导出中...' : '导出通用 EDL' }}
              </button>
              <button class="context-item" :disabled="isExportingAny" @click="handleExportMenuInterchange('capcut_srt')">
                {{ exportingInterchangeFormat === 'capcut_srt' ? 'SRT 导出中...' : '导出剪映 / CapCut SRT' }}
              </button>
              <button
                v-if="isLiveSlicingMode && projectSlices.length"
                class="context-item"
                :disabled="isExportingAny"
                @click="handleExportMenuSliceXmlBundle"
              >
                {{ exportingSliceXmlBundle ? '切片 XML 打包中...' : '导出全部切片 XML 包' }}
              </button>
            </div>
          </div>
        </div>
      </header>

      <div class="workspace-body" :style="workspaceLayoutStyle">
        <aside class="sidebar" :class="{ collapsed: sidebarCollapsed }" @contextmenu.stop>
          <template v-if="!sidebarCollapsed">
            <div class="sidebar-tabs-shell">
              <div class="sidebar-tabs">
                <button
                  v-for="tab in sidebarTabs"
                  :key="tab.id"
                  class="sidebar-tab"
                  :class="{ active: activeSidebarTab === tab.id }"
                  @click="activeSidebarTab = tab.id"
                >
                  {{ tab.label }}
                </button>
              </div>
              <button class="panel-visibility-btn icon" title="隐藏素材栏" @click="toggleSidebarCollapsed">&lt;&lt;</button>
            </div>

            <div class="sidebar-panel">
            <template v-if="activeSidebarTab === 'assets'">
              <div class="sidebar-head">
                <strong>项目素材</strong>
                <span>{{ orderedProjectAssets.length }}</span>
              </div>

              <div
                class="project-upload-zone"
                :class="{ active: projectUploadDragActive, busy: uploadingProjectAssets }"
                @click="triggerProjectUploadPicker"
                @dragenter.prevent="handleProjectUploadDragEnter"
                @dragover.prevent="handleProjectUploadDragOver"
                @dragleave.prevent="handleProjectUploadDragLeave"
                @drop.prevent="handleProjectUploadDrop"
              >
                <input
                  ref="projectUploadInputRef"
                  class="project-upload-input"
                  type="file"
                  accept="video/*,.mp4,.mov,.m4v,.mkv,.webm"
                  multiple
                  @change="handleProjectUploadSelection"
                />
                <strong>{{ uploadingProjectAssets ? `上传中 ${projectUploadProgress}%` : '上传素材' }}</strong>
                <span>
                  {{ uploadingProjectAssets
                    ? '素材会自动进入素材库并加入当前项目'
                    : '点击选择或拖拽视频到这里，上传后自动加入当前项目' }}
                </span>
              </div>

              <div v-if="!orderedProjectAssets.length" class="empty-block">这个项目里还没有素材。</div>

              <div v-else class="asset-list">
                <div
                  v-for="(asset, index) in orderedProjectAssets"
                  :key="asset.id"
                  class="asset-row"
                  :class="{
                    active: selectedAssetId === asset.id,
                    dragging: draggedAssetId === asset.id,
                    'drop-target': dragOverAssetId === asset.id
                  }"
                  :style="assetRowStyle(asset.id)"
                  draggable="true"
                  tabindex="0"
                  @click="selectAsset(asset.id)"
                  @contextmenu.prevent.stop="openAssetContextMenu($event, asset.id)"
                  @dragstart="handleAssetDragStart(asset.id)"
                  @dragover.prevent="handleAssetDragOver(asset.id)"
                  @dragenter.prevent="handleAssetDragOver(asset.id)"
                  @drop.prevent="handleAssetDrop(asset.id)"
                  @dragend="handleAssetDragEnd"
                >
                  <span class="asset-drag" title="拖动排序">⋮⋮</span>
                  <span class="asset-order">{{ index + 1 }}</span>
                  <span class="asset-swatch"></span>
                  <span class="asset-copy">
                    <strong>{{ asset.title }}</strong>
                    <small>{{ formatDuration(asset.duration_seconds) }}</small>
                    <div
                      v-if="isAssetProcessing(asset)"
                      class="asset-progress"
                    >
                      <div class="asset-progress-head">
                        <span>{{ assetProgressLabel(asset) }}</span>
                        <strong>{{ assetProgressValue(asset) }}%</strong>
                      </div>
                      <div class="asset-progress-track">
                        <span class="asset-progress-fill" :style="{ width: `${assetProgressValue(asset)}%` }"></span>
                      </div>
                      <span class="asset-progress-note">{{ assetProgressMessage(asset) }}</span>
                    </div>
                  </span>
                  <span class="asset-actions">
                    <span class="asset-state" :class="{ processing: isAssetProcessing(asset), failed: asset.asr_status === 'failed' }">
                      {{ assetStateLabel(asset) }}
                    </span>
                    <button
                      v-if="String(asset.asr_status || '') === 'failed'"
                      class="asset-retry-btn"
                      :disabled="isRetryingAsset(asset.id)"
                      title="重试转写"
                      @click.stop="retryAssetTranscription(asset.id)"
                    >
                      {{ isRetryingAsset(asset.id) ? '重试中' : '重试' }}
                    </button>
                    <button
                      class="asset-remove-btn"
                      title="从项目中删除"
                      @click.stop="removeAssetFromProjectAction(asset.id)"
                    >
                      ×
                    </button>
                  </span>
                </div>
              </div>

              <div class="mini-context">
                <div class="mini-context-item">
                  <span>当前素材</span>
                  <strong>{{ currentContextAsset?.title || selectedAsset?.title || '未选择' }}</strong>
                </div>
                <div class="mini-context-item">
                  <span>当前时间</span>
                  <strong>{{ formatDuration(editorStore.currentTime || 0) }}</strong>
                </div>
              </div>
            </template>

            <template v-else>
              <div class="sidebar-head">
                <strong>时间线快照</strong>
                <button class="text-link" :disabled="savingSnapshot" @click="saveSnapshot">
                  {{ savingSnapshot ? '保存中...' : '保存快照' }}
                </button>
              </div>
              <div v-if="!snapshots.length" class="empty-block">还没有快照记录。</div>
              <div v-else class="list-stack">
                <div v-for="snapshot in snapshots" :key="snapshot.id" class="list-row">
                  <div class="list-row-title">{{ snapshot.source }}</div>
                  <div class="list-row-note">{{ snapshot.note || '无说明' }}</div>
                  <div class="list-row-meta">
                    <span>{{ formatDateTime(snapshot.createdAt || snapshot.created_at) }}</span>
                  </div>
                </div>
              </div>
            </template>
            </div>
          </template>
          <button v-else class="panel-reveal-btn" @click="toggleSidebarCollapsed">素材</button>
        </aside>

        <div class="pane-resizer vertical" @mousedown="startResize('sidebar', $event)"></div>

        <main class="editor-panel" :style="editorPanelStyle" @contextmenu.stop>
          <section class="preview-slot">
            <div class="preview-card">
              <div class="preview-head">
                <strong>预览</strong>
                <span>{{ previewLabel }}</span>
              </div>
              <div class="preview-frame">
                <ProjectCompositionPreview
                  ref="previewPlayerRef"
                  :clips="activePreviewClips"
                  :project-time="currentPreviewTime"
                  :duration="currentPreviewDuration"
                  :display-time="currentPreviewTime"
                  :display-duration="currentPreviewDuration"
                  :empty-label="isLiveSlicingMode ? '先让右侧 Agent 生成切片，或在字幕里手动框选后新建切片。' : '当前项目时间线上还没有可预览的成片片段。'"
                  @project-time-update="handlePreviewProjectTimeUpdate"
                  @clip-change="handlePreviewClipChange"
                  @playing-change="handlePreviewPlayingChange"
                />
              </div>
            </div>
          </section>

          <div class="pane-resizer horizontal" @mousedown="startResize('preview', $event)"></div>

          <section class="subtitle-workspace">
            <SubtitlePanel
              class="project-subtitle-panel"
              :workspace-mode="workspaceMode"
              :project-slices="projectSlices"
              :selected-slice-id="selectedSliceId"
              :slice-selection-hint="liveSliceSelectionHint"
              :can-create-slice-from-selection="canCreateManualSlice"
              :can-append-selection-to-slice="canAppendSelectionToSlice"
              :can-remove-selection-from-slice="canRemoveSelectionFromSlice"
              :can-delete-selected-slice="Boolean(selectedSliceId)"
              :can-open-document="canOpenDocumentPreview"
              :slice-action-busy="sliceMutationBusy"
              @update:workspace-mode="workspaceMode = $event"
              @open-document="openDocumentPreview()"
              @create-slice-from-selection="createManualSliceFromSelection"
              @append-selection-to-slice="appendSelectionToCurrentSlice"
              @remove-selection-from-slice="removeSelectionFromCurrentSlice"
              @delete-selected-slice="removeSelectedSlice"
              @select-slice="handleSliceChipSelect"
              @seek-to="handleProjectSeek"
            />
            <TimelineStrip class="project-timeline-strip" />
            <div class="editor-status-bar">
              <div class="status-left">
                <div class="status-item">
                  <span>总字数: {{ totalWords }}</span>
                </div>
                <div class="status-item">
                  <span>当前素材: {{ currentContextAsset?.title || selectedAsset?.title || '未选择' }}</span>
                </div>
              </div>
              <div class="status-right">
                <div class="status-item">
                  <span>已删: {{ deletedWordCount }}字 + {{ formatDuration(deletedGapDuration) }}停顿</span>
                </div>
                <div class="status-item">
                  <span>预览时间: {{ formatDuration(currentPreviewTime || 0) }} / {{ formatDuration(currentPreviewDuration || 0) }}</span>
                </div>
              </div>
            </div>
          </section>
        </main>

        <div class="pane-resizer vertical" @mousedown="startResize('agent', $event)"></div>

        <aside class="agent-panel" :class="{ collapsed: agentCollapsed }" @contextmenu.stop>
          <template v-if="!agentCollapsed">
            <AgentTerminalPanel
              :messages="messages"
              :events="liveRunEvents"
              :pending-confirmation-run="pendingConfirmationRun"
              :show-thinking-bubble="showThinkingBubble"
              :status-label="agentStatusLabel"
              :mode-value="agentMode"
              :prompt-value="agentPrompt"
              :placeholder="agentPlaceholder"
              :running-agent="runningAgent"
              :stopping-agent="stoppingAgent"
              :can-stop="Boolean(activeRunId)"
              :can-open-document="canOpenDocumentPreview"
              :document-action-label="documentActionLabel"
              @new-session="createFreshAgentSession"
              @open-document="openDocumentPreview()"
              @toggle-collapse="toggleAgentCollapsed"
              @confirm="handleAgentConfirmation"
              @update:mode-value="agentMode = $event"
              @update:prompt-value="agentPrompt = $event"
              @run="runAgent"
              @stop="cancelRunningAgent"
            />
          </template>
          <button v-else class="panel-reveal-btn panel-reveal-btn-right" @click="toggleAgentCollapsed">Agent</button>
        </aside>
      </div>

      <div
        v-if="contextMenu.visible"
        class="context-menu"
        :style="contextMenuStyle"
        @contextmenu.prevent
      >
        <template v-if="contextMenu.scope === 'asset'">
          <button class="context-item" @click="previewAssetFromContext">预览这个素材</button>
          <button class="context-item" @click="moveAssetByStep(contextMenu.assetId, -1)">上移</button>
          <button class="context-item" @click="moveAssetByStep(contextMenu.assetId, 1)">下移</button>
          <button class="context-item" @click="moveAssetToEdge(contextMenu.assetId, 'start')">移到最前</button>
          <button class="context-item" @click="moveAssetToEdge(contextMenu.assetId, 'end')">移到最后</button>
          <button class="context-item danger" @click="removeAssetFromProjectAction(contextMenu.assetId)">从项目中删除</button>
        </template>
        <template v-else>
          <button class="context-item" @click="saveTimeline">保存时间线</button>
          <button class="context-item" @click="reloadTimeline">重载项目</button>
          <button class="context-item" @click="saveSnapshot">保存快照</button>
          <button class="context-item" @click="handleExportVideo">导出视频</button>
          <button class="context-item" @click="handleExportPackage">导出工程包</button>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppConfirmDialog from '../components/AppConfirmDialog.vue';
import AgentTerminalPanel from '../components/AgentTerminalPanel.vue';
import DocumentPreviewModal from '../components/DocumentPreviewModal.vue';
import SubtitlePanel from '../features/editor/components/SubtitlePanel.vue';
import TimelineStrip from '../features/editor/components/TimelineStrip.vue';
import ProjectCompositionPreview from '../features/editor/components/ProjectCompositionPreview.vue';
import { useEditorStore } from '../features/editor/stores/editorStore';
import { getLibraryAssetWords, retranscribeLibraryAsset } from '../features/library/api/libraryApi';
import {
  cancelProjectAgentRun,
  confirmProjectAgentRun,
  createProjectSlice,
  createProjectAgentSession,
  createProjectSnapshot,
  deleteProject as deleteProjectRequest,
  deleteProjectSlice,
  exportProjectInterchange,
  exportProjectPackage,
  exportProjectSliceXmlBundle,
  exportProjectVideo,
  getProjectSlice,
  listProjectAgentRunEvents,
  getProjectAgentSession,
  getProject,
  getProjectEditState,
  getProjectTimeline,
  importProjectPackage,
  listProjectJobs,
  listProjectSlices,
  listProjectAgentSessions,
  listProjectSnapshots,
  removeProjectAsset,
  reorderProjectAssets,
  runProjectAgentWithProgress,
  uploadProjectAssets,
  updateProjectEditState,
  updateProjectSlice
} from '../features/projects/api/projectsApi';

const route = useRoute();
const router = useRouter();
const editorStore = useEditorStore();
const projectId = computed(() => route.params.projectId);

const PALETTE = [
  { border: '#1db7ff', soft: 'rgba(29,183,255,0.18)', solid: '#1db7ff' },
  { border: '#ff8f2d', soft: 'rgba(255,143,45,0.18)', solid: '#ff8f2d' },
  { border: '#58d67d', soft: 'rgba(88,214,125,0.18)', solid: '#58d67d' },
  { border: '#e35cff', soft: 'rgba(227,92,255,0.18)', solid: '#e35cff' },
  { border: '#ffd84d', soft: 'rgba(255,216,77,0.18)', solid: '#ffd84d' },
  { border: '#ff5d73', soft: 'rgba(255,93,115,0.18)', solid: '#ff5d73' }
];

const sidebarTabs = [
  { id: 'assets', label: '素材' },
  { id: 'snapshots', label: '快照' }
];

const isLoading = ref(false);
const error = ref('');
const project = ref(null);
const timeline = ref(null);
const projectEditState = ref(null);
const snapshots = ref([]);
const activeSidebarTab = ref('assets');
const selectedAssetId = ref('');
const assetWordsMap = ref({});
const retryingAssetIds = ref([]);
const messages = ref([]);
const agentSession = ref(null);
const liveRunEvents = ref([]);
const activeRunId = ref('');
const activeRunStatus = ref('');
const selectedRunId = ref('');
const selectedRunEvents = ref([]);
const loadingRunEvents = ref(false);
const agentPanelTab = ref('chat');
const agentMode = ref('assemble_script');
const workspaceMode = ref('assemble_script');
const agentPrompt = ref('');
const topic = ref('');
const targetMinutes = ref(1.5);
const selectedSliceId = ref('');
const selectedSliceDetail = ref(null);
const loadingSliceDetail = ref(false);
const deletingSliceId = ref('');
const mutatingSlice = ref(false);
const runningAgent = ref(false);
const exportingVideo = ref(false);
const exportingPackage = ref(false);
const exportingInterchangeFormat = ref('');
const exportingSliceXmlBundle = ref(false);
const deletingProject = ref(false);
const confirmDialog = ref({
  visible: false,
  title: '',
  message: '',
  confirmText: '确认',
  cancelText: '取消',
  danger: false
});
const savingTimeline = ref(false);
const savingSnapshot = ref(false);
const exportMenuOpen = ref(false);
const autosaveTimer = ref(null);
const previewPlayerRef = ref(null);
const projectUploadInputRef = ref(null);
const uploadingProjectAssets = ref(false);
const projectUploadProgress = ref(0);
const projectUploadDragDepth = ref(0);
const assetJobs = ref([]);
const assetJobPollTimer = ref(null);
const activePreviewClip = ref(null);
const previewPlaying = ref(false);
const projectPackageImportInputRef = ref(null);
const importingProjectPackage = ref(false);
const projectPackageImportProgress = ref(0);
const draggedAssetId = ref('');
const dragOverAssetId = ref('');
const editorBaselineSignature = ref('');
const sidebarCollapsed = ref(false);
const agentCollapsed = ref(false);
const stoppingAgent = ref(false);
const cancelRequestedRunId = ref('');
const agentRunAbortController = ref(null);
const documentPreviewVisible = ref(false);
const documentPreviewLoading = ref(false);
const documentPreviewSectionId = ref('master');
const sliceDocumentCache = ref({});
const contextMenu = ref({
  visible: false,
  x: 0,
  y: 0,
  scope: 'global',
  assetId: ''
});
let confirmDialogAction = null;
const panelSizes = ref({
  sidebarWidth: 230,
  agentWidth: 420,
  previewHeight: 180
});

const assetJobMap = computed(() => {
  const map = {};
  for (const job of assetJobs.value || []) {
    if (!job?.assetId) continue;
    if (!String(job.type || '').startsWith('asset.')) continue;
    if (!map[job.assetId]) {
      map[job.assetId] = job;
    }
  }
  return map;
});

const projectAssets = computed(() => (project.value?.projectAssets || []).map((relation) => ({
  id: relation.asset.id,
  title: relation.asset.title,
  duration_seconds: relation.asset.duration_seconds,
  asr_status: relation.asset.asr_status,
  source_url: relation.asset.source_url || `/api/library/assets/${relation.asset.id}/source`,
  ingest_job: assetJobMap.value[relation.asset.id] || null
})));

const isExportingAny = computed(() => (
  exportingVideo.value ||
  exportingPackage.value ||
  Boolean(exportingInterchangeFormat.value) ||
  exportingSliceXmlBundle.value
));

const exportTriggerLabel = computed(() => {
  if (exportingVideo.value) return '视频导出中...';
  if (exportingPackage.value) return '工程包导出中...';
  if (exportingInterchangeFormat.value === 'premiere_xml') return 'XML 导出中...';
  if (exportingInterchangeFormat.value === 'edl') return 'EDL 导出中...';
  if (exportingInterchangeFormat.value === 'capcut_srt') return 'SRT 导出中...';
  if (exportingSliceXmlBundle.value) return '切片 XML 打包中...';
  return `导出 ${activeExportTargetLabel.value}`;
});

const orderedProjectAssets = computed(() => [...projectAssets.value]);
const projectAssetsById = computed(() => Object.fromEntries(projectAssets.value.map((asset) => [asset.id, asset])));
const projectSlices = computed(() => (project.value?.timelines || []).filter((timelineItem) => timelineItem.kind === 'slice'));
const isLiveSlicingMode = computed(() => workspaceMode.value === 'live_slicing');

const assetToneMap = computed(() => {
  const map = {};
  orderedProjectAssets.value.forEach((asset, index) => {
    map[asset.id] = PALETTE[index % PALETTE.length];
  });
  return map;
});

const baselineAssetRanges = computed(() => {
  let cursor = 0;
  return orderedProjectAssets.value.map((asset, index) => {
    const assetWords = assetWordsMap.value[asset.id] || [];
    const wordDuration = assetWords.length ? Number(assetWords[assetWords.length - 1]?.end_time || 0) : 0;
    const duration = roundTime(Math.max(Number(asset.duration_seconds || 0), wordDuration));
    const start = roundTime(cursor);
    const end = roundTime(start + duration);
    cursor = end;
    return {
      kind: 'asset',
      clip_id: `asset_${asset.id}`,
      asset_id: asset.id,
      asset_title: asset.title,
      label: asset.title || '',
      source_start: 0,
      source_end: duration,
      timeline_start: start,
      timeline_end: end,
      duration,
      sort_order: index + 1,
      asset_source_url: asset.source_url
    };
  });
});

const clipTimelineRanges = computed(() => {
  const clips = Array.isArray(timeline.value?.clips) ? [...timeline.value.clips] : [];
  if (clips.length) {
    let cursor = 0;
    return clips
      .sort((left, right) => {
        const leftOrder = Number(left.sort_order || left.sortOrder || 0);
        const rightOrder = Number(right.sort_order || right.sortOrder || 0);
        if (leftOrder !== rightOrder) return leftOrder - rightOrder;
        const leftStart = Number(left.timeline_start || left.timelineStart || 0);
        const rightStart = Number(right.timeline_start || right.timelineStart || 0);
        if (leftStart !== rightStart) return leftStart - rightStart;
        return String(left.id || '').localeCompare(String(right.id || ''));
      })
      .map((clip, index) => {
        const asset = projectAssetsById.value[clip.asset_id] || null;
        const sourceStart = roundTime(Number(clip.source_start || 0));
        const sourceEnd = roundTime(Math.max(sourceStart + 0.01, Number(clip.source_end || clip.source_start || 0)));
        const duration = roundTime(Math.max(0.01, sourceEnd - sourceStart));
        const timelineStart = roundTime(cursor);
        const timelineEnd = roundTime(timelineStart + duration);
        cursor = timelineEnd;
        return {
          kind: 'clip',
          clip_id: clip.id || `timeline_clip_${index + 1}`,
          asset_id: clip.asset_id,
          asset_title: clip.asset_title || asset?.title || '',
          label: clip.label || clip.asset_title || asset?.title || '',
          source_start: sourceStart,
          source_end: sourceEnd,
          timeline_start: timelineStart,
          timeline_end: timelineEnd,
          duration,
          sort_order: Number(clip.sort_order || clip.sortOrder || index + 1),
          asset_source_url: clip.asset_source_url || asset?.source_url || `/api/library/assets/${clip.asset_id}/source`
        };
      })
      .filter((clip) => clip.source_end > clip.source_start);
  }

  let cursor = 0;
  return orderedProjectAssets.value.map((asset, index) => {
    const start = cursor;
    const duration = Number(asset.duration_seconds || 0);
    const end = start + duration;
    cursor = end;
    return {
      kind: 'asset',
      clip_id: `asset_${asset.id}`,
      asset_id: asset.id,
      asset_title: asset.title,
      label: asset.title || '',
      source_start: 0,
      source_end: roundTime(duration),
      timeline_start: roundTime(start),
      timeline_end: roundTime(end),
      duration: roundTime(duration),
      sort_order: index + 1,
      asset_source_url: asset.source_url
    };
  });
});

const fullProjectDuration = computed(() => {
  return baselineAssetRanges.value.reduce((max, range) => Math.max(max, Number(range.timeline_end || 0)), 0);
});

const selectedAsset = computed(() => orderedProjectAssets.value.find((asset) => asset.id === selectedAssetId.value) || null);

const currentContextAsset = computed(() => {
  const range = findClipRangeAtTime(Number(editorStore.currentTime || 0));
  if (range) {
    return orderedProjectAssets.value.find((asset) => asset.id === range.asset_id) || null;
  }
  return selectedAsset.value;
});

const previewKeepRanges = computed(() => buildProjectKeepRanges());
const projectPreviewClips = computed(() => buildPreviewClipsFromRanges(previewKeepRanges.value));
const selectedSlice = computed(() => {
  if (!selectedSliceId.value) return null;
  if (selectedSliceDetail.value?.id === selectedSliceId.value) {
    return selectedSliceDetail.value;
  }
  return projectSlices.value.find((slice) => slice.id === selectedSliceId.value) || null;
});
const selectedSliceRanges = computed(() => {
  if (Array.isArray(selectedSliceDetail.value?.ranges) && selectedSliceDetail.value.ranges.length) {
    return selectedSliceDetail.value.ranges;
  }
  return (selectedSlice.value?.clips || [])
    .map((clip) => ({
      start: Number(clip.original_project_start || clip.timeline_start || 0),
      end: Number(clip.original_project_end || clip.timeline_end || 0)
    }))
    .filter((range) => Number(range.end || 0) - Number(range.start || 0) > 0.05);
});
const selectedSlicePreviewClips = computed(() => buildPreviewClipsFromRanges(selectedSliceRanges.value));
const activePreviewClips = computed(() => (
  isLiveSlicingMode.value && selectedSlicePreviewClips.value.length
    ? selectedSlicePreviewClips.value
    : projectPreviewClips.value
));
const currentPreviewDuration = computed(() => Number(activePreviewClips.value[activePreviewClips.value.length - 1]?.project_end || 0));
const currentPreviewTime = computed(() => originalProjectTimeToPreviewTime(Number(editorStore.currentTime || 0), activePreviewClips.value));
const activeExportTimelineId = computed(() => (isLiveSlicingMode.value ? String(selectedSliceId.value || '').trim() : ''));
const activeExportTargetLabel = computed(() => {
  if (activeExportTimelineId.value && selectedSlice.value) {
    return `切片 · ${selectedSlice.value.title}`;
  }
  return '当前成片';
});

const documentTriggerLabel = computed(() => (
  isLiveSlicingMode.value ? '文稿 · 切片' : '文稿'
));

const previewLabel = computed(() => {
  const clip = activePreviewClip.value
    || activePreviewClips.value[findPreviewClipIndexForProjectTime(Number(currentPreviewTime.value || 0), activePreviewClips.value)]
    || null;
  if (!clip) return '当前项目没有可预览的成片片段';
  return `${clip.asset_title} · ${formatDuration(clip.source_start)} - ${formatDuration(clip.source_end)}`;
});

const workspaceLayoutStyle = computed(() => ({
  '--sidebar-width': `${sidebarCollapsed.value ? 34 : panelSizes.value.sidebarWidth}px`,
  '--agent-width': `${agentCollapsed.value ? 34 : panelSizes.value.agentWidth}px`
}));

const editorPanelStyle = computed(() => ({
  '--preview-height': `${panelSizes.value.previewHeight}px`
}));

const contextMenuStyle = computed(() => ({
  left: `${contextMenu.value.x}px`,
  top: `${contextMenu.value.y}px`
}));
const projectUploadDragActive = computed(() => projectUploadDragDepth.value > 0);
const processingAssetIds = computed(() => orderedProjectAssets.value
  .filter((asset) => ['processing', 'pending', 'provided'].includes(String(asset.asr_status || '').trim()))
  .map((asset) => asset.id));

const timelineDirty = computed(() => captureEditorSignature() !== editorBaselineSignature.value);
const totalWords = computed(() => editorStore.totalWords);
const deletedWordCount = computed(() => editorStore.deletedWordCount);
const deletedGapDuration = computed(() => editorStore.deletedGapDuration);
const selectedWordIndices = computed(() => Array.from(editorStore.selectedWords || []).sort((left, right) => left - right));
const manualSliceSelectionRanges = computed(() => {
  const allWords = Array.isArray(editorStore.words) ? editorStore.words : [];
  const indices = selectedWordIndices.value.filter((index) => Number.isInteger(index) && index >= 0 && index < allWords.length);
  if (!indices.length) return [];

  const groups = [];
  let current = {
    startIndex: indices[0],
    endIndex: indices[0]
  };

  for (let pointer = 1; pointer < indices.length; pointer += 1) {
    const index = indices[pointer];
    if (index === current.endIndex + 1) {
      current.endIndex = index;
      continue;
    }
    groups.push(current);
    current = {
      startIndex: index,
      endIndex: index
    };
  }
  groups.push(current);

  return mergeRanges(groups.map((group) => ({
    start: Number(allWords[group.startIndex]?.start_time || 0),
    end: Number(allWords[group.endIndex]?.end_time || allWords[group.startIndex]?.start_time || 0)
  })));
});
const manualSliceSelectionDuration = computed(() => manualSliceSelectionRanges.value.reduce((sum, range) => sum + Math.max(0, Number(range.end || 0) - Number(range.start || 0)), 0));
const sliceMutationBusy = computed(() => Boolean(mutatingSlice.value || deletingSliceId.value));
const canCreateManualSlice = computed(() => isLiveSlicingMode.value && manualSliceSelectionRanges.value.length > 0 && !sliceMutationBusy.value);
const canAppendSelectionToSlice = computed(() => canCreateManualSlice.value && Boolean(selectedSliceId.value));
const canRemoveSelectionFromSlice = computed(() => canCreateManualSlice.value && Boolean(selectedSliceId.value));
const liveSliceSelectionHint = computed(() => {
  if (!projectSlices.value.length) {
    return canCreateManualSlice.value
      ? `已选 ${manualSliceSelectionRanges.value.length} 段 · ${formatDuration(manualSliceSelectionDuration.value)}，可直接新建第一条手动切片。`
      : '自动切片优先通过右侧 Agent 完成；手动切片时，先在字幕里框选一段内容。';
  }
  if (!manualSliceSelectionRanges.value.length) {
    return selectedSlice.value
      ? `当前切片：${selectedSlice.value.title}。先在字幕里框选一段内容，再加入或移出当前切片。`
      : '先选择一个切片，或在字幕里框选一段内容后新建切片。';
  }
  return `已选 ${manualSliceSelectionRanges.value.length} 段 · ${formatDuration(manualSliceSelectionDuration.value)}，可新建切片，或加入/移出当前切片。`;
});

function buildTranscriptBlocksFromEditorWords(words = [], {
  deletedWords = new Set(),
  deletedGaps = new Set(),
  hardGapThreshold = 1.1,
  maxBlockChars = 90
} = {}) {
  const sourceWords = Array.isArray(words) ? words : [];
  const blocks = [];
  let current = null;
  let lastKeptIndex = -1;

  const pushCurrent = () => {
    if (!current || !String(current.text || '').trim()) return;
    blocks.push({
      id: `doc_block_${blocks.length + 1}`,
      start: roundTime(current.start),
      end: roundTime(current.end),
      text: current.text
    });
    current = null;
  };

  for (let index = 0; index < sourceWords.length; index += 1) {
    if (deletedWords.has(index)) continue;
    const word = sourceWords[index];
    const previousWord = lastKeptIndex >= 0 ? sourceWords[lastKeptIndex] : null;
    const gapDuration = previousWord
      ? Number(word.start_time || 0) - Number(previousWord.end_time || previousWord.start_time || 0)
      : 0;
    const shouldBreak = Boolean(
      current && (
        deletedGaps.has(lastKeptIndex) ||
        gapDuration >= hardGapThreshold ||
        (/[。！？!?；;]$/.test(String(previousWord?.text || '')) && current.text.length >= 20) ||
        current.text.length >= maxBlockChars
      )
    );

    if (!current || shouldBreak) {
      pushCurrent();
      current = {
        start: Number(word.start_time || 0),
        end: Number(word.end_time || word.start_time || 0),
        text: ''
      };
    }

    current.text += String(word.text || '');
    current.end = Number(word.end_time || word.start_time || current.end);
    lastKeptIndex = index;
  }

  pushCurrent();
  return blocks;
}

function normalizeDocumentBlocks(blocks = []) {
  return (Array.isArray(blocks) ? blocks : [])
    .map((block, index) => ({
      id: block.id || `doc_block_${index + 1}`,
      start: Number(block.start || 0),
      end: Number(block.end || block.start || 0),
      text: String(block.text || '').trim()
    }))
    .filter((block) => block.text);
}

function buildDocumentParagraphs(blocks = [], {
  minParagraphChars = 120,
  maxParagraphChars = 260
} = {}) {
  const normalized = normalizeDocumentBlocks(blocks);
  if (!normalized.length) return [];

  const paragraphs = [];
  let current = '';

  const pushCurrent = () => {
    const text = String(current || '').trim();
    if (!text) return;
    paragraphs.push(text);
    current = '';
  };

  for (const block of normalized) {
    const text = String(block.text || '').trim();
    if (!text) continue;
    const candidate = current ? `${current}${text}` : text;
    const shouldBreak = Boolean(
      current && (
        current.length >= maxParagraphChars ||
        (current.length >= minParagraphChars && /[。！？!?；;]$/.test(current))
      )
    );

    if (shouldBreak) {
      pushCurrent();
      current = text;
      continue;
    }

    current = candidate;
  }

  pushCurrent();
  return paragraphs;
}

function formatRangeLabel(start, end) {
  return `${formatDuration(start)} - ${formatDuration(end)}`;
}

const masterDocumentSection = computed(() => {
  const blocks = buildTranscriptBlocksFromEditorWords(editorStore.words || [], {
    deletedWords: editorStore.deletedWords,
    deletedGaps: editorStore.deletedGaps
  });
  const paragraphs = buildDocumentParagraphs(blocks);
  const fullText = blocks.map((block) => block.text).join('\n\n');
  const totalDuration = Number(currentPreviewDuration.value || 0);
  return {
    id: 'master',
    title: isLiveSlicingMode.value ? '当前成片文稿' : '项目文稿',
    timeLabel: formatRangeLabel(0, totalDuration),
    kicker: `${formatDuration(totalDuration)} · ${paragraphs.length || 0} 段`,
    preview: paragraphs[0]?.slice(0, 80) || fullText.slice(0, 80),
    paragraphs,
    fullText
  };
});

const sliceDocumentSections = computed(() => projectSlices.value.map((slice) => {
  const detail = selectedSliceDetail.value?.id === slice.id
    ? selectedSliceDetail.value
    : sliceDocumentCache.value[slice.id];
  const blocks = normalizeDocumentBlocks(detail?.transcript_blocks || []);
  const paragraphs = buildDocumentParagraphs(blocks);
  const fullText = String(detail?.transcript_text || '').trim();
  const ranges = Array.isArray(detail?.ranges) ? detail.ranges : [];
  const rangeStart = ranges.length ? Math.min(...ranges.map((range) => Number(range.start || 0))) : 0;
  const rangeEnd = ranges.length ? Math.max(...ranges.map((range) => Number(range.end || 0))) : Number(slice.total_duration || detail?.total_duration || 0);
  return {
    id: slice.id,
    title: slice.title || slice.name || '未命名切片',
    timeLabel: formatRangeLabel(rangeStart, rangeEnd),
    kicker: `${formatDuration(slice.total_duration || detail?.total_duration || 0)} · ${paragraphs.length || 0} 段`,
    preview: (paragraphs[0] || fullText || '点击查看该切片文稿').slice(0, 80),
    paragraphs,
    fullText
  };
}));

const documentPreviewSections = computed(() => (
  isLiveSlicingMode.value ? sliceDocumentSections.value : [masterDocumentSection.value]
));

const canOpenDocumentPreview = computed(() => {
  if (isLiveSlicingMode.value) {
    return Boolean(projectSlices.value.length);
  }
  return Boolean(masterDocumentSection.value.paragraphs?.length || masterDocumentSection.value.fullText);
});

const documentActionLabel = computed(() => (
  isLiveSlicingMode.value ? '打开切片文稿' : '打开当前文稿'
));

const documentPreviewTitle = computed(() => (
  isLiveSlicingMode.value ? '切片文稿预览' : '当前成片文稿'
));

const activeDocumentSection = computed(() => (
  documentPreviewSections.value.find((section) => section.id === documentPreviewSectionId.value)
  || documentPreviewSections.value[0]
  || null
));

const documentPreviewSubtitle = computed(() => {
  const section = activeDocumentSection.value;
  if (!section) {
    return isLiveSlicingMode.value ? '先生成切片，再打开文稿。' : '当前还没有可显示的文稿内容。';
  }
  return section.timeLabel || section.kicker || '文稿';
});

const agentActionLabel = computed(() => {
  const map = {
    assemble_script: '口播拼稿',
    live_slicing: '直播切片',
    custom: '自由指令'
  };
  return map[agentMode.value] || '项目 Agent';
});

const agentSessionSummary = computed(() => String(agentSession.value?.summary || '').trim());
const pendingConfirmationRun = computed(() =>
  (agentSession.value?.runs || []).find((run) => run.requires_confirmation || run.status === 'waiting_confirmation') || null
);
const recentRuns = computed(() => (agentSession.value?.runs || []).slice(0, 8));
const latestAppliedChanges = computed(() => recentRuns.value[0]?.applied_changes || []);
const selectedRun = computed(() => recentRuns.value.find((run) => run.id === selectedRunId.value) || recentRuns.value[0] || null);
const visibleRunEvents = computed(() => {
  if (liveRunEvents.value.length) return liveRunEvents.value;
  return selectedRunEvents.value;
});
const thinkingTraceEvents = computed(() => liveRunEvents.value.slice(-4));
const showThinkingBubble = computed(() =>
  runningAgent.value ||
  stoppingAgent.value ||
  ['running', 'waiting_confirmation', 'cancelling', '准备执行', '正在停止...'].includes(String(activeRunStatus.value || ''))
);

const agentStatusLabel = computed(() => {
  if (runningAgent.value) {
    return activeRunStatus.value || '执行中';
  }
  if (activeRunStatus.value) {
    return activeRunStatus.value;
  }
  return '待命';
});

const agentPlaceholder = computed(() => {
  if (agentMode.value === 'assemble_script') return '例如：这些素材是同一份口播稿的多次录制，请尽量完整保留内容，只去掉重复表达、口头禅和明显停顿。';
  if (agentMode.value === 'live_slicing') return '例如：先分析全文，给我 4 个适合发短视频的平台切片候选，每条控制在 30-50 秒。';
  return '输入你对整个项目时间线的要求。';
});

function roundTime(value) {
  return Number(Number(value || 0).toFixed(3));
}

function mergeRanges(ranges = []) {
  const normalized = (Array.isArray(ranges) ? ranges : [])
    .map((range) => ({
      start: roundTime(Number(range?.start || 0)),
      end: roundTime(Number(range?.end || 0))
    }))
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end - range.start > 0.05)
    .sort((left, right) => left.start - right.start);

  if (!normalized.length) return [];

  const merged = [normalized[0]];
  for (let index = 1; index < normalized.length; index += 1) {
    const current = normalized[index];
    const previous = merged[merged.length - 1];
    if (current.start <= previous.end + 0.05) {
      previous.end = roundTime(Math.max(previous.end, current.end));
      continue;
    }
    merged.push({ ...current });
  }
  return merged;
}

function subtractRanges(baseRanges = [], removeRanges = []) {
  const source = mergeRanges(baseRanges);
  const cuts = mergeRanges(removeRanges);
  if (!source.length || !cuts.length) return source;

  const result = [];
  for (const base of source) {
    let fragments = [{ ...base }];
    for (const cut of cuts) {
      const nextFragments = [];
      for (const fragment of fragments) {
        const overlapStart = Math.max(fragment.start, cut.start);
        const overlapEnd = Math.min(fragment.end, cut.end);
        if (overlapEnd - overlapStart <= 0.001) {
          nextFragments.push(fragment);
          continue;
        }
        if (overlapStart - fragment.start > 0.05) {
          nextFragments.push({
            start: fragment.start,
            end: roundTime(overlapStart)
          });
        }
        if (fragment.end - overlapEnd > 0.05) {
          nextFragments.push({
            start: roundTime(overlapEnd),
            end: fragment.end
          });
        }
      }
      fragments = nextFragments;
      if (!fragments.length) break;
    }
    result.push(...fragments);
  }
  return mergeRanges(result);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatDuration(seconds) {
  const safe = Number(seconds || 0);
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function formatDateTime(value) {
  if (!value) return '刚刚';
  return new Date(value).toLocaleString();
}

function isAssetProcessing(asset) {
  return ['processing', 'pending', 'provided'].includes(String(asset?.asr_status || '').trim());
}

function isRetryingAsset(assetId) {
  return retryingAssetIds.value.includes(assetId);
}

function assetProgressValue(asset) {
  if (!isAssetProcessing(asset)) {
    return String(asset?.asr_status || '') === 'completed' ? 100 : 0;
  }
  const raw = Number(asset?.ingest_job?.progress ?? 0);
  return clamp(Number.isFinite(raw) ? raw : 0, 0, 99);
}

function assetProgressMessage(asset) {
  if (asset?.ingest_job?.message) {
    return String(asset.ingest_job.message);
  }
  if (String(asset?.asr_status || '') === 'failed') {
    return '转写失败，请重试。';
  }
  if (String(asset?.asr_status || '') === 'completed') {
    return '转写完成';
  }
  return '正在识别字幕并对齐时间轴…';
}

function assetProgressLabel(asset) {
  if (String(asset?.asr_status || '') === 'provided') {
    return '导入字幕';
  }
  return '转写中';
}

function assetStateLabel(asset) {
  if (String(asset?.asr_status || '') === 'failed') return '失败';
  if (isAssetProcessing(asset)) return '转写中';
  return isAssetOnTimeline(asset.id) ? '在轨' : '空轨';
}

async function retryAssetTranscription(assetId) {
  if (!assetId || isRetryingAsset(assetId)) return;

  retryingAssetIds.value = [...retryingAssetIds.value, assetId];
  try {
    await retranscribeLibraryAsset(assetId, { language: 'Chinese' });
    await refreshProcessingAssets();
    if (!assetJobPollTimer.value) {
      assetJobPollTimer.value = setInterval(() => {
        refreshProcessingAssets().catch(() => {});
      }, 1800);
    }
  } catch (retryError) {
    error.value = retryError?.response?.data?.error || retryError?.message || '重试转写失败';
  } finally {
    retryingAssetIds.value = retryingAssetIds.value.filter((id) => id !== assetId);
  }
}

function getRunStatusText(status) {
  const map = {
    running: '执行中',
    completed: '已完成',
    failed: '失败',
    waiting_confirmation: '待确认',
    cancelled: '已取消'
  };
  return map[String(status || '').trim()] || String(status || 'idle');
}

function summarizeEventPayload(event) {
  const payload = event?.payload || {};
  if (event?.type === 'plan_decision') {
    if (payload.finish) {
      return payload.summary || '';
    }
    const tool = payload.tool || 'tool';
    const args = payload.args && Object.keys(payload.args).length ? JSON.stringify(payload.args) : '';
    return [tool, args, payload.reason || ''].filter(Boolean).join(' · ');
  }
  if (event?.type === 'tool_call') {
    const tool = payload.tool || 'tool';
    const args = payload.args && Object.keys(payload.args).length ? JSON.stringify(payload.args) : '';
    return args ? `${tool} ${args}` : tool;
  }
  if (event?.type === 'tool_result') {
    const tool = payload.tool || payload.payload?.tool || '';
    const summary = payload.summary || payload.payload?.summary || '';
    return [tool, summary].filter(Boolean).join(' · ');
  }
  if (event?.type === 'review_start' || event?.type === 'review_fixed' || event?.type === 'review_passed') {
    return payload.summary || '';
  }
  if (event?.type === 'waiting_confirmation') {
    return payload.tool ? `${payload.tool} 待确认` : '';
  }
  return '';
}

function getAssetTone(assetId) {
  return assetToneMap.value[assetId] || PALETTE[0];
}

function assetRowStyle(assetId) {
  const tone = getAssetTone(assetId);
  return {
    '--asset-color': tone.solid,
    '--asset-soft': tone.soft,
    '--asset-border': tone.border
  };
}

function isAssetOnTimeline(assetId) {
  return (timeline.value?.clips || []).some((clip) => clip.asset_id === assetId);
}

function findFirstClipRangeForAsset(assetId) {
  return clipTimelineRanges.value.find((item) => item.asset_id === assetId) || null;
}

function findClipRangeAtTime(time) {
  return clipTimelineRanges.value.find((item) =>
    time >= Number(item.timeline_start || 0) && time <= Number(item.timeline_end || 0)
  ) || null;
}

function findPreviewClipIndexForProjectTime(projectTime, clips = activePreviewClips.value) {
  const currentTime = Number(projectTime || 0);
  let clipIndex = clips.findIndex((clip, index) => {
    const start = Number(clip.project_start || 0);
    const end = Number(clip.project_end || start);
    const isLastClip = index === clips.length - 1;
    return currentTime >= start && (isLastClip ? currentTime <= end : currentTime < end);
  });
  if (clipIndex !== -1) return clipIndex;

  clipIndex = clips.findIndex((clip) => Number(clip.project_start || 0) >= currentTime);
  if (clipIndex === -1 && clips.length && currentTime > Number(clips[clips.length - 1]?.project_end || 0)) {
    return clips.length - 1;
  }
  return clipIndex;
}

function seekPreviewToProjectTime(projectTime, autoplay = false) {
  previewPlayerRef.value?.seekToProjectTime(projectTime, autoplay);
}

function originalProjectTimeToPreviewTime(projectTime, clips = activePreviewClips.value) {
  const target = Number(projectTime || 0);
  if (!clips.length) return 0;

  for (let index = 0; index < clips.length; index += 1) {
    const clip = clips[index];
    const originalStart = Number(clip.original_project_start || clip.project_start || 0);
    const originalEnd = Number(clip.original_project_end || originalStart);
    const previewStart = Number(clip.project_start || 0);
    const previewEnd = Number(clip.project_end || previewStart);
    const clipDuration = Math.max(0.001, originalEnd - originalStart);

    if (target <= originalStart) {
      return roundTime(previewStart);
    }
    if (target < originalEnd || index === clips.length - 1) {
      const progress = Math.max(0, Math.min(1, (target - originalStart) / clipDuration));
      return roundTime(previewStart + ((previewEnd - previewStart) * progress));
    }
  }

  return roundTime(Number(clips[clips.length - 1]?.project_end || 0));
}

function previewTimeToOriginalProjectTime(previewTime, clips = activePreviewClips.value) {
  const target = Math.max(0, Number(previewTime || 0));
  if (!clips.length) return 0;

  for (let index = 0; index < clips.length; index += 1) {
    const clip = clips[index];
    const previewStart = Number(clip.project_start || 0);
    const previewEnd = Number(clip.project_end || previewStart);
    const originalStart = Number(clip.original_project_start || clip.project_start || 0);
    const originalEnd = Number(clip.original_project_end || originalStart);
    const previewDuration = Math.max(0.001, previewEnd - previewStart);

    if (target <= previewStart) {
      return roundTime(originalStart);
    }
    if (target < previewEnd || index === clips.length - 1) {
      const progress = Math.max(0, Math.min(1, (target - previewStart) / previewDuration));
      return roundTime(originalStart + ((originalEnd - originalStart) * progress));
    }
  }

  return roundTime(Number(clips[clips.length - 1]?.original_project_end || 0));
}

function isPreviewPlaybackActive() {
  return Boolean(previewPlaying.value || previewPlayerRef.value?.isPlaybackActive?.());
}

function syncPreviewToCurrentTime({ preservePlayback = isPreviewPlaybackActive() } = {}) {
  if (!activePreviewClips.value.length) {
    activePreviewClip.value = null;
    previewPlayerRef.value?.pausePlayback?.();
    return;
  }
  const currentTime = originalProjectTimeToPreviewTime(Number(editorStore.currentTime || 0), activePreviewClips.value);
  seekPreviewToProjectTime(currentTime, preservePlayback);
}

function normalizeAssetWords(words = []) {
  return words
    .map((word, index) => {
      const start = Number(word.start_time || 0);
      const end = Number(word.end_time || start);
      return {
        id: word.id || `word:${index}`,
        asset_word_index: Number.isInteger(word.asset_word_index) ? Number(word.asset_word_index) : index,
        text: String(word.text || ''),
        start_time: roundTime(start),
        end_time: roundTime(Math.max(start + 0.01, end))
      };
    })
    .sort((a, b) => a.start_time - b.start_time);
}

function sliceRangesFromTimelineItem(timelineItem) {
  return (timelineItem?.clips || [])
    .map((clip) => ({
      start: Number(clip.original_project_start || clip.timeline_start || 0),
      end: Number(clip.original_project_end || clip.timeline_end || 0)
    }))
    .filter((range) => Number(range.end || 0) - Number(range.start || 0) > 0.05);
}

async function ensureProjectAssetWordsLoaded(assetIds = [], { force = false } = {}) {
  const targetIds = force ? assetIds : assetIds.filter((assetId) => !assetWordsMap.value[assetId]);
  if (!targetIds.length) return;

  const loadedWordGroups = await Promise.all(targetIds.map((assetId) => getLibraryAssetWords(assetId, projectId.value)));
  const next = force ? {} : { ...assetWordsMap.value };
  targetIds.forEach((assetId, index) => {
    next[assetId] = normalizeAssetWords(loadedWordGroups[index]);
  });
  assetWordsMap.value = next;
}

function buildProjectWordStream() {
  const merged = [];
  const sliceDescriptors = projectSlices.value.map((slice) => ({
    id: slice.id,
    title: slice.title || slice.name || '未命名切片',
    color: slice.color || '#4cc2ff',
    ranges: sliceRangesFromTimelineItem(slice)
  }));

  for (const range of baselineAssetRanges.value) {
    const assetWords = assetWordsMap.value[range.asset_id] || [];
    const tone = getAssetTone(range.asset_id);
    let appended = 0;

    for (const word of assetWords) {
      const sourceStart = Number(word.start_time || 0);
      const sourceEnd = Math.max(sourceStart + 0.01, Number(word.end_time || sourceStart + 0.01));
      const clippedSourceStart = Math.max(sourceStart, Number(range.source_start || 0));
      const clippedSourceEnd = Math.min(sourceEnd, Number(range.source_end || sourceEnd));
      if (clippedSourceEnd - clippedSourceStart <= 0.001) continue;
      const projectStart = roundTime(Number(range.timeline_start || 0) + (clippedSourceStart - Number(range.source_start || 0)));
      const projectEnd = roundTime(Number(range.timeline_start || 0) + (clippedSourceEnd - Number(range.source_start || 0)));
      const sliceMarkers = sliceDescriptors
        .filter((slice) => slice.ranges.some((sliceRange) => projectStart < sliceRange.end && projectEnd > sliceRange.start))
        .map((slice) => ({
          id: slice.id,
          title: slice.title,
          color: slice.color
        }));
      merged.push({
        id: `${range.clip_id}:${word.id}`,
        word_key: word.id,
        gap_key_after: `${range.asset_id}:gap:${Number(word.asset_word_index || 0)}`,
        text: word.text,
        start_time: projectStart,
        end_time: projectEnd,
        asset_id: range.asset_id,
        asset_title: range.asset_title,
        clip_id: range.clip_id,
        clip_label: range.label,
        asset_word_index: Number(word.asset_word_index || 0),
        source_start_time: roundTime(clippedSourceStart),
        source_end_time: roundTime(clippedSourceEnd),
        asset_color: tone.border,
        asset_soft: tone.soft,
        slice_markers: sliceMarkers,
        slice_active: selectedSliceId.value ? sliceMarkers.some((marker) => marker.id === selectedSliceId.value) : false,
        slice_active_color: selectedSliceId.value
          ? (sliceMarkers.find((marker) => marker.id === selectedSliceId.value)?.color || '')
          : ''
      });
      appended += 1;
    }

    if (!appended) {
      const placeholderDuration = Math.max(0.01, Math.min(0.2, Number(range.duration || 0.2)));
      merged.push({
        id: `${range.clip_id}:placeholder`,
        text: `[${range.asset_title}]`,
        start_time: roundTime(Number(range.timeline_start || 0)),
        end_time: roundTime(Number(range.timeline_start || 0) + placeholderDuration),
        asset_id: range.asset_id,
        asset_title: range.asset_title,
        clip_id: range.clip_id,
        clip_label: range.label,
        source_start_time: roundTime(Number(range.source_start || 0)),
        source_end_time: roundTime(Math.min(Number(range.source_start || 0) + placeholderDuration, Number(range.source_end || placeholderDuration))),
        asset_color: tone.border,
        asset_soft: tone.soft
      });
    }
  }

  return {
    words: merged,
    duration: Number(fullProjectDuration.value || 0)
  };
}

function buildPreviewClipsFromRanges(ranges = []) {
  const previewClips = [];
  let playbackCursor = 0;

  for (const range of ranges) {
    for (const clipRange of baselineAssetRanges.value) {
      const overlapStart = Math.max(Number(range.start || 0), Number(clipRange.timeline_start || 0));
      const overlapEnd = Math.min(Number(range.end || 0), Number(clipRange.timeline_end || 0));
      if (overlapEnd - overlapStart <= 0.001) continue;
      const overlapDuration = overlapEnd - overlapStart;
      const playbackStart = playbackCursor;
      const playbackEnd = playbackCursor + overlapDuration;

      previewClips.push({
        id: `preview:${clipRange.clip_id}:${roundTime(overlapStart)}:${roundTime(overlapEnd)}`,
        clip_id: clipRange.clip_id,
        asset_id: clipRange.asset_id,
        asset_title: clipRange.asset_title,
        asset_source_url: clipRange.asset_source_url,
        source_start: roundTime(Number(clipRange.source_start || 0) + (overlapStart - Number(clipRange.timeline_start || 0))),
        source_end: roundTime(Number(clipRange.source_start || 0) + (overlapEnd - Number(clipRange.timeline_start || 0))),
        project_start: roundTime(playbackStart),
        project_end: roundTime(playbackEnd),
        original_project_start: roundTime(overlapStart),
        original_project_end: roundTime(overlapEnd)
      });
      playbackCursor = playbackEnd;
    }
  }

  const merged = [];
  for (const clip of previewClips) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.clip_id === clip.clip_id &&
      previous.asset_id === clip.asset_id &&
      Math.abs(Number(previous.original_project_end || 0) - Number(clip.original_project_start || 0)) <= 0.02 &&
      Math.abs(Number(previous.source_end || 0) - Number(clip.source_start || 0)) <= 0.02
    ) {
      previous.source_end = clip.source_end;
      previous.project_end = clip.project_end;
      previous.original_project_end = clip.original_project_end;
      previous.id = `preview:${previous.asset_id}:${previous.project_start}:${previous.project_end}`;
    } else {
      merged.push({ ...clip });
    }
  }

  return merged;
}

function buildDeletedWordIndicesFromEditState(streamWords = []) {
  const deletedKeys = new Set(projectEditState.value?.deleted_word_keys || []);
  return streamWords.flatMap((word, index) => (deletedKeys.has(String(word.word_key || '')) ? [index] : []));
}

function buildDeletedGapIndicesFromEditState(streamWords = []) {
  const deletedKeys = new Set(projectEditState.value?.deleted_gap_keys || []);
  const indices = [];
  for (let index = 0; index < streamWords.length - 1; index += 1) {
    const current = streamWords[index];
    const next = streamWords[index + 1];
    if (!current || !next || current.asset_id !== next.asset_id) continue;
    if (deletedKeys.has(String(current.gap_key_after || ''))) {
      indices.push(index);
    }
  }
  return indices;
}

function captureEditorSignature() {
  return JSON.stringify({
    words: (editorStore.words || []).map((word) => [
      word.text,
      Number(word.start_time || 0),
      Number(word.end_time || 0),
      word.asset_id || ''
    ]),
    deletedWords: [...editorStore.deletedWords].sort((a, b) => a - b),
    deletedGaps: [...editorStore.deletedGaps].sort((a, b) => a - b)
  });
}

function syncEditorWithProjectTimeline() {
  const currentProjectTime = Number(editorStore.currentTime || 0);
  const stream = buildProjectWordStream();
  editorStore.loadExternalWords({
    words: stream.words,
    duration: stream.duration,
    currentTime: currentProjectTime,
    deletedWordIndices: buildDeletedWordIndicesFromEditState(stream.words),
    deletedGapIndices: buildDeletedGapIndicesFromEditState(stream.words)
  });
  editorBaselineSignature.value = captureEditorSignature();
}

function buildProjectKeepRanges() {
  const allWords = (editorStore.words || []).map((word, index) => ({ ...word, index }));
  const deletedWords = editorStore.deletedWords;
  const deletedGaps = editorStore.deletedGaps;
  const ranges = [];
  let segStart = null;

  for (let index = 0; index < allWords.length; index += 1) {
    const word = allWords[index];
    const kept = !deletedWords.has(word.index);

    if (kept) {
      if (segStart === null) segStart = index;
      const nextWordDeleted = index === allWords.length - 1 || deletedWords.has(allWords[index + 1].index);
      const deletedGapAfterWord = deletedGaps.has(word.index);

      if (nextWordDeleted || deletedGapAfterWord) {
        ranges.push({
          start: Number(allWords[segStart].start_time || 0),
          end: Number(word.end_time || allWords[segStart].start_time || 0)
        });
        segStart = null;
      }
    } else if (segStart !== null) {
      ranges.push({
        start: Number(allWords[segStart].start_time || 0),
        end: Number(allWords[index - 1].end_time || allWords[segStart].start_time || 0)
      });
      segStart = null;
    }
  }

  return ranges;
}

function buildPersistedDeletedWordKeys() {
  return (editorStore.words || [])
    .flatMap((word, index) => (editorStore.deletedWords.has(index) ? [String(word.word_key || word.id || '')] : []))
    .filter(Boolean);
}

function buildPersistedDeletedGapKeys() {
  return (editorStore.words || [])
    .flatMap((word, index) => (editorStore.deletedGaps.has(index) ? [String(word.gap_key_after || '')] : []))
    .filter(Boolean);
}

function buildTimelinePayloadFromRanges(ranges = []) {
  const payload = [];

  for (const range of ranges) {
    for (const clipRange of clipTimelineRanges.value) {
      const overlapStart = Math.max(Number(range.start || 0), Number(clipRange.timeline_start || 0));
      const overlapEnd = Math.min(Number(range.end || 0), Number(clipRange.timeline_end || 0));
      if (overlapEnd - overlapStart <= 0.001) continue;

      payload.push({
        clip_id: clipRange.clip_id,
        asset_id: clipRange.asset_id,
        source_start: roundTime(Number(clipRange.source_start || 0) + (overlapStart - Number(clipRange.timeline_start || 0))),
        source_end: roundTime(Number(clipRange.source_start || 0) + (overlapEnd - Number(clipRange.timeline_start || 0))),
        label: clipRange.label || clipRange.asset_title || ''
      });
    }
  }

  const merged = [];
  for (const spec of payload) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.clip_id === spec.clip_id &&
      previous.asset_id === spec.asset_id &&
      Math.abs(Number(previous.source_end || 0) - Number(spec.source_start || 0)) <= 0.02
    ) {
      previous.source_end = spec.source_end;
    } else {
      merged.push({ ...spec });
    }
  }

  return merged.map(({ clip_id, ...spec }) => spec);
}

async function bootstrapTimelineIfEmpty(projectData, timelineData) {
  if ((timelineData?.clips || []).length || !(projectData?.projectAssets || []).length) {
    return {
      timeline: timelineData,
      editState: await getProjectEditState(projectId.value)
    };
  }

  return updateProjectEditState(projectId.value, {
    assetOrder: (projectData.projectAssets || []).map((relation) => relation.asset.id),
    deletedWordKeys: [],
    deletedGapKeys: []
  });
}

async function ensureSelectedSliceDetail(sliceId, { force = false } = {}) {
  const targetId = String(sliceId || '').trim();
  if (!targetId) {
    selectedSliceDetail.value = null;
    return null;
  }
  if (!force && selectedSliceDetail.value?.id === targetId) {
    return selectedSliceDetail.value;
  }
  loadingSliceDetail.value = true;
  try {
    const detail = await getProjectSlice(projectId.value, targetId);
    selectedSliceDetail.value = detail;
    sliceDocumentCache.value = {
      ...sliceDocumentCache.value,
      [targetId]: detail
    };
    return detail;
  } finally {
    loadingSliceDetail.value = false;
  }
}

async function ensureSliceDocumentLoaded(sliceId, { force = false } = {}) {
  const targetId = String(sliceId || '').trim();
  if (!targetId) return null;
  if (!force && sliceDocumentCache.value[targetId]) {
    return sliceDocumentCache.value[targetId];
  }
  if (!force && selectedSliceDetail.value?.id === targetId) {
    sliceDocumentCache.value = {
      ...sliceDocumentCache.value,
      [targetId]: selectedSliceDetail.value
    };
    return selectedSliceDetail.value;
  }
  const detail = await getProjectSlice(projectId.value, targetId);
  sliceDocumentCache.value = {
    ...sliceDocumentCache.value,
    [targetId]: detail
  };
  if (selectedSliceId.value === targetId) {
    selectedSliceDetail.value = detail;
  }
  return detail;
}

async function refreshProjectSlices({ preserveSelection = true, skipFetch = false } = {}) {
  if (!project.value) return [];
  const masterTimelines = (project.value.timelines || []).filter((timelineItem) => timelineItem.kind !== 'slice');
  const nextSlices = skipFetch ? projectSlices.value : await listProjectSlices(projectId.value);
  project.value = {
    ...project.value,
    timelines: [...masterTimelines, ...nextSlices]
  };

  const hasSelected = preserveSelection && nextSlices.some((slice) => slice.id === selectedSliceId.value);
  if (hasSelected) {
    await ensureSelectedSliceDetail(selectedSliceId.value, { force: true });
    return nextSlices;
  }

  if (!nextSlices.length) {
    selectedSliceId.value = '';
    selectedSliceDetail.value = null;
    sliceDocumentCache.value = {};
    return nextSlices;
  }

  const validIds = new Set(nextSlices.map((slice) => slice.id));
  sliceDocumentCache.value = Object.fromEntries(
    Object.entries(sliceDocumentCache.value).filter(([sliceId]) => validIds.has(sliceId))
  );

  if (isLiveSlicingMode.value || selectedSliceId.value) {
    selectedSliceId.value = nextSlices[0].id;
    await ensureSelectedSliceDetail(selectedSliceId.value, { force: true });
  }

  syncEditorWithProjectTimeline();
  return nextSlices;
}

async function selectSlice(sliceId, { jumpToSliceStart = true } = {}) {
  const targetId = String(sliceId || '').trim();
  if (!targetId) return;
  selectedSliceId.value = targetId;
  const detail = await ensureSelectedSliceDetail(targetId, { force: true });
  syncEditorWithProjectTimeline();
  if (jumpToSliceStart) {
    const firstRange = detail?.ranges?.[0] || null;
    if (firstRange) {
      editorStore.setCurrentTime(Number(firstRange.start || 0));
    }
  }
  await nextTick();
  syncPreviewToCurrentTime({ preservePlayback: false });
}

async function openDocumentPreview(preferredSectionId = '') {
  if (!canOpenDocumentPreview.value) return;

  documentPreviewVisible.value = true;
  documentPreviewLoading.value = true;

  try {
    if (!isLiveSlicingMode.value) {
      documentPreviewSectionId.value = 'master';
      return;
    }

    const targetId = String(preferredSectionId || selectedSliceId.value || projectSlices.value[0]?.id || '').trim();
    documentPreviewSectionId.value = targetId;
    if (targetId) {
      await ensureSliceDocumentLoaded(targetId, { force: false });
    }
  } finally {
    documentPreviewLoading.value = false;
  }
}

async function handleDocumentSectionSelect(sectionId) {
  const targetId = String(sectionId || '').trim();
  if (!targetId) return;
  documentPreviewSectionId.value = targetId;
  if (isLiveSlicingMode.value) {
    documentPreviewLoading.value = true;
    try {
      await ensureSliceDocumentLoaded(targetId, { force: false });
    } finally {
      documentPreviewLoading.value = false;
    }
  }
}

function buildManualSliceTitle() {
  const excerpt = manualSliceSelectionRanges.value
    .map((range) => {
      const allWords = Array.isArray(editorStore.words) ? editorStore.words : [];
      return allWords
        .filter((word) => Number(word.start_time || 0) < range.end && Number(word.end_time || word.start_time || 0) > range.start)
        .map((word) => String(word.text || ''))
        .join('');
    })
    .join(' ')
    .replace(/\s+/g, '')
    .slice(0, 16);
  return excerpt ? `手动切片 · ${excerpt}` : `手动切片 ${projectSlices.value.length + 1}`;
}

async function createManualSliceFromSelection() {
  if (!canCreateManualSlice.value) return;
  mutatingSlice.value = true;
  try {
    if (timelineDirty.value) {
      await saveTimeline({
        createSnapshot: false,
        note: 'Pre-manual-slice create sync'
      });
    }
    const created = await createProjectSlice(projectId.value, {
      title: buildManualSliceTitle(),
      summary: `手动框选 ${manualSliceSelectionRanges.value.length} 段字幕后创建`,
      generated_by: 'manual_selection',
      target_duration_seconds: manualSliceSelectionDuration.value,
      ranges: manualSliceSelectionRanges.value
    });
    await refreshProjectSlices({ preserveSelection: false });
    await selectSlice(created.id);
    editorStore.clearSelection();
  } catch (sliceError) {
    window.alert(sliceError.response?.data?.error || sliceError.message || '新建手动切片失败');
  } finally {
    mutatingSlice.value = false;
  }
}

async function appendSelectionToCurrentSlice() {
  if (!canAppendSelectionToSlice.value) return;
  mutatingSlice.value = true;
  try {
    if (timelineDirty.value) {
      await saveTimeline({
        createSnapshot: false,
        note: 'Pre-manual-slice append sync'
      });
    }
    const detail = await ensureSelectedSliceDetail(selectedSliceId.value, { force: false });
    const mergedRanges = mergeRanges([...(detail?.ranges || []), ...manualSliceSelectionRanges.value]);
    const updated = await updateProjectSlice(projectId.value, selectedSliceId.value, {
      ranges: mergedRanges,
      generated_by: 'manual_selection'
    });
    selectedSliceDetail.value = updated;
    await refreshProjectSlices({ preserveSelection: true });
    editorStore.clearSelection();
  } catch (sliceError) {
    window.alert(sliceError.response?.data?.error || sliceError.message || '加入当前切片失败');
  } finally {
    mutatingSlice.value = false;
  }
}

async function removeSelectionFromCurrentSlice() {
  if (!canRemoveSelectionFromSlice.value) return;
  mutatingSlice.value = true;
  try {
    if (timelineDirty.value) {
      await saveTimeline({
        createSnapshot: false,
        note: 'Pre-manual-slice remove sync'
      });
    }
    const detail = await ensureSelectedSliceDetail(selectedSliceId.value, { force: false });
    const nextRanges = subtractRanges(detail?.ranges || [], manualSliceSelectionRanges.value);
    if (!nextRanges.length) {
      await deleteProjectSlice(projectId.value, selectedSliceId.value);
      await refreshProjectSlices({ preserveSelection: false });
    } else {
      const updated = await updateProjectSlice(projectId.value, selectedSliceId.value, {
        ranges: nextRanges,
        generated_by: 'manual_selection'
      });
      selectedSliceDetail.value = updated;
      await refreshProjectSlices({ preserveSelection: true });
    }
    editorStore.clearSelection();
  } catch (sliceError) {
    window.alert(sliceError.response?.data?.error || sliceError.message || '从当前切片移出失败');
  } finally {
    mutatingSlice.value = false;
  }
}

async function removeSelectedSlice() {
  if (!selectedSliceId.value || deletingSliceId.value) return;
  const deletingId = selectedSliceId.value;
  deletingSliceId.value = deletingId;
  try {
    await deleteProjectSlice(projectId.value, deletingId);
    await refreshProjectSlices({ preserveSelection: false });
  } catch (sliceError) {
    window.alert(sliceError.response?.data?.error || sliceError.message || '删除切片失败');
  } finally {
    deletingSliceId.value = '';
  }
}

function handleSliceChipSelect(sliceId) {
  selectSlice(sliceId).catch(() => {});
}

async function loadWorkspace() {
  isLoading.value = true;
  error.value = '';
  try {
    const [projectData, rawTimeline, rawEditState, snapshotData] = await Promise.all([
      getProject(projectId.value),
      getProjectTimeline(projectId.value),
      getProjectEditState(projectId.value),
      listProjectSnapshots(projectId.value)
    ]);

    let timelineData = rawTimeline;
    let editStateData = rawEditState;
    if (!(rawTimeline?.clips || []).length && (projectData?.projectAssets || []).length) {
      const bootstrap = await bootstrapTimelineIfEmpty(projectData, rawTimeline);
      timelineData = bootstrap.timeline;
      editStateData = bootstrap.edit_state || bootstrap.editState;
    }
    project.value = projectData;
    timeline.value = timelineData;
    projectEditState.value = editStateData;
    snapshots.value = snapshotData;

    await ensureProjectAssetWordsLoaded(projectData.projectAssets.map((relation) => relation.asset.id), { force: true });

    if (!selectedAssetId.value && orderedProjectAssets.value.length) {
      selectedAssetId.value = clipTimelineRanges.value[0]?.asset_id || orderedProjectAssets.value[0].id;
    }
    await refreshProjectSlices({ preserveSelection: true, skipFetch: true });
    syncEditorWithProjectTimeline();
    await nextTick();
    syncPreviewToCurrentTime({ preservePlayback: false });
    await loadProjectAssetJobs();
  } catch (err) {
    error.value = err.response?.data?.error || err.message || '加载失败';
  } finally {
    isLoading.value = false;
  }
}

async function loadProjectAssetJobs() {
  if (!projectId.value) {
    assetJobs.value = [];
    return;
  }
  try {
    assetJobs.value = await listProjectJobs(projectId.value);
  } catch {
    assetJobs.value = [];
  }
}

async function refreshProcessingAssets() {
  if (!projectId.value) return;
  const previousStatuses = Object.fromEntries(orderedProjectAssets.value.map((asset) => [asset.id, asset.asr_status]));
  const previousProcessing = new Set(processingAssetIds.value);
  try {
    const [projectData, jobs] = await Promise.all([
      getProject(projectId.value),
      listProjectJobs(projectId.value)
    ]);
    project.value = projectData;
    assetJobs.value = jobs;
    const nextProcessing = new Set(
      (projectData?.projectAssets || [])
        .map((relation) => relation.asset)
        .filter((asset) => ['processing', 'pending', 'provided'].includes(String(asset?.asr_status || '').trim()))
        .map((asset) => asset.id)
    );
    const completedAssetIds = (projectData?.projectAssets || [])
      .map((relation) => relation.asset)
      .filter((asset) => previousProcessing.has(asset.id) && String(previousStatuses[asset.id] || '') !== 'completed' && String(asset?.asr_status || '') === 'completed')
      .map((asset) => asset.id);

    if (completedAssetIds.length) {
      await ensureProjectAssetWordsLoaded(completedAssetIds, { force: true });
      syncEditorWithProjectTimeline();
      await nextTick();
      syncPreviewToCurrentTime();
    }

    if (!nextProcessing.size && assetJobPollTimer.value) {
      clearInterval(assetJobPollTimer.value);
      assetJobPollTimer.value = null;
    }
  } catch {
    // keep the current UI state if background refresh fails
  }
}

async function ensureAgentSessionLoaded() {
  const sessions = await listProjectAgentSessions(projectId.value);
  const session = sessions[0] || await createProjectAgentSession(projectId.value, {});
  const detail = await getProjectAgentSession(projectId.value, session.id);
  agentSession.value = detail;
  messages.value = detail.messages || [];
  const latestRun = (detail.runs || [])[0] || null;
  liveRunEvents.value = ['running', 'waiting_confirmation', 'cancelling'].includes(String(latestRun?.status || ''))
    ? (detail.events || []).filter((event) => event.run_id === latestRun.id)
    : [];
  activeRunId.value = latestRun?.id || '';
  activeRunStatus.value = latestRun?.status || '';
  if (!['running', 'waiting_confirmation', 'cancelling'].includes(String(latestRun?.status || ''))) {
    cancelRequestedRunId.value = '';
  }
  const preferredRunId = selectedRunId.value || latestRun?.id || '';
  selectedRunId.value = preferredRunId;
  selectedRunEvents.value = preferredRunId
    ? (detail.events || []).filter((event) => event.run_id === preferredRunId)
    : [];
}

async function inspectRun(runId) {
  if (!runId) return;
  agentPanelTab.value = 'status';
  selectedRunId.value = runId;
  loadingRunEvents.value = true;
  try {
    selectedRunEvents.value = await listProjectAgentRunEvents(projectId.value, runId);
  } finally {
    loadingRunEvents.value = false;
  }
}

async function createFreshAgentSession() {
  if (runningAgent.value) return;
  const session = await createProjectAgentSession(projectId.value, {
    reuse: false,
    title: `项目会话 ${new Date().toLocaleTimeString()}`
  });
  const detail = await getProjectAgentSession(projectId.value, session.id);
  agentSession.value = detail;
  messages.value = detail.messages || [];
  liveRunEvents.value = [];
  activeRunId.value = '';
  activeRunStatus.value = '';
  cancelRequestedRunId.value = '';
  selectedRunId.value = '';
  selectedRunEvents.value = [];
  agentPanelTab.value = 'chat';
}

function triggerProjectUploadPicker() {
  if (uploadingProjectAssets.value) return;
  projectUploadInputRef.value?.click?.();
}

function resetProjectUploadDragState() {
  projectUploadDragDepth.value = 0;
}

function normalizeProjectUploadFiles(fileList) {
  return Array.from(fileList || []).filter((file) => {
    const name = String(file?.name || '').toLowerCase();
    return Boolean(file) && (
      String(file.type || '').startsWith('video/') ||
      /\.(mp4|mov|m4v|mkv|webm)$/i.test(name)
    );
  });
}

async function handleProjectUploadFiles(fileList) {
  const files = normalizeProjectUploadFiles(fileList);
  if (!files.length) return;

  uploadingProjectAssets.value = true;
  projectUploadProgress.value = 0;

  try {
    const formData = new FormData();
    files.forEach((file) => formData.append('videos', file));
    formData.append('language', 'Chinese');

    const result = await uploadProjectAssets(projectId.value, formData, (event) => {
      if (!event?.total) return;
      projectUploadProgress.value = Math.round((event.loaded / event.total) * 100);
    });

    await loadWorkspace();
    await loadSnapshots();

    const firstAssetId = result.assets?.[0]?.id || '';
    if (firstAssetId) {
      selectedAssetId.value = firstAssetId;
      await nextTick();
      selectAsset(firstAssetId);
    }
  } finally {
    uploadingProjectAssets.value = false;
    projectUploadProgress.value = 0;
    if (projectUploadInputRef.value) {
      projectUploadInputRef.value.value = '';
    }
    resetProjectUploadDragState();
  }
}

function handleProjectUploadSelection(event) {
  handleProjectUploadFiles(event?.target?.files || []).catch((err) => {
    window.alert(err.response?.data?.error || err.message || '上传素材失败');
  });
}

function handleProjectUploadDragEnter() {
  if (uploadingProjectAssets.value) return;
  projectUploadDragDepth.value += 1;
}

function handleProjectUploadDragOver() {
  if (uploadingProjectAssets.value) return;
  if (!projectUploadDragDepth.value) {
    projectUploadDragDepth.value = 1;
  }
}

function handleProjectUploadDragLeave() {
  if (!projectUploadDragDepth.value) return;
  projectUploadDragDepth.value = Math.max(0, projectUploadDragDepth.value - 1);
}

function handleProjectUploadDrop(event) {
  const files = event?.dataTransfer?.files || [];
  handleProjectUploadFiles(files).catch((err) => {
    window.alert(err.response?.data?.error || err.message || '上传素材失败');
  });
}

function selectAsset(assetId) {
  closeContextMenu();
  selectedAssetId.value = assetId;
  const firstClipIndex = activePreviewClips.value.findIndex((clip) => clip.asset_id === assetId);
  if (firstClipIndex !== -1) {
    const clip = activePreviewClips.value[firstClipIndex];
    seekPreviewToProjectTime(Number(clip.project_start || 0), false);
    editorStore.setCurrentTime(Number(clip.original_project_start || 0));
    return;
  }

  const clipRange = findFirstClipRangeForAsset(assetId);
  if (clipRange) {
    editorStore.setCurrentTime(Number(clipRange.timeline_start || 0));
    syncPreviewToCurrentTime({ preservePlayback: false });
  }
}

async function saveTimeline(options = {}) {
  const {
    createSnapshot = true,
    note = createSnapshot ? 'Manual edit state update' : 'Autosave edit state update'
  } = options;
  if (!timelineDirty.value) return true;
  savingTimeline.value = true;
  try {
    const result = await updateProjectEditState(projectId.value, {
      assetOrder: orderedProjectAssets.value.map((asset) => asset.id),
      deletedWordKeys: buildPersistedDeletedWordKeys(),
      deletedGapKeys: buildPersistedDeletedGapKeys(),
      textReplacements: projectEditState.value?.text_replacements || [],
      source: createSnapshot ? 'manual' : 'autosave',
      actorType: 'manual',
      operationType: createSnapshot ? 'workspace_edit_state' : 'workspace_autosave_edit_state',
      createSnapshot,
      note
    });
    projectEditState.value = result.edit_state;
    timeline.value = result.timeline;
    syncEditorWithProjectTimeline();
    if (createSnapshot) {
      await loadSnapshots();
    }
    return true;
  } finally {
    savingTimeline.value = false;
  }
}

async function reloadTimeline() {
  const [nextTimeline, nextEditState] = await Promise.all([
    getProjectTimeline(projectId.value),
    getProjectEditState(projectId.value)
  ]);
  timeline.value = nextTimeline;
  projectEditState.value = nextEditState;
  syncEditorWithProjectTimeline();
  await nextTick();
  syncPreviewToCurrentTime();
}

function handleProjectSeek(projectTime) {
  editorStore.setCurrentTime(projectTime);
  seekPreviewToProjectTime(originalProjectTimeToPreviewTime(projectTime, activePreviewClips.value), false);
}

function handlePreviewProjectTimeUpdate(projectTime) {
  editorStore.setCurrentTime(previewTimeToOriginalProjectTime(projectTime, activePreviewClips.value));
}

function handlePreviewClipChange(clip) {
  activePreviewClip.value = clip || null;
  if (clip?.asset_id) {
    selectedAssetId.value = clip.asset_id;
  }
}

function handlePreviewPlayingChange(playing) {
  previewPlaying.value = Boolean(playing);
}

function handleGlobalWorkspaceKeydown(event) {
  if (event.defaultPrevented || event.repeat || event.isComposing) return;
  if (event.code !== 'Space' && event.key !== ' ') return;

  const target = event.target;
  const tagName = String(target?.tagName || '').toLowerCase();
  const isEditable = Boolean(
    target?.isContentEditable ||
    tagName === 'input' ||
    tagName === 'textarea' ||
    tagName === 'select'
  );
  if (isEditable) return;

  event.preventDefault();
  previewPlayerRef.value?.togglePlayback?.();
}

async function runAgent() {
  if (runningAgent.value || stoppingAgent.value) return;
  runningAgent.value = true;
  stoppingAgent.value = false;
  cancelRequestedRunId.value = '';
  agentRunAbortController.value = new AbortController();
  if (autosaveTimer.value) {
    clearTimeout(autosaveTimer.value);
    autosaveTimer.value = null;
  }
  if (timelineDirty.value) {
    await saveTimeline({
      createSnapshot: false,
      note: 'Pre-agent sync'
    });
  }
  await ensureAgentSessionLoaded();
  const userMessage = agentPrompt.value.trim() || `执行 ${agentActionLabel.value}`;
  liveRunEvents.value = [];
  activeRunId.value = '';
  activeRunStatus.value = '准备执行';
  selectedRunEvents.value = [];

  try {
    const result = await runProjectAgentWithProgress(projectId.value, agentSession.value.id, {
      mode: agentMode.value,
      prompt: userMessage,
      topic: topic.value.trim(),
      target_minutes: Number(targetMinutes.value || 1.5)
    }, (event) => {
      if (event?.run_id) {
        activeRunId.value = event.run_id;
        selectedRunId.value = event.run_id;
      }
      if (event?.type === 'stage' || event?.type === 'start') {
        activeRunStatus.value = event.message || event.step || '执行中';
      }
      if (event?.type === 'tool_call') {
        activeRunStatus.value = `执行 ${event.payload?.tool || '工具'}...`;
      }
      if (event?.type === 'tool_result') {
        activeRunStatus.value = event.message || '工具执行完成';
      }
      if (event?.type === 'review_start') {
        activeRunStatus.value = '正在审查结果...';
      }
      if (event?.type === 'review_fixed') {
        activeRunStatus.value = '审查已自动修正';
      }
      if (event?.type === 'review_passed') {
        activeRunStatus.value = '审查通过';
      }
      if (event?.type === 'complete') {
        activeRunStatus.value = '已完成';
      }
      if (event?.type === 'cancelled') {
        activeRunStatus.value = '已停止';
        runningAgent.value = false;
        stoppingAgent.value = false;
      }
      if (event?.type === 'waiting_confirmation') {
        activeRunStatus.value = '等待确认';
      }
      if (event?.type === 'error') {
        activeRunStatus.value = '执行失败';
      }
      if (event?.type && event.type !== 'result') {
        liveRunEvents.value.push({
          id: `${event.type}_${event.created_at || Date.now()}_${liveRunEvents.value.length}`,
          type: event.type,
          step: event.step || '',
          message: event.message || '',
          payload: event.payload || {},
          created_at: event.created_at || new Date().toISOString()
        });
      }
    }, agentRunAbortController.value.signal);
    agentPrompt.value = '';
    await Promise.all([loadWorkspace(), loadSnapshots(), ensureAgentSessionLoaded()]);
  } catch (err) {
    const message = err.response?.data?.error || err.message || '';
    if (String(message).toLowerCase().includes('abort') || String(message).toLowerCase().includes('cancel')) {
      Promise.resolve().then(() => ensureAgentSessionLoaded()).catch(() => {});
    } else {
      await Promise.resolve().then(() => ensureAgentSessionLoaded()).catch(() => {});
      messages.value.push({
        id: `e_${Date.now()}`,
        role: 'assistant',
        content: `执行失败：${message}`
      });
    }
  } finally {
    runningAgent.value = false;
    stoppingAgent.value = false;
    agentRunAbortController.value = null;
  }
}

async function cancelRunningAgent() {
  if (stoppingAgent.value) return;
  stoppingAgent.value = true;
  activeRunStatus.value = '正在停止...';
  try {
    if (agentRunAbortController.value) {
      agentRunAbortController.value.abort();
    }
    runningAgent.value = false;

    let runIdToCancel = activeRunId.value;
    if (!runIdToCancel) {
      await ensureAgentSessionLoaded();
      runIdToCancel = activeRunId.value;
    }

    if (!runIdToCancel || cancelRequestedRunId.value === runIdToCancel) {
      await ensureAgentSessionLoaded();
      return;
    }

    cancelRequestedRunId.value = runIdToCancel;
    await cancelProjectAgentRun(projectId.value, runIdToCancel);
    await ensureAgentSessionLoaded();
    activeRunStatus.value = ['running', 'waiting_confirmation', 'cancelling'].includes(String(activeRunStatus.value || ''))
      ? '正在停止...'
      : '已停止';
  } catch (err) {
    const message = err.response?.data?.error || err.message || '';
    if (!String(message).toLowerCase().includes('not active')) {
      messages.value.push({
        id: `cancel_err_${Date.now()}`,
        role: 'assistant',
        content: `停止执行失败：${message}`
      });
    }
    await ensureAgentSessionLoaded();
  } finally {
    stoppingAgent.value = false;
    agentRunAbortController.value = null;
  }
}

async function handleAgentConfirmation(approved) {
  if (!pendingConfirmationRun.value) return;
  runningAgent.value = true;
  try {
    await confirmProjectAgentRun(projectId.value, pendingConfirmationRun.value.id, approved);
    await Promise.all([loadWorkspace(), loadSnapshots(), ensureAgentSessionLoaded()]);
    activeRunStatus.value = approved ? '已完成' : '已取消';
  } catch (err) {
    messages.value.push({
      id: `confirm_err_${Date.now()}`,
      role: 'assistant',
      content: `确认执行失败：${err.response?.data?.error || err.message}`
    });
  } finally {
    runningAgent.value = false;
  }
}

async function handleExportVideo() {
  exportingVideo.value = true;
  try {
    if (timelineDirty.value) {
      await saveTimeline();
    }
    if (isLiveSlicingMode.value && !activeExportTimelineId.value) {
      throw new Error('请先选择一个切片再导出视频');
    }
    const result = await exportProjectVideo(projectId.value, {
      timelineId: activeExportTimelineId.value || undefined
    });
    window.open(result.download_url, '_blank', 'noopener');
  } catch (exportError) {
    window.alert(exportError.response?.data?.error || exportError.message || '导出视频失败');
  } finally {
    exportingVideo.value = false;
  }
}

async function handleExportPackage() {
  exportingPackage.value = true;
  try {
    if (timelineDirty.value) {
      await saveTimeline();
    }
    if (isLiveSlicingMode.value && !activeExportTimelineId.value) {
      throw new Error('请先选择一个切片再导出工程包');
    }
    const result = await exportProjectPackage(projectId.value, {
      timelineId: activeExportTimelineId.value || undefined
    });
    window.open(result.download_url, '_blank', 'noopener');
    await loadSnapshots();
  } catch (exportError) {
    window.alert(exportError.response?.data?.error || exportError.message || '导出工程包失败');
  } finally {
    exportingPackage.value = false;
  }
}

async function handleExportInterchange(format) {
  exportingInterchangeFormat.value = format;
  try {
    if (timelineDirty.value) {
      await saveTimeline();
    }
    if (isLiveSlicingMode.value && !activeExportTimelineId.value) {
      throw new Error('请先选择一个切片再导出交换文件');
    }
    const result = await exportProjectInterchange(projectId.value, format, {
      timelineId: activeExportTimelineId.value || undefined
    });
    window.open(result.download_url, '_blank', 'noopener');
  } catch (exportError) {
    window.alert(exportError.response?.data?.error || exportError.message || '导出交换文件失败');
  } finally {
    exportingInterchangeFormat.value = '';
  }
}

async function handleExportSliceXmlBundle() {
  exportingSliceXmlBundle.value = true;
  try {
    if (timelineDirty.value) {
      await saveTimeline();
    }
    if (!projectSlices.value.length) {
      throw new Error('当前还没有可导出的切片');
    }
    const result = await exportProjectSliceXmlBundle(projectId.value);
    window.open(result.download_url, '_blank', 'noopener');
  } catch (exportError) {
    window.alert(exportError.response?.data?.error || exportError.message || '导出切片 XML 包失败');
  } finally {
    exportingSliceXmlBundle.value = false;
  }
}

function toggleExportMenu() {
  exportMenuOpen.value = !exportMenuOpen.value;
}

function closeExportMenu() {
  exportMenuOpen.value = false;
}

async function handleExportMenuVideo() {
  closeExportMenu();
  await handleExportVideo();
}

async function handleExportMenuPackage() {
  closeExportMenu();
  await handleExportPackage();
}

async function handleExportMenuInterchange(format) {
  closeExportMenu();
  await handleExportInterchange(format);
}

async function handleExportMenuSliceXmlBundle() {
  closeExportMenu();
  await handleExportSliceXmlBundle();
}

function triggerProjectPackageImport() {
  if (importingProjectPackage.value) return;
  projectPackageImportInputRef.value?.click();
}

async function handleProjectPackageImportSelection(event) {
  const file = event.target?.files?.[0] || null;
  if (!file) return;

  const formData = new FormData();
  formData.append('file', file);
  importingProjectPackage.value = true;
  projectPackageImportProgress.value = 0;

  try {
    const importedProject = await importProjectPackage(formData, (progressEvent) => {
      const total = Number(progressEvent?.total || 0);
      const loaded = Number(progressEvent?.loaded || 0);
      if (!total) return;
      projectPackageImportProgress.value = Math.max(0, Math.min(100, Math.round((loaded / total) * 100)));
    });
    await router.push(`/projects/${importedProject.id}/edit`);
  } finally {
    importingProjectPackage.value = false;
    projectPackageImportProgress.value = 0;
    if (event?.target) {
      event.target.value = '';
    }
  }
}

async function loadSnapshots() {
  snapshots.value = await listProjectSnapshots(projectId.value);
}

async function saveSnapshot() {
  savingSnapshot.value = true;
  try {
    await createProjectSnapshot(projectId.value, {
      source: 'manual',
      note: 'Manual snapshot from project workspace'
    });
    await loadSnapshots();
  } finally {
    savingSnapshot.value = false;
  }
}

function openGlobalContextMenu(event) {
  closeExportMenu();
  contextMenu.value = {
    visible: true,
    x: event.clientX,
    y: event.clientY,
    scope: 'global',
    assetId: ''
  };
}

function openAssetContextMenu(event, assetId) {
  closeExportMenu();
  contextMenu.value = {
    visible: true,
    x: event.clientX,
    y: event.clientY,
    scope: 'asset',
    assetId
  };
}

function closeContextMenu() {
  contextMenu.value.visible = false;
  closeExportMenu();
}

function handleAssetDragStart(assetId) {
  draggedAssetId.value = assetId;
}

function handleAssetDragOver(_assetId) {
  if (!draggedAssetId.value) return;
  dragOverAssetId.value = _assetId;
}

function handleAssetDragEnd() {
  draggedAssetId.value = '';
  dragOverAssetId.value = '';
}

async function reorderAssets(assetIds) {
  closeContextMenu();
  project.value = await reorderProjectAssets(projectId.value, assetIds);
  const [nextTimeline, nextEditState] = await Promise.all([
    getProjectTimeline(projectId.value),
    getProjectEditState(projectId.value)
  ]);
  timeline.value = nextTimeline;
  projectEditState.value = nextEditState;
  await ensureProjectAssetWordsLoaded(project.value.projectAssets.map((relation) => relation.asset.id));
  if (!orderedProjectAssets.value.find((asset) => asset.id === selectedAssetId.value)) {
    selectedAssetId.value = orderedProjectAssets.value[0]?.id || '';
  }
  syncEditorWithProjectTimeline();
  await nextTick();
  syncPreviewToCurrentTime();
}

async function handleAssetDrop(targetAssetId) {
  if (!draggedAssetId.value || draggedAssetId.value === targetAssetId) {
    draggedAssetId.value = '';
    dragOverAssetId.value = '';
    return;
  }

  const assetIds = orderedProjectAssets.value.map((asset) => asset.id);
  const fromIndex = assetIds.indexOf(draggedAssetId.value);
  const toIndex = assetIds.indexOf(targetAssetId);
  if (fromIndex === -1 || toIndex === -1) {
    draggedAssetId.value = '';
    dragOverAssetId.value = '';
    return;
  }

  const [moved] = assetIds.splice(fromIndex, 1);
  assetIds.splice(toIndex, 0, moved);
  draggedAssetId.value = '';
  dragOverAssetId.value = '';
  await reorderAssets(assetIds);
}

async function moveAssetByStep(assetId, step) {
  const assetIds = orderedProjectAssets.value.map((asset) => asset.id);
  const fromIndex = assetIds.indexOf(assetId);
  if (fromIndex === -1) return;
  const toIndex = clamp(fromIndex + step, 0, assetIds.length - 1);
  if (fromIndex === toIndex) return;
  const [moved] = assetIds.splice(fromIndex, 1);
  assetIds.splice(toIndex, 0, moved);
  await reorderAssets(assetIds);
}

async function moveAssetToEdge(assetId, edge) {
  const assetIds = orderedProjectAssets.value.map((asset) => asset.id).filter((id) => id !== assetId);
  if (edge === 'start') assetIds.unshift(assetId);
  else assetIds.push(assetId);
  await reorderAssets(assetIds);
}

function previewAssetFromContext() {
  const assetId = contextMenu.value.assetId;
  closeContextMenu();
  if (assetId) {
    selectAsset(assetId);
  }
}

async function removeAssetFromProjectAction(assetId) {
  closeContextMenu();
  if (!assetId) return;
  openConfirmDialog({
    title: '移除项目素材',
    message: '确定要把这个素材从当前项目里移除吗？',
    confirmText: '移除素材',
    danger: true,
    onConfirm: async () => {
      project.value = await removeProjectAsset(projectId.value, assetId);
      const [nextTimeline, nextEditState] = await Promise.all([
        getProjectTimeline(projectId.value),
        getProjectEditState(projectId.value)
      ]);
      timeline.value = nextTimeline;
      projectEditState.value = nextEditState;
      selectedAssetId.value = orderedProjectAssets.value[0]?.id || '';
      syncEditorWithProjectTimeline();
      await nextTick();
      syncPreviewToCurrentTime();
      await loadSnapshots();
    }
  });
}

async function deleteCurrentProject() {
  closeContextMenu();
  closeExportMenu();
  const projectName = String(project.value?.name || '这个项目').trim();
  openConfirmDialog({
    title: '删除项目',
    message: `确定要删除项目《${projectName}》吗？\n此操作不可恢复。`,
    confirmText: '删除项目',
    danger: true,
    onConfirm: async () => {
      deletingProject.value = true;
      try {
        await deleteProjectRequest(projectId.value);
        await router.push('/projects');
      } catch (deleteError) {
        error.value = deleteError?.message || '删除项目失败，请重试。';
      } finally {
        deletingProject.value = false;
      }
    }
  });
}

function openConfirmDialog(options = {}) {
  confirmDialogAction = typeof options.onConfirm === 'function' ? options.onConfirm : null;
  confirmDialog.value = {
    visible: true,
    title: options.title || '请确认',
    message: options.message || '确定继续吗？',
    confirmText: options.confirmText || '确认',
    cancelText: options.cancelText || '取消',
    danger: Boolean(options.danger)
  };
}

function closeConfirmDialog() {
  confirmDialog.value.visible = false;
  confirmDialogAction = null;
}

async function handleConfirmDialogConfirm() {
  const action = confirmDialogAction;
  closeConfirmDialog();
  if (action) {
    await action();
  }
}

function getLayoutStorageKey() {
  return `autoedit:project-workspace-layout:${projectId.value}`;
}

function loadStoredPanelSizes() {
  try {
    const raw = window.localStorage.getItem(getLayoutStorageKey());
    if (!raw) return;
    const parsed = JSON.parse(raw);
    panelSizes.value = {
      sidebarWidth: Number(parsed.sidebarWidth) || 230,
      agentWidth: Number(parsed.agentWidth) || 420,
      previewHeight: Number(parsed.previewHeight) || 180
    };
    sidebarCollapsed.value = Boolean(parsed.sidebarCollapsed);
    agentCollapsed.value = Boolean(parsed.agentCollapsed);
  } catch {
    // ignore invalid local state
  }
}

function persistPanelSizes() {
  try {
    window.localStorage.setItem(getLayoutStorageKey(), JSON.stringify({
      ...panelSizes.value,
      sidebarCollapsed: sidebarCollapsed.value,
      agentCollapsed: agentCollapsed.value
    }));
  } catch {
    // ignore persistence errors
  }
}

function startResize(kind, event) {
  event.preventDefault();
  if (kind === 'sidebar' && sidebarCollapsed.value) {
    sidebarCollapsed.value = false;
  }
  if (kind === 'agent' && agentCollapsed.value) {
    agentCollapsed.value = false;
  }
  const startX = event.clientX;
  const startY = event.clientY;
  const startSizes = { ...panelSizes.value };

  const handleMove = (moveEvent) => {
    const deltaX = moveEvent.clientX - startX;
    const deltaY = moveEvent.clientY - startY;

    if (kind === 'sidebar') {
      panelSizes.value.sidebarWidth = clamp(startSizes.sidebarWidth + deltaX, 180, 360);
    } else if (kind === 'agent') {
      panelSizes.value.agentWidth = clamp(startSizes.agentWidth - deltaX, 320, 620);
    } else if (kind === 'preview') {
      panelSizes.value.previewHeight = clamp(startSizes.previewHeight + deltaY, 110, 320);
    }
  };

  const handleUp = () => {
    document.removeEventListener('mousemove', handleMove);
    document.removeEventListener('mouseup', handleUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    persistPanelSizes();
  };

  document.body.style.cursor = kind === 'preview' ? 'row-resize' : 'col-resize';
  document.body.style.userSelect = 'none';
  document.addEventListener('mousemove', handleMove);
  document.addEventListener('mouseup', handleUp);
}

function toggleSidebarCollapsed() {
  sidebarCollapsed.value = !sidebarCollapsed.value;
  persistPanelSizes();
}

function toggleAgentCollapsed() {
  agentCollapsed.value = !agentCollapsed.value;
  persistPanelSizes();
}

watch(projectId, async () => {
  loadStoredPanelSizes();
  await loadWorkspace();
  await ensureAgentSessionLoaded();
});

watch(panelSizes, () => {
  persistPanelSizes();
}, { deep: true });

watch([sidebarCollapsed, agentCollapsed], () => {
  persistPanelSizes();
});

watch(
  () => captureEditorSignature(),
  () => {
    if (!project.value || runningAgent.value || savingTimeline.value) return;
    if (autosaveTimer.value) {
      clearTimeout(autosaveTimer.value);
      autosaveTimer.value = null;
    }
    if (!timelineDirty.value) return;
    autosaveTimer.value = setTimeout(() => {
      saveTimeline({
        createSnapshot: false,
        note: 'Autosave edit state update'
      }).catch(() => {
        // keep dirty state if autosave fails
      }).finally(() => {
        autosaveTimer.value = null;
      });
    }, 900);
  }
);

watch(selectedAssetId, (assetId) => {
  if (!assetId) return;
});

watch(processingAssetIds, (assetIds) => {
  if (assetJobPollTimer.value) {
    clearInterval(assetJobPollTimer.value);
    assetJobPollTimer.value = null;
  }

  if (!assetIds.length) {
    return;
  }

  refreshProcessingAssets().catch(() => {});
  assetJobPollTimer.value = setInterval(() => {
    refreshProcessingAssets().catch(() => {});
  }, 1800);
}, { immediate: true });

watch(activePreviewClips, (clips) => {
  if (!clips.length) {
    activePreviewClip.value = null;
    return;
  }
  nextTick(() => {
    syncPreviewToCurrentTime();
  });
}, { deep: true });

watch(workspaceMode, async (mode) => {
  if (mode === 'live_slicing' && !selectedSliceId.value && projectSlices.value.length) {
    await selectSlice(projectSlices.value[0].id, { jumpToSliceStart: false });
    return;
  }
  await nextTick();
  syncPreviewToCurrentTime({ preservePlayback: false });
});

watch(projectSlices, (slices) => {
  if (!slices.length && selectedSliceId.value) {
    selectedSliceId.value = '';
    selectedSliceDetail.value = null;
    return;
  }
  if (selectedSliceId.value && slices.some((slice) => slice.id === selectedSliceId.value)) {
    return;
  }
  if (isLiveSlicingMode.value && slices.length) {
    selectSlice(slices[0].id, { jumpToSliceStart: false }).catch(() => {});
  }
}, { deep: true });

onMounted(async () => {
  loadStoredPanelSizes();
  await loadWorkspace();
  await ensureAgentSessionLoaded();
  document.addEventListener('click', closeContextMenu);
  document.addEventListener('keydown', handleGlobalWorkspaceKeydown);
});

onBeforeUnmount(() => {
  if (autosaveTimer.value) {
    clearTimeout(autosaveTimer.value);
    autosaveTimer.value = null;
  }
  if (assetJobPollTimer.value) {
    clearInterval(assetJobPollTimer.value);
    assetJobPollTimer.value = null;
  }
  previewPlayerRef.value?.pausePlayback?.();
  document.removeEventListener('click', closeContextMenu);
  document.removeEventListener('keydown', handleGlobalWorkspaceKeydown);
  editorStore.reset();
});
</script>

<style scoped>
.project-workspace-page {
  position: fixed;
  inset: 0;
  overflow: hidden;
  background:
    radial-gradient(circle at top left, rgba(31, 183, 255, 0.08), transparent 26%),
    linear-gradient(180deg, #060a0f 0%, #091018 100%);
  color: #eef5fb;
}

.state-shell {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #8ca4b5;
}

.state-shell.error {
  color: #ff9898;
}

.workspace-shell {
  height: 100%;
  display: grid;
  grid-template-rows: 52px minmax(0, 1fr);
  overflow: hidden;
}

.workspace-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 14px;
  border-bottom: 1px solid #192531;
  background: rgba(8, 13, 20, 0.94);
}

.topbar-left,
.topbar-right {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.brand-link {
  text-decoration: none;
  color: #88ecff;
  font-family: 'Space Mono', ui-monospace, monospace;
  font-size: 13px;
  letter-spacing: 0.12em;
}

.workspace-nav {
  display: flex;
  gap: 4px;
}

.workspace-nav a {
  text-decoration: none;
  color: #8fa4b4;
  padding: 5px 8px;
  font-size: 12px;
  border: 1px solid transparent;
}

.workspace-nav a.router-link-active {
  color: #eff7ff;
  border-color: #243443;
  background: #0b141d;
}

.project-identity {
  min-width: 0;
  display: grid;
}

.project-identity strong {
  font-size: 13px;
}

.project-identity span {
  color: #7f95a7;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 360px;
}

.stat-chip {
  border: 1px solid #223141;
  background: #0a1118;
  color: #b8ccdb;
  padding: 5px 7px;
  font-size: 11px;
}

.stat-chip.warning {
  color: #ffcf7a;
  border-color: #5f4b1f;
}

.ghost-btn,
.primary-btn,
.text-link {
  border: 1px solid #243443;
  background: #0c141c;
  color: #edf5fb;
  padding: 7px 10px;
  font-size: 11px;
  cursor: pointer;
}

.primary-btn {
  background: #16c5ff;
  border-color: #16c5ff;
  color: #071018;
  font-weight: 700;
}

.ghost-btn:disabled,
.primary-btn:disabled,
.context-item:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.danger-ghost-btn {
  color: #ff9aa4;
  border-color: #5b2831;
  background: #1a0d12;
}

.danger-ghost-btn:hover:not(:disabled) {
  color: #ffe6ea;
  border-color: #8d3947;
  background: #271117;
}

.export-menu-shell {
  position: relative;
}

.export-trigger {
  min-width: 78px;
}

.export-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 35;
  min-width: 168px;
  border: 1px solid #20303f;
  background: #091019;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}

.text-link {
  border-color: transparent;
  background: transparent;
  color: #8fe7ff;
  padding: 0;
}

.workspace-body {
  min-height: 0;
  display: grid;
  grid-template-columns: var(--sidebar-width) 5px minmax(0, 1fr) 5px var(--agent-width);
  padding: 6px;
  gap: 0;
  overflow: hidden;
}

.sidebar,
.editor-panel,
.agent-panel {
  min-height: 0;
  overflow: hidden;
  background: rgba(10, 16, 24, 0.96);
  border: 1px solid #182532;
}

.sidebar {
  display: flex;
  flex-direction: column;
}

.sidebar.collapsed,
.agent-panel.collapsed {
  align-items: stretch;
  justify-content: stretch;
}

.sidebar-tabs-shell {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 6px;
  padding: 6px;
  border-bottom: 1px solid #15212d;
}

.sidebar-tabs {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 4px;
}

.sidebar-tab {
  border: 1px solid #20303f;
  background: #0b131b;
  color: #9ab0c1;
  font-size: 11px;
  padding: 6px 0;
  cursor: pointer;
}

.sidebar-tab.active {
  color: #f6fbff;
  border-color: #16c5ff;
  background: rgba(22, 197, 255, 0.12);
}

.panel-visibility-btn {
  border: 1px solid #243443;
  background: #0b1218;
  color: #8fe7ff;
  padding: 0 8px;
  font-size: 11px;
  cursor: pointer;
}

.panel-visibility-btn.icon {
  width: 26px;
  padding: 0;
  font-family: 'Space Mono', ui-monospace, monospace;
}

.panel-reveal-btn {
  width: 100%;
  height: 100%;
  border: none;
  background: #091019;
  color: #8fe7ff;
  font-size: 11px;
  letter-spacing: 0.14em;
  writing-mode: vertical-rl;
  text-orientation: mixed;
  cursor: pointer;
}

.panel-reveal-btn-right {
  writing-mode: vertical-lr;
}

.sidebar-panel {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  overflow: hidden;
}

.sidebar-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: #edf5fb;
  font-size: 12px;
}

.project-upload-zone {
  position: relative;
  border: 1px dashed #28516a;
  background: rgba(12, 21, 30, 0.94);
  padding: 10px;
  display: grid;
  gap: 4px;
  cursor: pointer;
  transition: border-color 0.18s ease, background 0.18s ease, transform 0.18s ease;
}

.project-upload-zone strong {
  font-size: 12px;
  color: #ecf6fb;
}

.project-upload-zone span {
  font-size: 10px;
  line-height: 1.5;
  color: #8aa0b1;
}

.project-upload-zone.active {
  border-color: #16c5ff;
  background: rgba(22, 197, 255, 0.1);
  transform: translateY(-1px);
}

.project-upload-zone.busy {
  cursor: progress;
}

.project-upload-input {
  display: none;
}

.asset-list,
.list-stack {
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow: auto;
}

.asset-row {
  width: 100%;
  border: 1px solid #1d2c39;
  background: #0b1219;
  color: #edf5fb;
  display: grid;
  grid-template-columns: 12px 18px 6px minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px;
  padding: 5px 6px;
  cursor: grab;
  text-align: left;
}

.asset-row:active {
  cursor: grabbing;
}

.asset-row.active {
  background: var(--asset-soft);
  border-color: var(--asset-border);
}

.asset-row.dragging {
  opacity: 0.5;
}

.asset-row.drop-target {
  border-color: var(--asset-border);
  box-shadow: inset 0 1px 0 var(--asset-border), inset 0 -1px 0 var(--asset-border);
}

.asset-drag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #667b8d;
  font-size: 10px;
  letter-spacing: -0.2em;
}

.asset-order {
  text-align: center;
  font-size: 10px;
  color: #8ca4b5;
}

.asset-swatch {
  width: 6px;
  height: 22px;
  background: var(--asset-color);
}

.asset-copy {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.asset-copy strong {
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.asset-copy small {
  font-size: 10px;
  color: #8aa0b1;
}

.asset-progress {
  display: grid;
  gap: 3px;
  margin-top: 2px;
}

.asset-progress-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 9px;
  color: #93bfd1;
  letter-spacing: 0.04em;
}

.asset-progress-head strong {
  font-size: 9px;
  color: #dff7ff;
}

.asset-progress-track {
  position: relative;
  width: 100%;
  height: 5px;
  background: rgba(39, 59, 76, 0.9);
  overflow: hidden;
}

.asset-progress-fill {
  position: absolute;
  inset: 0 auto 0 0;
  background: linear-gradient(90deg, #16c5ff 0%, #73d8ff 100%);
}

.asset-progress-note {
  display: block;
  font-size: 9px;
  line-height: 1.35;
  color: #6f8697;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.asset-state {
  font-size: 10px;
  color: #8fe7ff;
}

.asset-state.processing {
  color: #73d8ff;
}

.asset-state.failed {
  color: #ff8b8b;
}

.asset-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.asset-retry-btn {
  border: 1px solid #33516a;
  background: #0b1824;
  color: #8fe7ff;
  min-height: 20px;
  padding: 0 6px;
  font-size: 10px;
  line-height: 1.6;
  cursor: pointer;
}

.asset-retry-btn:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.asset-retry-btn:hover:not(:disabled) {
  border-color: #59d3ff;
  background: rgba(29, 183, 255, 0.14);
}

.asset-remove-btn {
  border: 1px solid #273747;
  background: #091019;
  color: #ffb0b0;
  width: 20px;
  height: 20px;
  padding: 0;
  font-size: 14px;
  line-height: 1;
  opacity: 0.72;
  cursor: pointer;
}

.asset-remove-btn:hover {
  border-color: #b94949;
  background: rgba(255, 93, 115, 0.12);
  opacity: 1;
}

.mini-context {
  display: grid;
  gap: 4px;
  border-top: 1px solid #16222d;
  padding-top: 8px;
}

.mini-context-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
}

.mini-context-item span {
  color: #8ca4b5;
}

.mini-context-item strong {
  min-width: 0;
  text-align: right;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.list-row {
  border: 1px solid #1d2c39;
  background: #0b1219;
  padding: 8px;
}

.list-row-title {
  font-size: 12px;
  color: #edf5fb;
}

.list-row-note {
  margin-top: 4px;
  font-size: 11px;
  line-height: 1.5;
  color: #8ca4b5;
}

.list-row-meta {
  margin-top: 6px;
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: #7b91a2;
}

.editor-panel {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-rows: var(--preview-height) 8px minmax(0, 1fr);
}

.preview-slot,
.subtitle-workspace {
  min-height: 0;
  overflow: hidden;
}

.preview-card {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
}

.preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
}

.preview-head span {
  color: #86a0b1;
  font-size: 11px;
}

.preview-frame {
  min-height: 0;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid #162332;
  background: #02060b;
}

.preview-frame video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
}

.subtitle-workspace {
  display: grid;
  grid-template-rows: minmax(0, 1fr) 100px 28px;
}

.editor-status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 12px;
  border-top: 1px solid #13202c;
  background: #0b1218;
  font-size: 11px;
  color: #8197a7;
}

.status-left,
.status-right {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 12px;
}

.status-item {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.agent-panel {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.agent-mini-toolbar {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
  padding: 8px 10px 0;
  border-bottom: 1px solid #172432;
}

.message-list {
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.chat-primary-view {
  padding-top: 10px;
}

.run-status-panel {
  border: 1px solid #1c2a38;
  background: #08111a;
  padding: 10px;
}

.compact-confirmation {
  margin-bottom: 4px;
}

.run-meta-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.run-meta-item {
  border: 1px solid #152430;
  background: rgba(12, 19, 28, 0.85);
  padding: 8px;
}

.run-meta-item span {
  display: block;
  font-size: 10px;
  color: #7790a1;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.run-meta-item strong {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  color: #eff6fb;
}

.confirmation-panel {
  border-color: #3a2d14;
  background: rgba(35, 24, 8, 0.92);
}

.confirmation-copy {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: #e9dbc0;
}

.confirmation-actions {
  margin-top: 10px;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.run-status-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 11px;
  color: #8fe7ff;
}

.run-event-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 240px;
  overflow: auto;
}

.trace-meta {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
  color: #7f96a7;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.run-event {
  display: grid;
  grid-template-columns: 68px minmax(0, 1fr);
  gap: 8px;
  padding: 7px 0;
  border-top: 1px solid #13202c;
}

.run-event:first-child {
  border-top: none;
  padding-top: 0;
}

.run-event-type {
  color: #6fdfff;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.run-event-copy strong {
  display: block;
  font-size: 11px;
  color: #dce8f0;
}

.run-event-copy p {
  margin: 3px 0 0;
  font-size: 12px;
  line-height: 1.45;
  color: #9ab0c1;
}

.run-event-copy small {
  display: block;
  margin-top: 4px;
  color: #6edfff;
  font-size: 10px;
  line-height: 1.4;
  word-break: break-word;
}

.change-list,
.history-list {
  display: grid;
  gap: 8px;
}

.change-row,
.history-row {
  border-top: 1px solid #13202c;
  padding-top: 8px;
}

.change-row:first-child,
.history-row:first-child {
  border-top: none;
  padding-top: 0;
}

.history-row {
  width: 100%;
  border-left: 2px solid transparent;
  border-right: none;
  border-bottom: none;
  background: transparent;
  padding-left: 0;
  padding-right: 0;
  cursor: pointer;
  text-align: left;
}

.history-row.active {
  border-left-color: #16c5ff;
  background: rgba(22, 197, 255, 0.06);
}

.change-type {
  display: inline-block;
  margin-bottom: 4px;
  color: #77e6ff;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.change-row p,
.history-row p {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: #a8becd;
}

.history-row-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}

.history-row-head strong {
  font-size: 12px;
  color: #eef6fb;
}

.history-row-head span {
  font-size: 10px;
  color: #79d7ff;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.trace-loading {
  min-height: 56px;
  margin-bottom: 8px;
}

.message {
  border: 1px solid #182632;
  padding: 10px;
}

.message.user {
  background: rgba(22, 197, 255, 0.08);
  border-color: #164454;
}

.message.assistant {
  background: #0b1218;
}

.message.thinking-message {
  border-style: dashed;
  border-color: #215066;
  background: rgba(12, 24, 34, 0.82);
}

.message-role {
  margin-bottom: 6px;
  font-size: 11px;
  color: #8fe7ff;
}

.thinking-inline {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 8px;
}

.thinking-inline span {
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: #6fdfff;
  animation: thinkingPulse 1.1s infinite ease-in-out;
}

.thinking-inline span:nth-child(2) {
  animation-delay: 0.15s;
}

.thinking-inline span:nth-child(3) {
  animation-delay: 0.3s;
}

.message-content {
  font-size: 13px;
  line-height: 1.6;
  color: #e9f3fb;
  white-space: pre-wrap;
}

.thinking-content strong {
  display: block;
  margin-bottom: 8px;
  font-size: 12px;
  color: #eef6fb;
}

.thinking-steps {
  display: grid;
  gap: 6px;
}

.thinking-step {
  border-left: 2px solid #1db7ff;
  padding-left: 8px;
}

.thinking-step span {
  display: block;
  font-size: 10px;
  color: #7adfff;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.thinking-step p {
  margin: 2px 0 0;
  font-size: 12px;
  color: #a7bdcc;
  line-height: 1.45;
}

.agent-controls {
  display: grid;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid #172432;
}

.control-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.control-row select,
.control-row input,
.agent-controls textarea {
  width: 100%;
  border: 1px solid #243443;
  background: #0b1218;
  color: #edf5fb;
  padding: 9px 10px;
  font-size: 12px;
}

.agent-controls textarea {
  min-height: 120px;
  resize: vertical;
}

.agent-run-btn {
  flex: 1;
}

.agent-action-row {
  display: flex;
  gap: 8px;
}

.agent-stop-btn {
  flex: 0 0 auto;
}

@keyframes thinkingPulse {
  0%, 80%, 100% {
    opacity: 0.32;
    transform: translateY(0);
  }
  40% {
    opacity: 1;
    transform: translateY(-2px);
  }
}

.pane-resizer {
  position: relative;
  z-index: 4;
  touch-action: none;
}

.pane-resizer.vertical {
  cursor: col-resize;
}

.pane-resizer.horizontal {
  cursor: row-resize;
}

.pane-resizer::before {
  content: '';
  position: absolute;
  inset: 1px 1px;
  background: rgba(126, 224, 255, 0.18);
}

.pane-resizer.horizontal::before {
  inset: 1px 1px;
}

.pane-resizer:hover::before {
  background: rgba(126, 224, 255, 0.38);
}

.pane-resizer:active::before {
  background: rgba(22, 197, 255, 0.72);
}

.context-menu {
  position: fixed;
  z-index: 30;
  min-width: 172px;
  border: 1px solid #20303f;
  background: #091019;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}

.context-item {
  width: 100%;
  text-align: left;
  border: none;
  border-bottom: 1px solid #162432;
  background: transparent;
  color: #edf5fb;
  padding: 10px 12px;
  font-size: 12px;
  cursor: pointer;
}

.context-item:last-child {
  border-bottom: none;
}

.context-item:hover {
  background: rgba(22, 197, 255, 0.12);
}

.context-item.danger {
  color: #ff9a9a;
}

.empty-block {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100px;
  padding: 12px;
  border: 1px dashed #233342;
  color: #8197a7;
  font-size: 12px;
  text-align: center;
}

:deep(.project-subtitle-panel.subtitle-editor) {
  width: 100%;
  min-width: 0;
  height: 100%;
  border-right: none;
}

:deep(.project-subtitle-panel .editor-header),
:deep(.project-subtitle-panel .editor-toolbar) {
  padding-left: 12px;
  padding-right: 12px;
}

:deep(.project-subtitle-panel .editor-container) {
  padding: 12px;
}

:deep(.project-timeline-strip.timeline-container) {
  height: 100px;
}
</style>
