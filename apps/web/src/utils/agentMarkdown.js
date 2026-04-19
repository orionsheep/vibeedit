import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true
});

function isPipeTableRow(line = '') {
  const trimmed = String(line || '').trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length >= 3;
}

function isPipeTableDivider(line = '') {
  const trimmed = String(line || '').trim();
  if (!isPipeTableRow(trimmed)) return false;
  const cells = trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
  if (!cells.length) return false;
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function splitPipeCells(line = '') {
  return String(line || '')
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function renderInline(text = '') {
  return markdown.renderInline(String(text || '').trim());
}

function renderPipeTable(lines = []) {
  if (lines.length < 2) return '';
  const headerCells = splitPipeCells(lines[0]);
  const bodyRows = lines.slice(2).map(splitPipeCells);
  const headerHtml = headerCells.map((cell) => `<th>${renderInline(cell)}</th>`).join('');
  const bodyHtml = bodyRows.map((row) => (
    `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`
  )).join('');
  return [
    '<table>',
    '<thead>',
    `<tr>${headerHtml}</tr>`,
    '</thead>',
    '<tbody>',
    bodyHtml,
    '</tbody>',
    '</table>'
  ].join('');
}

function renderMarkdownWithPipeTables(content = '') {
  const normalized = String(content || '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const parts = [];
  const proseBuffer = [];

  const flushProse = () => {
    if (!proseBuffer.length) return;
    const prose = proseBuffer.join('\n').trim();
    proseBuffer.length = 0;
    if (!prose) return;
    parts.push(markdown.render(prose));
  };

  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index];
    const next = lines[index + 1];
    const looksLikeTable = isPipeTableRow(current) && isPipeTableDivider(next);

    if (!looksLikeTable) {
      proseBuffer.push(current);
      continue;
    }

    flushProse();
    const tableLines = [current, next];
    index += 2;
    while (index < lines.length && isPipeTableRow(lines[index])) {
      tableLines.push(lines[index]);
      index += 1;
    }
    index -= 1;
    parts.push(renderPipeTable(tableLines));
  }

  flushProse();
  return parts.join('');
}

export function renderAgentMarkdown(content = '') {
  const normalized = String(content || '').replace(/\r\n?/g, '\n');
  const rendered = markdown.render(normalized);
  if (/\|.+\|/m.test(normalized) && !/<table[\s>]/i.test(rendered)) {
    return renderMarkdownWithPipeTables(normalized);
  }
  return rendered;
}

