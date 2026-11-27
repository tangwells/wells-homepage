'use strict';

const { normalizeTime } = require('../utils/date');

function stripQuotes(val) {
  const s = String(val || '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).trim();
  }
  return s;
}

function splitFrontmatter(content) {
  const text = String(content || '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const emptyResult = {
    lines,
    bodyStartLine: 0,
    tags: [],
    aliases: [],
    startDate: '',
    endDate: '',
  };
  if (lines[0] !== '---') return emptyResult;
  let endLine = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---' || lines[i].trim() === '...') {
      endLine = i;
      break;
    }
  }
  if (endLine === -1) return emptyResult;

  const tags = [];
  const aliases = [];
  let startDate = '';
  let endDate = '';
  let currentKey = '';

  for (let i = 1; i < endLine; i++) {
    const line = lines[i];
    const listMatch = line.match(/^\s*-\s+(.+)$/);
    if (listMatch && currentKey) {
      const item = stripQuotes(listMatch[1]);
      if (currentKey === 'tags' && item) tags.push(item.replace(/^#/, ''));
      if (currentKey === 'aliases' && item) aliases.push(item);
      continue;
    }
    const kvMatch = line.match(/^([A-Za-z0-9_\-\u4e00-\u9fa5]+)\s*:\s*(.*)$/);
    if (!kvMatch) {
      currentKey = '';
      continue;
    }
    const key = kvMatch[1].trim();
    const rawVal = kvMatch[2].trim();
    currentKey = key;

    if (key === 'tags' || key === 'tag') {
      currentKey = 'tags';
      if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
        rawVal
          .slice(1, -1)
          .split(',')
          .map((x) => stripQuotes(x).replace(/^#/, ''))
          .filter(Boolean)
          .forEach((x) => tags.push(x));
        currentKey = '';
      } else if (rawVal) {
        rawVal
          .split(/[,\s]+/)
          .map((x) => stripQuotes(x).replace(/^#/, ''))
          .filter(Boolean)
          .forEach((x) => tags.push(x));
        currentKey = '';
      }
    } else if (key === 'aliases' || key === 'alias') {
      currentKey = 'aliases';
      if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
        rawVal
          .slice(1, -1)
          .split(',')
          .map((x) => stripQuotes(x))
          .filter(Boolean)
          .forEach((x) => aliases.push(x));
        currentKey = '';
      } else if (rawVal) {
        aliases.push(stripQuotes(rawVal));
        currentKey = '';
      }
    } else if (key === '开始时间') {
      const dm = stripQuotes(rawVal).match(/(\d{4}-\d{2}-\d{2})/);
      if (dm) startDate = dm[1];
      currentKey = '';
    } else if (key === '结束时间') {
      const dm = stripQuotes(rawVal).match(/(\d{4}-\d{2}-\d{2})/);
      if (dm) endDate = dm[1];
      currentKey = '';
    }
  }

  return {
    lines,
    bodyStartLine: endLine + 1,
    tags,
    aliases,
    startDate,
    endDate,
  };
}

/**
 * 判断每行是否处于围栏代码块内或 Agent Deck 区块内
 */
function buildLineFlags(lines, bodyStartLine) {
  const flags = new Array(lines.length);
  let fenceChar = '';
  let fenceLen = 0;
  let inAgentDeck = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i < bodyStartLine) {
      flags[i] = { inFrontmatter: true, inCode: false, inAgentDeck: false };
      continue;
    }

    let isFenceLine = false;
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      const rest = fenceMatch[2].trim();
      if (!fenceChar) {
        fenceChar = marker[0];
        fenceLen = marker.length;
        isFenceLine = true;
      } else if (marker[0] === fenceChar && marker.length >= fenceLen && rest === '') {
        fenceChar = '';
        fenceLen = 0;
        isFenceLine = true;
      }
    }

    if (/^\s*<!--\s*agent-deck:(layout:start|section:)/i.test(line)) {
      inAgentDeck = true;
    }

    flags[i] = {
      inFrontmatter: false,
      inCode: isFenceLine || Boolean(fenceChar),
      inAgentDeck,
    };

    if (/^\s*<!--\s*agent-deck:layout:end\s*-->/i.test(line)) {
      inAgentDeck = false;
    }
  }

  return flags;
}

function endOfNonEmptyBody(lines, start, end) {
  let j = end;
  while (j - 1 > start && lines[j - 1].trim() === '') j--;
  return j;
}

function normalizeTrailingNewline(lines) {
  while (lines.length > 1 && lines[lines.length - 1] === '' && lines[lines.length - 2] === '') {
    lines.pop();
  }
  if (lines.length === 0 || lines[lines.length - 1] !== '') {
    lines.push('');
  }
  return lines;
}

function tokenizeRichLine(text) {
  const raw = String(text || '');
  const segments = raw.split(/<br\s*\/?>/gi);
  const tokens = [];
  const linkRe = /\[\[([^\]]+)\]\]|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>\])"']+)/g;

  function pushText(t) {
    if (!t) return;
    const cleaned = t.replace(/\\([:<>\[\]*_])/g, '$1');
    tokens.push({ kind: 'text', text: cleaned });
  }

  for (let si = 0; si < segments.length; si++) {
    if (si > 0) tokens.push({ kind: 'br' });
    const seg = segments[si];
    let last = 0;
    linkRe.lastIndex = 0;
    let m;
    while ((m = linkRe.exec(seg)) !== null) {
      if (m.index > last) pushText(seg.slice(last, m.index));
      if (m[1] !== undefined) {
        const parts = m[1].split('|');
        const display = parts.length > 1 ? parts[parts.length - 1] : parts[0].split('/').pop();
        tokens.push({ kind: 'wiki', target: parts[0], display });
      } else if (m[2] !== undefined && m[3] !== undefined) {
        tokens.push({ kind: 'md', display: m[2], url: m[3] });
      } else if (m[4] !== undefined) {
        tokens.push({ kind: 'md', display: m[4], url: m[4] });
      }
      last = linkRe.lastIndex;
    }
    if (last < seg.length) pushText(seg.slice(last));
  }
  return tokens;
}

function extractInlineTags(text) {
  const masked = String(text || '')
    .replace(/\[\[[^\]]*\]\]/g, ' ')
    .replace(/\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ');
  const out = [];
  const re = /(?:^|\s)(#[^\s#.,;:!?()[\]{}<>"']+)/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    out.push(m[1]);
  }
  return out;
}

function cleanTaskTitle(rawRest) {
  let s = String(rawRest || '');
  let timestamp = '';
  const tsMatch = s.match(/^\*\*(\d{1,2}:\d{2})\*\*\s*/);
  if (tsMatch) {
    timestamp = normalizeTime(tsMatch[1]);
    s = s.slice(tsMatch[0].length);
  }

  const links = [];
  const rawLinks = [];
  const protect = (str) =>
    str
      .replace(/\[\[([^\]]+)\]\]/g, (raw, inner) => {
        const parts = inner.split('|');
        const display = parts.length > 1 ? parts[parts.length - 1] : parts[0].split('/').pop();
        links.push({ kind: 'wiki', target: parts[0], display });
        rawLinks.push(raw);
        return `__CH_LINK_${links.length - 1}__`;
      })
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (raw, label, url) => {
        links.push({ kind: 'md', url, display: label });
        rawLinks.push(raw);
        return `__CH_LINK_${links.length - 1}__`;
      });

  const metaStripped = protect(s)
    .replace(/[🛫⏳📅✅❌➕]\s*\d{4}-\d{2}-\d{2}/g, '')
    .replace(/🆔\s*[A-Za-z0-9_-]+/g, '')
    .replace(/⛔\s*[A-Za-z0-9_-]+(?:\s*,\s*[A-Za-z0-9_-]+)*/g, '')
    .replace(/🔁\s*[^🛫⏳📅✅❌⏫🔼🔽➕🆔⛔🪨\n]+/g, '')
    .replace(/[⏫🔼🔽🪨]/g, '')
    .replace(/🏁\s*\S+/g, '')
    .replace(/\s+\^[A-Za-z0-9_-]+\s*$/, '');

  const rawMdProtected = metaStripped
    .replace(/(?:^|\s)#(?:要事|闪念)(?=\s|$)/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const rawMarkdown = rawMdProtected.replace(/__CH_LINK_(\d+)__/g, (_m, idx) => rawLinks[Number(idx)]);

  s = metaStripped
    .replace(/(?:^|\s)#(?:要事|闪念|进度|疑难)(?=\s|$)/g, ' ')
    .replace(/(?:^|\s)#(?:Project|Area)\/[^\s]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const plainTitle = s.replace(/__CH_LINK_(\d+)__/g, (_m, idx) => links[Number(idx)].display);
  const tokens = [];
  let lastIdx = 0;
  const tokRe = /__CH_LINK_(\d+)__/g;
  let tm;
  while ((tm = tokRe.exec(s)) !== null) {
    if (tm.index > lastIdx) {
      tokens.push({ kind: 'text', text: s.slice(lastIdx, tm.index) });
    }
    tokens.push(links[Number(tm[1])]);
    lastIdx = tokRe.lastIndex;
  }
  if (lastIdx < s.length) {
    tokens.push({ kind: 'text', text: s.slice(lastIdx) });
  }

  return { title: plainTitle, rawMarkdown, tokens, timestamp };
}

function extractStickyMetaTags(item) {
  const tags = Array.isArray(item?.tags) ? item.tags : [];
  const areas = [];
  const projects = [];
  const seenAreas = new Set();
  const seenProjects = new Set();

  for (const tag of tags) {
    const t = String(tag || '').trim();
    const am = t.match(/^#(?:Area|领域)\/(.+)$/);
    if (am) {
      const label = am[1];
      if (label && !seenAreas.has(label)) {
        seenAreas.add(label);
        areas.push({ label, raw: t });
      }
      continue;
    }
    const pm = t.match(/^#(?:Project|项目)\/(.+)$/);
    if (pm) {
      const label = pm[1];
      if (label && !seenProjects.has(label)) {
        seenProjects.add(label);
        projects.push({ label, raw: t });
      }
    }
  }

  const filterAreas = areas.map((a) => a.label);
  if (item?.area && !seenAreas.has(item.area)) {
    filterAreas.push(item.area);
  }

  const filterProjects = projects.map((p) => p.label);
  if (filterProjects.length === 0 && item?.projectName) {
    filterProjects.push(item.projectName);
  }

  return {
    areas,
    projects,
    filterAreas,
    filterProjects,
  };
}

function collectDoingProjectLabels(projects) {
  const labels = new Set();
  if (!Array.isArray(projects)) return labels;
  for (const proj of projects) {
    if (!proj || proj.status !== 'doing') continue;
    const name = String(proj.name || '').trim();
    if (name) labels.add(name);
    if (Array.isArray(proj.aliases)) {
      for (const al of proj.aliases) {
        const clean = String(al || '')
          .trim()
          .replace(/^#/, '')
          .replace(/^(?:Project|项目)\//, '')
          .trim();
        if (clean) labels.add(clean);
      }
    }
  }
  return labels;
}

function stripDomainProjectTags(markdown) {
  const placeholders = [];
  const protectedStr = String(markdown || '').replace(
    /\[\[[^\]]*\]\]|\[[^\]]*\]\([^)]*\)|https?:\/\/[^\s<>\])"']+/g,
    (match) => {
      placeholders.push(match);
      return `__CH_STAG_${placeholders.length - 1}__`;
    }
  );
  const stripped = protectedStr.replace(
    /(?:^|\s)#(?:Area|领域|Project|项目)\/[^\s#.,;:!?()[\]{}<>"']+/g,
    ' '
  );
  return stripped
    .replace(/__CH_STAG_(\d+)__/g, (_m, idx) => placeholders[Number(idx)])
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function mapStatusChar(ch) {
  if (ch === ' ') return 'todo';
  if (ch === '/') return 'doing';
  if (ch === 'x' || ch === 'X') return 'done';
  if (ch === '-') return 'cancelled';
  if (ch === 'i') return 'info';
  if (ch === '?') return 'question';
  if (ch === 'I') return 'idea';
  if (ch === 'n') return 'note';
  return 'other';
}

function parseTaskLine(line, lineNumber, fileMeta) {
  const m = String(line || '').match(/^(\s*)([-*+])\s+\[(.)\]\s*(.*)$/);
  if (!m) return null;
  const indent = m[1];
  const bullet = m[2];
  const statusChar = m[3];
  const status = mapStatusChar(statusChar);
  const rest = m[4];

  const startM = rest.match(/🛫\s*(\d{4}-\d{2}-\d{2})/);
  const schedM = rest.match(/⏳\s*(\d{4}-\d{2}-\d{2})/);
  const dueM = rest.match(/📅\s*(\d{4}-\d{2}-\d{2})/);
  const doneM = rest.match(/✅\s*(\d{4}-\d{2}-\d{2})/);
  const cancelM = rest.match(/❌\s*(\d{4}-\d{2}-\d{2})/);
  const recM = rest.match(/🔁\s*([^🛫⏳📅✅❌⏫🔼🔽➕🆔⛔🪨^\n]+)/);
  const idM = rest.match(/🆔\s*([A-Za-z0-9_-]+)/);
  const depM = rest.match(/⛔\s*([A-Za-z0-9_-]+(?:\s*,\s*[A-Za-z0-9_-]+)*)/);
  const taskId = idM ? idM[1] : '';
  const dependsOn = depM
    ? Array.from(new Set(depM[1].split(',').map((x) => x.trim()).filter(Boolean)))
    : [];

  const priority = rest.includes('⏫')
    ? 'high'
    : rest.includes('🔼')
    ? 'medium'
    : rest.includes('🔽')
    ? 'low'
    : 'normal';
  const milestone = rest.includes('🪨');
  const tags = extractInlineTags(rest);
  const { title, rawMarkdown, tokens, timestamp } = cleanTaskTitle(rest);

  const scheduled = schedM ? schedM[1] : '';
  const implicitDate = fileMeta && fileMeta.implicitDate ? fileMeta.implicitDate : '';
  const effectiveScheduled = scheduled || implicitDate || '';

  return {
    id: `${fileMeta.filePath}:${lineNumber}`,
    filePath: fileMeta.filePath,
    fileBasename: fileMeta.basename,
    sourceKind: fileMeta.sourceKind,
    lineNumber,
    indent,
    indentDepth: indent.replace(/\t/g, '    ').length,
    bullet,
    rawLine: line,
    statusChar,
    status,
    title,
    rawMarkdown,
    tokens,
    timestamp,
    start: startM ? startM[1] : '',
    scheduled,
    effectiveScheduled,
    isImplicitScheduled: !scheduled && Boolean(implicitDate),
    due: dueM ? dueM[1] : '',
    doneDate: doneM ? doneM[1] : '',
    cancelledDate: cancelM ? cancelM[1] : '',
    recurrence: recM ? recM[1].trim() : '',
    taskId,
    dependsOn,
    priority,
    milestone,
    tags,
    projectPath: fileMeta.projectPath || '',
    projectName: fileMeta.projectName || '',
    area: fileMeta.area || '',
    mtime: fileMeta.mtime || 0,
  };
}

function resolveTaskProjectAndArea(task, fileMeta, projectByTagName) {
  let projectName = fileMeta.projectName || '';
  let projectPath = fileMeta.projectPath || '';
  let area = fileMeta.area || '';

  for (const tag of task.tags) {
    if (tag.startsWith('#Area/')) {
      area = tag.slice(6);
    } else if (tag.startsWith('#Project/') && projectByTagName) {
      const pAlias = tag.slice(1);
      const matched = projectByTagName.get(pAlias) || projectByTagName.get('#' + pAlias);
      if (matched) {
        projectName = matched.name;
        projectPath = matched.filePath;
        if (!area && matched.area) area = matched.area;
      } else if (!projectName) {
        projectName = tag.slice(9);
      }
    }
  }

  return {
    ...task,
    projectName,
    projectPath,
    area,
  };
}

function scanMarkdownTasks(content, fileMeta, projectByTagName) {
  const parsed = splitFrontmatter(content);
  if (parsed.tags.includes('cancel')) return { skippedCancelled: true, tasks: [], ideas: [], importants: [] };
  const lines = parsed.lines;
  const flags = buildLineFlags(lines, parsed.bodyStartLine);
  const tasks = [];
  const ideas = [];
  const importants = [];

  for (let i = parsed.bodyStartLine; i < lines.length; i++) {
    if (flags[i].inCode || flags[i].inAgentDeck) continue;
    const t = parseTaskLine(lines[i], i, fileMeta);
    if (!t) continue;
    if (t.tags.includes('#cancel')) continue;
    const enriched = resolveTaskProjectAndArea(t, fileMeta, projectByTagName);
    if (enriched.status === 'idea') {
      ideas.push(enriched);
    } else if (['todo', 'doing', 'done', 'cancelled', 'info', 'question'].includes(enriched.status)) {
      tasks.push(enriched);
      if (enriched.status === 'info' && enriched.tags.includes('#要事')) {
        importants.push(enriched);
      }
    }
  }

  return { skippedCancelled: false, tasks, ideas, importants };
}

module.exports = {
  stripQuotes,
  splitFrontmatter,
  buildLineFlags,
  endOfNonEmptyBody,
  normalizeTrailingNewline,
  tokenizeRichLine,
  extractInlineTags,
  cleanTaskTitle,
  extractStickyMetaTags,
  collectDoingProjectLabels,
  stripDomainProjectTags,
  mapStatusChar,
  parseTaskLine,
  resolveTaskProjectAndArea,
  scanMarkdownTasks,
};
