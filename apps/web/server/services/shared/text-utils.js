import slugify from 'slugify';

export function tokenizeSegmentText(text = '') {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return [];
  if (/\s/.test(value)) {
    return value.split(/\s+/).filter(Boolean);
  }
  return Array.from(value).filter((char) => /\S/.test(char));
}

export function sanitizeFilename(value, fallback = 'autoedit-project') {
  const safe = String(value || '')
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return safe || fallback;
}

export function sanitizeAsciiFilename(value, fallback = 'autoedit-project') {
  const asciiSlug = slugify(String(value || '').trim(), {
    lower: false,
    strict: true,
    trim: true
  })
    .replace(/-+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  return asciiSlug || sanitizeFilename(fallback, 'autoedit-project');
}
