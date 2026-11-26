'use strict';

const { DAY_PERIODS } = require('../constants');
const { getPeriodIndexByHour, normalizeTime, normalizeTimeRangeLabel } = require('../utils/date');
const {
  splitFrontmatter,
  buildLineFlags,
  endOfNonEmptyBody,
  normalizeTrailingNewline,
  tokenizeRichLine,
} = require('./markdown');

const DAY_PERIOD_TITLE_RE = /^##\s+(清晨|上午|下午|晚上)\s*$/;
const INLINE_TIME_EXTRACT_RE = /^-\s+(?:\[[^\]]\]\s+)?\*\*(\d{1,2}):(\d{2})\*\*/;

/**
 * 将单行记录安全插入 06_日志/YYYY-MM-DD.md 的目标时段（## 清晨/上午/下午/晚上）
 * 严格避免插入到 Agent Deck（<!-- agent-deck:... -->）内部或末尾标记之后。
 */
function planDailyEntryInsertion(content, opts) {
  const { hhmm, entryText, hour } = opts;
  const targetTime = normalizeTime(hhmm);
  const targetPeriodIdx = getPeriodIndexByHour(
    typeof hour === 'number' ? hour : Number(targetTime.slice(0, 2))
  );
  const targetPeriodTitle = DAY_PERIODS[targetPeriodIdx].title;

  const text = String(content || '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const parsed = splitFrontmatter(text);
  const flags = buildLineFlags(lines, parsed.bodyStartLine);

  let agentDeckStart = lines.length;
  for (let i = parsed.bodyStartLine; i < lines.length; i++) {
    if (/^\s*<!--\s*agent-deck:/i.test(lines[i])) {
      agentDeckStart = i;
      let back = i - 1;
      while (back >= parsed.bodyStartLine && lines[back].trim() === '') back--;
      if (back >= parsed.bodyStartLine && lines[back].trim() === '---') {
        agentDeckStart = back;
      }
      break;
    }
  }

  let headingIdx = -1;
  for (let i = parsed.bodyStartLine; i < lines.length; i++) {
    if (flags[i].inCode || flags[i].inAgentDeck) continue;
    const m = lines[i].match(DAY_PERIOD_TITLE_RE);
    if (m && m[1] === targetPeriodTitle) {
      headingIdx = i;
      break;
    }
  }

  if (headingIdx !== -1) {
    let sectionEnd = lines.length;
    for (let i = headingIdx + 1; i < lines.length; i++) {
      if (flags[i].inCode) continue;
      if (/^#{1,6}\s+/.test(lines[i]) || /^\s*<!--\s*agent-deck:/i.test(lines[i])) {
        sectionEnd = i;
        break;
      }
      if (lines[i].trim() === '---' && i + 1 < lines.length && /^\s*<!--\s*agent-deck:/i.test(lines[i + 1])) {
        sectionEnd = i;
        break;
      }
      if (lines[i].trim() === '---') {
        let nextNonEmpty = i + 1;
        while (nextNonEmpty < lines.length && lines[nextNonEmpty].trim() === '') nextNonEmpty++;
        if (nextNonEmpty < lines.length && /^\s*<!--\s*agent-deck:/i.test(lines[nextNonEmpty])) {
          sectionEnd = i;
          break;
        }
      }
    }

    let insertAt = endOfNonEmptyBody(lines, headingIdx, sectionEnd);
    for (let i = headingIdx + 1; i < sectionEnd; i++) {
      const tm = lines[i].match(INLINE_TIME_EXTRACT_RE);
      if (tm) {
        const lineTime = normalizeTime(`${tm[1]}:${tm[2]}`);
        if (lineTime > targetTime) {
          insertAt = i;
          break;
        }
      }
    }

    const out = lines.slice();
    out.splice(insertAt, 0, entryText);
    return normalizeTrailingNewline(out).join('\n');
  }

  let journalStart = parsed.bodyStartLine;
  for (let i = parsed.bodyStartLine; i < agentDeckStart; i++) {
    if (flags[i].inCode) continue;
    if (/^##\s+效率看板\s*$/.test(lines[i])) {
      let j = i + 1;
      while (j < agentDeckStart && (flags[j].inCode || lines[j].trim() === '')) j++;
      while (j < agentDeckStart && flags[j].inCode) j++;
      if (j < agentDeckStart && /^\s*(`{3,}|~{3,})/.test(lines[j])) j++;
      journalStart = j;
      break;
    }
  }

  let insertHeadingAt = endOfNonEmptyBody(lines, journalStart - 1, agentDeckStart);
  if (insertHeadingAt < journalStart) insertHeadingAt = journalStart;

  for (let i = parsed.bodyStartLine; i < agentDeckStart; i++) {
    if (flags[i].inCode || flags[i].inAgentDeck) continue;
    const m = lines[i].match(DAY_PERIOD_TITLE_RE);
    if (!m) continue;
    const pIdx = DAY_PERIODS.findIndex((p) => p.title === m[1]);
    if (pIdx > targetPeriodIdx) {
      insertHeadingAt = i;
      break;
    }
  }

  const insertion = [];
  if (insertHeadingAt > 0 && lines[insertHeadingAt - 1].trim() !== '') {
    insertion.push('');
  }
  insertion.push(`## ${targetPeriodTitle}`, entryText);
  if (insertHeadingAt < lines.length && lines[insertHeadingAt].trim() !== '') {
    insertion.push('');
  }

  const out = lines.slice();
  out.splice(insertHeadingAt, 0, ...insertion);
  return normalizeTrailingNewline(out).join('\n');
}

function buildFlashEntryLine(rawText, hhmm) {
  const cleaned = String(rawText || '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .replace(/^\s*[-*+]\s*(\[[^\]]\]\s*)?/, '')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('<br>')
    .trim();
  if (!cleaned) return '';
  return `- [I] **${normalizeTime(hhmm)}** ${cleaned}`;
}

function buildImportantEntryLine(rawText, hhmm) {
  let cleaned = String(rawText || '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .replace(/^\s*[-*+]\s*(\[[^\]]\]\s*)?/, '')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('<br>')
    .trim();
  cleaned = cleaned.replace(/^#要事(?:\s+|$)/, '').trim();
  if (!cleaned) return '';
  return `- [i] **${normalizeTime(hhmm)}** #要事 ${cleaned}`;
}

function parseDailyActiveStatus(content) {
  const text = String(content || '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const parsed = splitFrontmatter(text);

  function extractSection(headingRe, stopRe) {
    let start = -1;
    for (let i = parsed.bodyStartLine; i < lines.length; i++) {
      if (headingRe.test(lines[i])) {
        start = i;
        break;
      }
    }
    if (start === -1) return [];
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (stopRe.test(lines[i])) {
        end = i;
        break;
      }
    }
    return lines.slice(start + 1, end).map((line, idx) => ({ line, lineNumber: start + 1 + idx }));
  }

  const activeLines = extractSection(
    /^##\s+正在做(?:\s+\^[A-Za-z0-9_-]+)?\s*$/,
    /^##\s+|^<!--\s*agent-deck:section:active:end\s*-->/i
  );
  const todoLines = extractSection(
    /^##\s+还要做(?:\s+\^[A-Za-z0-9_-]+)?\s*$/,
    /^##\s+|^<!--\s*agent-deck:section:todo:end\s*-->/i
  );

  const items = [];
  for (let i = 0; i < activeLines.length; i++) {
    const { line, lineNumber } = activeLines[i];
    const m = line.match(/^-\s*(DOING|PAUSED|TOREVIEW|DONE|DELEGATED)\s+(.*)$/);
    if (!m) continue;
    const status = m[1];
    let body = m[2].trim();
    const isAI = body.includes('🤖');
    body = body.replace(/🤖\s*/g, '');
    let timeRange = '';
    const tm = body.match(/^(\d{1,2}:\d{2}(?:-\d{1,2}:\d{2})?)\s+(.*)$/);
    if (tm) {
      timeRange = tm[1];
      body = tm[2];
    }
    body = body.replace(/\s+\^[A-Za-z0-9_-]+\s*$/, '').trim();
    const boldTitle = body.match(/^\*\*(.+?)\*\*$/);
    const title = boldTitle ? boldTitle[1].trim() : body;

    let clockSummary = '';
    for (let j = i + 1; j < activeLines.length; j++) {
      const child = activeLines[j].line;
      if (!/^\s+/.test(child)) break;
      const cm = child.match(/⏱\s*(.+?)(?:<!--.*-->)?$/);
      if (cm) {
        clockSummary = cm[1].trim();
      }
    }

    items.push({ status, isAI, timeRange, title, clockSummary, lineNumber });
  }

  const nextTodos = [];
  for (const { line, lineNumber } of todoLines) {
    const clean = line.replace(/^\s*[-*+]\s*(?:\[[^\]]\]\s*)?/, '').trim();
    if (!clean || clean.startsWith('<!--')) continue;
    if (/^\s/.test(line)) continue;
    nextTodos.push({ title: clean.replace(/\s+\^[A-Za-z0-9_-]+\s*$/, ''), lineNumber });
  }

  const humanDoing = items.find((x) => !x.isAI && x.status === 'DOING') || null;
  const humanPaused = items.find((x) => !x.isAI && x.status === 'PAUSED') || null;
  const aiDoingList = items.filter((x) => x.isAI && x.status === 'DOING');
  const aiPausedList = items.filter((x) => x.isAI && x.status === 'PAUSED');
  const aiReviewList = items.filter((x) => x.isAI && x.status === 'TOREVIEW');

  const primary =
    humanDoing ||
    humanPaused ||
    aiDoingList[0] ||
    aiReviewList[0] ||
    aiPausedList[0] ||
    null;

  return {
    items,
    primary,
    nextTodo: nextTodos[0] || null,
    counts: {
      humanActive: (humanDoing ? 1 : 0) + (humanPaused ? 1 : 0),
      aiDoing: aiDoingList.length,
      aiPaused: aiPausedList.length,
      aiToReview: aiReviewList.length,
    },
  };
}

function parseJournalEntryHeader(rawLine, lineNumber, filePath) {
  let s = String(rawLine || '').trimEnd();
  s = s.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+\^[A-Za-z0-9_-]+\s*$/, '').trim();
  const bulletMatch = s.match(/^[-*+]\s+(.*)$/);
  let body = bulletMatch ? bulletMatch[1].trim() : s;

  let kind = 'log';
  let badge = '';
  let isCheckbox = false;
  let statusChar = '';
  let hasRobot = false;

  const cbMatch = body.match(/^\[(.)\]\s*(.*)$/);
  if (cbMatch) {
    statusChar = cbMatch[1];
    body = cbMatch[2].trim();
    if (statusChar === ' ' || statusChar === '/' || statusChar === 'x' || statusChar === 'X') {
      isCheckbox = true;
      kind = statusChar === ' ' ? 'todo' : statusChar === '/' ? 'doing' : 'done';
    } else if (statusChar === 'I') {
      kind = 'idea';
      badge = '闪念';
      body = body.replace(/(?:^|\s)#闪念\b/g, ' ').trim();
    } else if (statusChar === 'i') {
      if (/(?:^|\s)#要事\b/.test(body)) {
        kind = 'important';
        badge = '要事';
        body = body.replace(/(?:^|\s)#要事\b/g, ' ').trim();
      } else if (/(?:^|\s)#进度\b/.test(body)) {
        kind = 'progress';
        badge = '进度';
      } else {
        kind = 'info';
        badge = '记录';
      }
    } else if (statusChar === '?') {
      kind = 'question';
      badge = '疑难';
    } else if (statusChar === '-') {
      kind = 'cancelled';
      badge = '已取消';
    } else if (statusChar === 'n') {
      kind = 'note';
      badge = '笔记';
    }
  }

  let boldTime = '';
  const boldTimeM = body.match(/^\*\*(\d{1,2}\s*:\s*\d{2}(?:\s*[-–]\s*\d{1,2}\s*:\s*\d{2})?)\*\*\s*(.*)$/);
  if (boldTimeM) {
    boldTime = normalizeTimeRangeLabel(boldTimeM[1]);
    body = boldTimeM[2].trim();
  }

  let statusKeyword = '';
  const kwM = body.match(/^(DOING|DONE|PAUSED|TOREVIEW|DELEGATED)\b\s*(.*)$/);
  if (kwM) {
    statusKeyword = kwM[1];
    if (!badge) badge = statusKeyword;
    if (kind === 'log') {
      kind = statusKeyword === 'DONE' ? 'done' : statusKeyword === 'TOREVIEW' ? 'review' : 'agent';
    }
    body = kwM[2].trim();
  }

  if (body.includes('🤖')) {
    hasRobot = true;
    body = body.replace(/🤖\s*/g, '').trim();
  }

  body = body.replace(/^\[#[A-Z]\]\s*/i, '').trim();

  // 仅识别粗体 **...** 包裹的时间戳（兼容状态词后置粗体时间戳，如 "- DELEGATED **19:34** ..."）
  const extraBoldM = body.match(/^\*\*(\d{1,2}\s*:\s*\d{2}(?:\s*[-–]\s*\d{1,2}\s*:\s*\d{2})?)\*\*\s*(.*)$/);
  if (extraBoldM) {
    if (!boldTime) boldTime = normalizeTimeRangeLabel(extraBoldM[1]);
    body = extraBoldM[2].trim();
  }

  if (!body && statusKeyword) {
    body = statusKeyword;
  }

  const timeLabel = boldTime || '—';
  const subTimeLabel = '';

  const dateChips = [];
  if (isCheckbox) {
    const schedM = body.match(/⏳\s*(\d{4}-\d{2}-\d{2})/);
    const dueM = body.match(/📅\s*(\d{4}-\d{2}-\d{2})/);
    const doneM = body.match(/✅\s*(\d{4}-\d{2}-\d{2})/);
    if (schedM) dateChips.push(`⏳ ${schedM[1].slice(5)}`);
    if (dueM) dateChips.push(`📅 ${dueM[1].slice(5)}`);
    if (doneM) dateChips.push(`✅ ${doneM[1].slice(5)}`);
    body = body
      .replace(/[🛫⏳📅✅❌➕]\s*\d{4}-\d{2}-\d{2}/g, '')
      .replace(/🆔\s*[A-Za-z0-9_-]+/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  return {
    key: `${filePath}:${lineNumber}:${String(rawLine || '').slice(0, 40)}`,
    filePath,
    lineNumber,
    rawLine,
    kind,
    badge,
    isCheckbox,
    statusChar,
    hasRobot,
    timeLabel,
    subTimeLabel,
    dateChips,
    bodyText: body,
    tokens: tokenizeRichLine(body),
  };
}

function parseJournalChildLine(rawLine, lineNumber) {
  const indentMatch = String(rawLine || '').match(/^(\s*)(.*)$/);
  const indent = indentMatch ? indentMatch[1] : '';
  let text = indentMatch ? indentMatch[2] : String(rawLine || '');
  text = text
    .replace(/^[-*+]\s+/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+\^[A-Za-z0-9_-]+\s*$/, '')
    .trim();

  if (!text) return null;

  let kind = 'plain';
  let turnNumber = null;
  if (text.startsWith('🎯')) {
    kind = 'goal';
  } else if (/^💬\s*累计总结/.test(text)) {
    kind = 'summary';
  } else if (text.startsWith('🔗')) {
    kind = 'link';
  } else if (text.startsWith('⏱')) {
    kind = 'clock';
  } else if (text.startsWith('💬') || text.startsWith('❓')) {
    kind = 'turn';
    const tm = text.match(/第(\d+)轮/);
    if (tm) turnNumber = Number(tm[1]);
  }

  const depth = Math.max(1, Math.round(indent.replace(/\t/g, '    ').length / 4));
  return {
    lineNumber,
    rawLine,
    depth,
    kind,
    turnNumber,
    text,
    tokens: tokenizeRichLine(text),
  };
}

function buildChildrenMeta(children) {
  if (!children || children.length === 0) {
    return {
      totalCount: 0,
      isAgentSession: false,
      clockPreview: '',
      goalPreview: '',
      summaryItems: [],
      turnItems: [],
      hiddenTurnCount: 0,
      plainItems: [],
    };
  }

  const isAgentSession = children.some((c) => c.kind !== 'plain');
  const goals = children.filter((c) => c.kind === 'goal');
  const summaries = children.filter((c) => c.kind === 'summary');
  const links = children.filter((c) => c.kind === 'link');
  const clocks = children.filter((c) => c.kind === 'clock');
  const turnItems = children.filter((c) => c.kind === 'turn');
  const plainItems = children.filter((c) => c.kind === 'plain');

  let clockPreview = '';
  if (clocks.length > 0) {
    const lastClock = clocks[clocks.length - 1].text;
    const cm = lastClock.match(/共\s*([^\s·]+)/);
    clockPreview = cm ? `⏱ ${cm[1]}` : lastClock.slice(0, 22);
  }
  const goalPreview = goals.length > 0 ? goals[0].text.replace(/^🎯\s*(?:目标[:：]?\s*)?/, '').trim() : '';

  return {
    totalCount: children.length,
    isAgentSession,
    clockPreview,
    goalPreview,
    summaryItems: [...goals, ...summaries, ...links, ...clocks],
    turnItems,
    hiddenTurnCount: Math.max(0, turnItems.length - 3),
    plainItems,
  };
}

function parseDailyJournalTimeline(content, filePath) {
  const periods = { 清晨: [], 上午: [], 下午: [], 晚上: [] };
  const periodLineNumbers = { 清晨: -1, 上午: -1, 下午: -1, 晚上: -1 };
  const text = String(content || '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const parsed = splitFrontmatter(text);
  const flags = buildLineFlags(lines, parsed.bodyStartLine);

  let currentPeriod = null;
  let currentEntry = null;

  function flushEntry() {
    if (currentEntry && currentPeriod) {
      currentEntry.childrenMeta = buildChildrenMeta(currentEntry.children);
      periods[currentPeriod].push(currentEntry);
    }
    currentEntry = null;
  }

  for (let i = parsed.bodyStartLine; i < lines.length; i++) {
    const line = lines[i];
    if (flags[i].inCode || flags[i].inAgentDeck) {
      flushEntry();
      currentPeriod = null;
      continue;
    }

    const periodM = line.match(DAY_PERIOD_TITLE_RE);
    if (periodM) {
      flushEntry();
      currentPeriod = periodM[1];
      if (periodLineNumbers[currentPeriod] === -1) {
        periodLineNumbers[currentPeriod] = i;
      }
      continue;
    }

    if (/^#{1,6}\s+/.test(line)) {
      flushEntry();
      currentPeriod = null;
      continue;
    }

    if (line.trim() === '---') {
      let nextIdx = i + 1;
      while (nextIdx < lines.length && lines[nextIdx].trim() === '') nextIdx++;
      if (nextIdx < lines.length && /^\s*<!--\s*agent-deck:/i.test(lines[nextIdx])) {
        flushEntry();
        currentPeriod = null;
        continue;
      }
    }

    if (!currentPeriod) continue;
    if (!line.trim() || /^\s*<!--.*-->\s*$/.test(line)) continue;

    if (/^(?:\t|  +)/.test(line) && currentEntry) {
      const child = parseJournalChildLine(line, i);
      if (child) currentEntry.children.push(child);
      continue;
    }

    flushEntry();
    const header = parseJournalEntryHeader(line, i, filePath);
    if (header.bodyText || header.badge) {
      currentEntry = { ...header, children: [], childrenMeta: null };
    }
  }
  flushEntry();

  const totalCount =
    periods['清晨'].length +
    periods['上午'].length +
    periods['下午'].length +
    periods['晚上'].length;

  return {
    exists: true,
    filePath,
    periods,
    periodLineNumbers,
    totalCount,
  };
}

module.exports = {
  DAY_PERIOD_TITLE_RE,
  INLINE_TIME_EXTRACT_RE,
  planDailyEntryInsertion,
  buildFlashEntryLine,
  buildImportantEntryLine,
  parseDailyActiveStatus,
  parseJournalEntryHeader,
  parseJournalChildLine,
  buildChildrenMeta,
  parseDailyJournalTimeline,
};
