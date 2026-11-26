'use strict';

const { normalizeTimeRangeLabel } = require('../utils/date');
const {
  splitFrontmatter,
  buildLineFlags,
  endOfNonEmptyBody,
  normalizeTrailingNewline,
  tokenizeRichLine,
} = require('./markdown');
const {
  DAY_PERIOD_TITLE_RE,
  parseJournalChildLine,
  buildChildrenMeta,
} = require('./journal');

const AD_OPEN_KWS = new Set(['TODO', 'LATER', 'NOW', 'WAITING', 'WAIT', 'TODOFORAI', 'TODO4AI', 'TODO2AI', 'TODOTOAI']);
const AD_ACTIVE_KWS = new Set(['DOING', 'IN-PROGRESS', 'PAUSED', 'SUSPENDED', 'TOREVIEW', 'DELEGATED', 'NEEDOK', 'QUEUED', 'HITLIMIT', 'ERRORED']);
const AD_DONE_KWS = new Set(['DONE']);
const AD_CANCEL_KWS = new Set(['CANCELED', 'CANCELLED', 'FAILED']);
const AD_KW_PATTERN = 'TODOFORAI|TODO4AI|TODO2AI|TODOTOAI|TODO|DOING|LATER|NOW|PAUSED|TOREVIEW|HITLIMIT|NEEDOK|QUEUED|ERRORED|DELEGATED|WAITING|WAIT|SUSPENDED|IN-PROGRESS|DONE|CANCELED|CANCELLED|FAILED';
const AD_KW_LINE_RE = new RegExp(`^([-*+])\\s+(${AD_KW_PATTERN})(?=\\s|$)\\s*(.*)$`);
const AD_LEGACY_CB_RE = /^([-*+])\s+\[([ xX\/-])\]\s*(.*)$/;
const EXEC_HEADING_RE = /^\s*##\s+今日执行(?:\s+\^[A-Za-z0-9_-]+)?\s*$/;

function classifyAgentDeckKeyword(kw) {
  if (AD_ACTIVE_KWS.has(kw)) return 'doing';
  if (AD_OPEN_KWS.has(kw)) return 'todo';
  if (AD_DONE_KWS.has(kw)) return 'done';
  if (AD_CANCEL_KWS.has(kw)) return 'cancelled';
  return 'todo';
}

function parseExecutionTaskHeader(rawLine, lineNumber, filePath, dateStr, mtime) {
  const s = String(rawLine || '').trimEnd();
  let keyword = '';
  let bucket = 'todo';
  let body = '';
  let isLegacyCheckbox = false;

  const kwMatch = s.match(AD_KW_LINE_RE);
  if (kwMatch) {
    keyword = kwMatch[2];
    bucket = classifyAgentDeckKeyword(keyword);
    body = kwMatch[3] || '';
  } else {
    const cbMatch = s.match(AD_LEGACY_CB_RE);
    if (!cbMatch) return null;
    isLegacyCheckbox = true;
    const ch = cbMatch[2];
    keyword = ch === '/' ? 'DOING' : ch === 'x' || ch === 'X' ? 'DONE' : ch === '-' ? 'CANCELED' : 'TODO';
    bucket = classifyAgentDeckKeyword(keyword);
    body = cbMatch[3] || '';
  }

  let clean = body.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+\^[A-Za-z0-9_-]+\s*$/, '').trim();
  const hasRobot = clean.includes('🤖');
  if (hasRobot) clean = clean.replace(/🤖\s*/g, '').trim();

  let priority = '';
  const prioM = clean.match(/(?:^|\s)\[#([ABC])\](?=\s|$)/i);
  if (prioM) {
    priority = prioM[1].toUpperCase();
    clean = clean.replace(/(?:^|\s)\[#([ABC])\](?=\s|$)/i, ' ').trim();
  }

  let timeRange = '';
  const trM = clean.match(/^(\d{1,2}\s*:\s*\d{2}(?:\s*[-–]\s*\d{1,2}\s*:\s*\d{2})?)\s+(.*)$/);
  if (trM) {
    timeRange = normalizeTimeRangeLabel(trM[1]);
    clean = trM[2].trim();
  }

  let duration = '';
  const durM = clean.match(/\s+(\d+(?:\.\d+)?\s*(?:h|hr|hrs|m|min|mins))\s*$/i);
  if (durM) {
    duration = durM[1].replace(/\s+/g, '');
    clean = clean.slice(0, durM.index).trim();
  }

  if (isLegacyCheckbox) {
    clean = clean.replace(/✅\s*\d{4}-\d{2}-\d{2}/g, '').trim();
  }

  const title = clean || keyword;
  return {
    id: `${filePath}:${lineNumber}`,
    key: `${filePath}:${lineNumber}:${s.slice(0, 40)}`,
    filePath,
    date: dateStr,
    lineNumber,
    rawLine,
    keyword,
    bucket,
    isLegacyCheckbox,
    hasRobot,
    priority,
    timeRange,
    duration,
    title,
    tokens: tokenizeRichLine(title),
    childRawLines: [],
    children: [],
    childrenMeta: null,
    mtime: mtime || 0,
  };
}

function parseExecutionTasksFromDaily(content, filePath, dateStr, mtime) {
  const text = String(content || '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const parsed = splitFrontmatter(text);
  const flags = buildLineFlags(lines, parsed.bodyStartLine);

  let startHeading = -1;
  for (let i = parsed.bodyStartLine; i < lines.length; i++) {
    if (flags[i].inCode || flags[i].inAgentDeck) continue;
    if (EXEC_HEADING_RE.test(lines[i])) {
      startHeading = i;
      break;
    }
  }
  if (startHeading === -1) return [];

  let sectionEnd = lines.length;
  for (let i = startHeading + 1; i < lines.length; i++) {
    if (flags[i].inCode) continue;
    if (flags[i].inAgentDeck || /^\s*#{1,2}\s+/.test(lines[i]) || /^\s*---\s*$/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  const tasks = [];
  let currentTask = null;

  function flushTask() {
    if (currentTask) {
      currentTask.childrenMeta = buildChildrenMeta(currentTask.children);
      tasks.push(currentTask);
    }
    currentTask = null;
  }

  for (let i = startHeading + 1; i < sectionEnd; i++) {
    const line = lines[i];
    if (flags[i].inCode || !line.trim() || /^\s*<!--.*-->\s*$/.test(line)) continue;
    if (/^\s*#{3,6}\s+/.test(line)) {
      flushTask();
      continue;
    }

    if (/^(?:\t|  +)/.test(line) && currentTask) {
      currentTask.childRawLines.push(line);
      const child = parseJournalChildLine(line, i);
      if (child) currentTask.children.push(child);
      continue;
    }

    flushTask();
    const t = parseExecutionTaskHeader(line, i, filePath, dateStr, mtime);
    if (t) currentTask = t;
  }
  flushTask();

  return tasks;
}

function patchAgentDeckTaskKeyword(originalLine, newKeyword) {
  const s = String(originalLine || '');
  const kwRe = new RegExp(`^(\\s*[-*+]\\s+)(${AD_KW_PATTERN})(?=\\s|$)(.*)$`);
  const km = s.match(kwRe);
  if (km) {
    return `${km[1]}${newKeyword}${km[3]}`;
  }
  const cbm = s.match(/^(\s*[-*+]\s+)\[[^\]]\](\s*.*)$/);
  if (cbm) {
    let rest = cbm[2];
    if (newKeyword !== 'DONE') {
      rest = rest.replace(/\s*✅\s*\d{4}-\d{2}-\d{2}/g, '');
    }
    return `${cbm[1]}${newKeyword}${rest.startsWith(' ') ? rest : ' ' + rest}`.trimEnd();
  }
  return s;
}

function planExecutionTaskInsertion(content, taskBlockLines) {
  const insLines = Array.isArray(taskBlockLines) ? taskBlockLines.slice() : [String(taskBlockLines || '')];
  const text = String(content || '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const parsed = splitFrontmatter(text);
  const flags = buildLineFlags(lines, parsed.bodyStartLine);

  let execHeading = -1;
  for (let i = parsed.bodyStartLine; i < lines.length; i++) {
    if (flags[i].inCode || flags[i].inAgentDeck) continue;
    if (EXEC_HEADING_RE.test(lines[i])) {
      execHeading = i;
      break;
    }
  }

  if (execHeading !== -1) {
    let sectionEnd = lines.length;
    for (let i = execHeading + 1; i < lines.length; i++) {
      if (flags[i].inCode) continue;
      if (flags[i].inAgentDeck || /^\s*#{1,2}\s+/.test(lines[i]) || /^\s*---\s*$/.test(lines[i])) {
        sectionEnd = i;
        break;
      }
    }
    const insertAt = endOfNonEmptyBody(lines, execHeading, sectionEnd);
    const out = lines.slice();
    out.splice(insertAt, 0, ...insLines);
    return normalizeTrailingNewline(out).join('\n');
  }

  let afterDashboard = parsed.bodyStartLine;
  for (let i = parsed.bodyStartLine; i < lines.length; i++) {
    if (flags[i].inCode || flags[i].inAgentDeck) continue;
    if (/^##\s+效率看板\s*$/.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && (flags[j].inCode || lines[j].trim() === '')) j++;
      afterDashboard = j;
      break;
    }
  }

  let insertBefore = lines.length;
  for (let i = afterDashboard; i < lines.length; i++) {
    if (flags[i].inCode) continue;
    if (DAY_PERIOD_TITLE_RE.test(lines[i]) || /^\s*<!--\s*agent-deck:/i.test(lines[i])) {
      insertBefore = i;
      let back = i - 1;
      while (back >= afterDashboard && lines[back].trim() === '') back--;
      if (back >= afterDashboard && lines[back].trim() === '---') {
        insertBefore = back;
      }
      break;
    }
  }

  const out = lines.slice();
  const block = [];
  if (insertBefore > 0 && out[insertBefore - 1].trim() !== '') block.push('');
  block.push('## 今日执行', ...insLines);
  if (insertBefore < out.length && out[insertBefore].trim() !== '') block.push('');
  out.splice(insertBefore, 0, ...block);
  return normalizeTrailingNewline(out).join('\n');
}

function planRemoveTaskBlock(content, task) {
  const text = String(content || '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  let targetIdx = task.lineNumber;
  if (lines[targetIdx] !== task.rawLine) {
    targetIdx = lines.findIndex((l) => l === task.rawLine);
  }
  if (targetIdx < 0 || targetIdx >= lines.length) {
    return { nextContent: text, removedLines: [] };
  }

  let endIdx = targetIdx + 1;
  while (endIdx < lines.length && /^(?:\t|  +)/.test(lines[endIdx])) {
    endIdx++;
  }
  const removedLines = lines.slice(targetIdx, endIdx);
  const out = lines.slice();
  out.splice(targetIdx, endIdx - targetIdx);

  while (targetIdx < out.length && targetIdx > 0 && out[targetIdx].trim() === '' && out[targetIdx - 1].trim() === '') {
    out.splice(targetIdx, 1);
  }

  return {
    nextContent: normalizeTrailingNewline(out).join('\n'),
    removedLines,
  };
}

module.exports = {
  AD_OPEN_KWS,
  AD_ACTIVE_KWS,
  AD_DONE_KWS,
  AD_CANCEL_KWS,
  AD_KW_PATTERN,
  AD_KW_LINE_RE,
  AD_LEGACY_CB_RE,
  EXEC_HEADING_RE,
  classifyAgentDeckKeyword,
  parseExecutionTaskHeader,
  parseExecutionTasksFromDaily,
  patchAgentDeckTaskKeyword,
  planExecutionTaskInsertion,
  planRemoveTaskBlock,
};
