export function roundTime(value, digits = 3) {
  return Number(Number(value || 0).toFixed(digits));
}

export function normalizeTimelineSettings(settings = {}) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return {};
  }
  return { ...settings };
}

export function readTimelineKind(timeline = null) {
  if (timeline?.isPrimary) return 'master';
  const settings = normalizeTimelineSettings(timeline?.settings);
  return String(settings.kind || 'aux').trim() || 'aux';
}
