<template>
  <teleport to="body">
    <div v-if="visible" class="confirm-overlay" @click.self="$emit('cancel')">
      <div class="confirm-dialog" :class="{ danger }" role="dialog" aria-modal="true">
        <div class="confirm-title">{{ title || '请确认' }}</div>
        <div class="confirm-message">{{ message || '确定继续吗？' }}</div>
        <div class="confirm-actions">
          <button class="confirm-btn ghost" type="button" @click="$emit('cancel')">
            {{ cancelText || '取消' }}
          </button>
          <button class="confirm-btn" :class="{ danger }" type="button" @click="$emit('confirm')">
            {{ confirmText || '确认' }}
          </button>
        </div>
      </div>
    </div>
  </teleport>
</template>

<script setup>
defineProps({
  visible: { type: Boolean, default: false },
  title: { type: String, default: '' },
  message: { type: String, default: '' },
  confirmText: { type: String, default: '确认' },
  cancelText: { type: String, default: '取消' },
  danger: { type: Boolean, default: false }
});

defineEmits(['confirm', 'cancel']);
</script>

<style scoped>
.confirm-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  background: rgba(2, 8, 14, 0.72);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.confirm-dialog {
  width: min(420px, calc(100vw - 32px));
  border: 1px solid #243443;
  background: #0b141d;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
  padding: 18px;
  display: grid;
  gap: 14px;
}

.confirm-dialog.danger {
  border-color: #5b2831;
}

.confirm-title {
  color: #edf5fb;
  font-size: 16px;
  font-weight: 700;
}

.confirm-message {
  color: #b4c8d7;
  line-height: 1.7;
  white-space: pre-wrap;
}

.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.confirm-btn {
  border: 1px solid #243443;
  background: #0f151d;
  color: #edf5fb;
  padding: 8px 14px;
  cursor: pointer;
}

.confirm-btn.ghost {
  color: #9cb1c0;
}

.confirm-btn.danger {
  border-color: #8d3947;
  background: #311019;
  color: #ffe3e8;
}
</style>
