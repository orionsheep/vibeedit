<template>
  <header class="workspace-topbar">
    <div class="topbar-left">
      <router-link class="brand-link" to="/projects">VIBEEDIT</router-link>
      <nav class="workspace-nav">
        <router-link to="/projects">项目</router-link>
        <router-link to="/library">素材库</router-link>
      </nav>
      <div class="project-identity">
        <strong>{{ projectName }}</strong>
        <span>{{ projectDescription || '多素材字幕时间线工作台' }}</span>
      </div>
    </div>

    <div class="topbar-right">
      <span v-if="timelineDirty" class="stat-chip warning">未保存</span>
      <button class="ghost-btn danger-ghost-btn" :disabled="deletingProject" @click="$emit('delete-project')">
        {{ deletingProject ? '删除中...' : '删除项目' }}
      </button>
      <button class="ghost-btn" @click="$emit('reload-timeline')">重载</button>
      <button class="ghost-btn" :disabled="!timelineDirty || savingTimeline" @click="$emit('save-timeline')">
        {{ savingTimeline ? '保存中...' : '保存时间线' }}
      </button>
      <button class="ghost-btn" :disabled="importingProjectPackage" @click="$emit('trigger-package-import')">
        {{ importingProjectPackage ? `导入中 ${projectPackageImportProgress}%` : '导入工程包' }}
      </button>
      <button class="ghost-btn" :disabled="!canOpenDocumentPreview" @click="$emit('open-document')">
        {{ documentTriggerLabel }}
      </button>
      <div class="export-menu-shell" @click.stop>
        <button class="primary-btn export-trigger" :disabled="isExportingAny" @click="$emit('toggle-export-menu')">
          {{ exportTriggerLabel }}
        </button>
        <div v-if="exportMenuOpen" class="export-menu">
          <button class="context-item" :disabled="isExportingAny" @click="$emit('export-video')">
            {{ exportingVideo ? '视频导出中...' : '导出视频' }}
          </button>
          <button class="context-item" :disabled="isExportingAny" @click="$emit('export-package')">
            {{ exportingPackage ? '工程包导出中...' : '导出工程包' }}
          </button>
          <button
            class="context-item"
            :disabled="isExportingAny"
            @click="handleXmlExport"
          >
            {{ xmlExportLabel }}
          </button>
          <button class="context-item" :disabled="isExportingAny" @click="$emit('export-interchange', 'edl')">
            {{ exportingInterchangeFormat === 'edl' ? 'EDL 导出中...' : '导出通用 EDL' }}
          </button>
          <button class="context-item" :disabled="isExportingAny" @click="$emit('export-interchange', 'capcut_srt')">
            {{ exportingInterchangeFormat === 'capcut_srt' ? 'SRT 导出中...' : '导出剪映 / CapCut SRT' }}
          </button>
        </div>
      </div>
    </div>
  </header>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  canOpenDocumentPreview: {
    type: Boolean,
    default: false
  },
  deletingProject: {
    type: Boolean,
    default: false
  },
  documentTriggerLabel: {
    type: String,
    default: '文稿'
  },
  exportMenuOpen: {
    type: Boolean,
    default: false
  },
  exportTriggerLabel: {
    type: String,
    default: '导出'
  },
  exportingInterchangeFormat: {
    type: String,
    default: ''
  },
  exportingPackage: {
    type: Boolean,
    default: false
  },
  exportingSliceXmlBundle: {
    type: Boolean,
    default: false
  },
  exportingVideo: {
    type: Boolean,
    default: false
  },
  importingProjectPackage: {
    type: Boolean,
    default: false
  },
  isExportingAny: {
    type: Boolean,
    default: false
  },
  isLiveSlicingMode: {
    type: Boolean,
    default: false
  },
  projectDescription: {
    type: String,
    default: ''
  },
  projectName: {
    type: String,
    default: ''
  },
  projectPackageImportProgress: {
    type: Number,
    default: 0
  },
  projectSlicesLength: {
    type: Number,
    default: 0
  },
  savingTimeline: {
    type: Boolean,
    default: false
  },
  timelineDirty: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits([
  'delete-project',
  'export-interchange',
  'export-package',
  'export-slice-xml-bundle',
  'export-video',
  'open-document',
  'reload-timeline',
  'save-timeline',
  'toggle-export-menu',
  'trigger-package-import'
]);

const exportingXmlBundle = computed(() => (
  props.isLiveSlicingMode &&
  props.projectSlicesLength > 1 &&
  props.exportingSliceXmlBundle
));

const xmlExportLabel = computed(() => {
  if (exportingXmlBundle.value) {
    return '切片 XML 打包中...';
  }
  if (props.exportingInterchangeFormat === 'premiere_xml') {
    return 'XML 导出中...';
  }
  if (props.isLiveSlicingMode && props.projectSlicesLength > 1) {
    return '导出全部切片 XML 包';
  }
  return '导出 Premiere / Resolve XML';
});

function handleXmlExport() {
  if (props.isLiveSlicingMode && props.projectSlicesLength > 1) {
    emit('export-slice-xml-bundle');
    return;
  }
  emit('export-interchange', 'premiere_xml');
}
</script>

<style scoped>
.workspace-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 14px;
  border-bottom: 1px solid rgba(69, 101, 128, 0.22);
  background: rgba(7, 13, 20, 0.95);
  backdrop-filter: blur(14px);
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
  color: var(--app-accent-strong);
  font-family: var(--font-mono);
  font-size: 13px;
  letter-spacing: 0.12em;
}

.workspace-nav {
  display: flex;
  gap: 4px;
}

.workspace-nav a {
  text-decoration: none;
  color: var(--app-copy-muted);
  padding: 5px 8px;
  font-size: 12px;
  border: 1px solid transparent;
}

.workspace-nav a.router-link-active {
  color: var(--app-copy);
  border-color: rgba(88, 219, 255, 0.18);
  background: rgba(11, 20, 29, 0.92);
}

.project-identity {
  min-width: 0;
  display: grid;
}

.project-identity strong {
  font-size: 13px;
}

.project-identity span {
  color: var(--app-copy-soft);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 360px;
}

.stat-chip {
  border: 1px solid rgba(88, 219, 255, 0.14);
  background: rgba(10, 17, 24, 0.86);
  color: var(--app-copy);
  padding: 5px 7px;
  font-size: 11px;
}

.stat-chip.warning {
  color: #ffcf7a;
  border-color: rgba(255, 207, 122, 0.24);
}

.ghost-btn,
.primary-btn,
.context-item {
  border: 1px solid var(--app-border-strong);
  background: rgba(10, 18, 27, 0.92);
  color: var(--app-copy);
  padding: 7px 10px;
  font-size: 11px;
  cursor: pointer;
}

.primary-btn {
  background: linear-gradient(135deg, #58dbff, #7fe9ff);
  border-color: transparent;
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
  border: 1px solid var(--app-border-strong);
  background: rgba(9, 16, 25, 0.98);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}

.context-item {
  width: 100%;
  text-align: left;
  border: none;
  border-bottom: 1px solid rgba(88, 219, 255, 0.08);
}

.context-item:last-child {
  border-bottom: none;
}
</style>
