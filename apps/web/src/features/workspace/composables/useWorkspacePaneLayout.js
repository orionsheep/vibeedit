import { computed, nextTick, ref } from 'vue';
import { clamp } from '../utils/rangeMath.js';

const DEFAULT_PANEL_SIZES = {
  sidebarWidth: 230,
  agentWidth: 420,
  previewHeight: 180
};

export function useWorkspacePaneLayout(projectId) {
  const sidebarCollapsed = ref(false);
  const agentCollapsed = ref(false);
  const isPaneResizing = ref(false);
  const panelSizes = ref({ ...DEFAULT_PANEL_SIZES });
  const workspaceBodyRef = ref(null);
  const sidebarRef = ref(null);

  const workspaceLayoutStyle = computed(() => ({
    '--sidebar-width': `${sidebarCollapsed.value ? 34 : panelSizes.value.sidebarWidth}px`,
    '--agent-width': `${agentCollapsed.value ? 34 : panelSizes.value.agentWidth}px`
  }));

  const sidebarStyle = computed(() => ({
    '--sidebar-preview-height': `${panelSizes.value.previewHeight}px`
  }));

  function getLayoutStorageKey() {
    return `autoedit:project-workspace-layout:${projectId.value}`;
  }

  function loadStoredPanelSizes() {
    try {
      const raw = window.localStorage.getItem(getLayoutStorageKey());
      if (!raw) return;
      const parsed = JSON.parse(raw);
      panelSizes.value = {
        sidebarWidth: Number(parsed.sidebarWidth) || DEFAULT_PANEL_SIZES.sidebarWidth,
        agentWidth: Number(parsed.agentWidth) || DEFAULT_PANEL_SIZES.agentWidth,
        previewHeight: Number(parsed.previewHeight) || DEFAULT_PANEL_SIZES.previewHeight
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

  function applyPanelSizeStyles(sizes = panelSizes.value) {
    if (workspaceBodyRef.value) {
      workspaceBodyRef.value.style.setProperty('--sidebar-width', `${sidebarCollapsed.value ? 34 : sizes.sidebarWidth}px`);
      workspaceBodyRef.value.style.setProperty('--agent-width', `${agentCollapsed.value ? 34 : sizes.agentWidth}px`);
    }

    if (sidebarRef.value) {
      sidebarRef.value.style.setProperty('--sidebar-preview-height', `${sizes.previewHeight}px`);
    }
  }

  function startResize(kind, event) {
    event.preventDefault();
    isPaneResizing.value = true;
    if (kind === 'sidebar' && sidebarCollapsed.value) {
      sidebarCollapsed.value = false;
    }
    if (kind === 'agent' && agentCollapsed.value) {
      agentCollapsed.value = false;
    }
    const startX = event.clientX;
    const startY = event.clientY;
    const startSizes = { ...panelSizes.value };
    const draftSizes = { ...startSizes };
    let resizeFrameId = null;

    const scheduleStyleApply = () => {
      if (resizeFrameId) return;
      resizeFrameId = requestAnimationFrame(() => {
        resizeFrameId = null;
        applyPanelSizeStyles(draftSizes);
      });
    };

    const handleMove = (moveEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;

      if (kind === 'sidebar') {
        draftSizes.sidebarWidth = clamp(startSizes.sidebarWidth + deltaX, 180, 360);
      } else if (kind === 'agent') {
        draftSizes.agentWidth = clamp(startSizes.agentWidth - deltaX, 320, 620);
      } else if (kind === 'preview') {
        draftSizes.previewHeight = clamp(startSizes.previewHeight + deltaY, 110, 320);
      }

      scheduleStyleApply();
    };

    const handleUp = () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (resizeFrameId) {
        cancelAnimationFrame(resizeFrameId);
        resizeFrameId = null;
      }
      panelSizes.value = { ...draftSizes };
      applyPanelSizeStyles(panelSizes.value);
      persistPanelSizes();
      isPaneResizing.value = false;
    };

    document.body.style.cursor = kind === 'preview' ? 'row-resize' : 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
  }

  function toggleSidebarCollapsed() {
    sidebarCollapsed.value = !sidebarCollapsed.value;
    applyPanelSizeStyles();
    persistPanelSizes();
  }

  function toggleAgentCollapsed() {
    agentCollapsed.value = !agentCollapsed.value;
    applyPanelSizeStyles();
    persistPanelSizes();
  }

  async function initializePaneLayout() {
    loadStoredPanelSizes();
    await nextTick();
    applyPanelSizeStyles();
  }

  return {
    agentCollapsed,
    isPaneResizing,
    panelSizes,
    persistPanelSizes,
    sidebarCollapsed,
    sidebarRef,
    sidebarStyle,
    startResize,
    toggleAgentCollapsed,
    toggleSidebarCollapsed,
    workspaceBodyRef,
    workspaceLayoutStyle,
    initializePaneLayout
  };
}
