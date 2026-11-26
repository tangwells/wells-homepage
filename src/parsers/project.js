'use strict';

const { addDaysYMD, diffDaysYMD } = require('../utils/date');
const {
  splitFrontmatter,
  buildLineFlags,
  endOfNonEmptyBody,
  normalizeTrailingNewline,
  parseTaskLine,
  resolveTaskProjectAndArea,
} = require('./markdown');

/**
 * 将新任务追加到项目笔记的 `# 规划` / `# 项目规划` 段落末尾
 */
function planProjectTaskInsertion(content, taskLine) {
  const text = String(content || '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const parsed = splitFrontmatter(text);
  const flags = buildLineFlags(lines, parsed.bodyStartLine);

  let planHeading = -1;
  for (let i = parsed.bodyStartLine; i < lines.length; i++) {
    if (flags[i].inCode) continue;
    if (/^\s*#\s*(?:项目)?规划\s*$/.test(lines[i])) {
      planHeading = i;
      break;
    }
  }

  if (planHeading !== -1) {
    let sectionEnd = lines.length;
    for (let i = planHeading + 1; i < lines.length; i++) {
      if (flags[i].inCode) continue;
      if (/^\s*#+\s+/.test(lines[i]) || /^\s*---\s*$/.test(lines[i])) {
        sectionEnd = i;
        break;
      }
    }
    const insertAt = endOfNonEmptyBody(lines, planHeading, sectionEnd);
    const out = lines.slice();
    out.splice(insertAt, 0, taskLine);
    return normalizeTrailingNewline(out).join('\n');
  }

  let fallbackAt = lines.length;
  for (let i = parsed.bodyStartLine; i < lines.length; i++) {
    if (flags[i].inCode) continue;
    if (/^\s*---\s*$/.test(lines[i]) || /^\s*#\s*资料\s*$/.test(lines[i])) {
      fallbackAt = i;
      break;
    }
  }
  const out = lines.slice();
  const ins = [];
  if (fallbackAt > 0 && out[fallbackAt - 1].trim() !== '') ins.push('');
  ins.push('# 规划', taskLine);
  if (fallbackAt < out.length && out[fallbackAt].trim() !== '') ins.push('');
  out.splice(fallbackAt, 0, ...ins);
  return normalizeTrailingNewline(out).join('\n');
}

function parseProjectNote(content, filePath, projectByTagName, mtime) {
  const parsed = splitFrontmatter(content);
  const lines = parsed.lines;
  const flags = buildLineFlags(lines, parsed.bodyStartLine);
  const basename = String(filePath || '').replace(/^.*\//, '').replace(/\.md$/, '');

  let bodyName = '';
  let bodyGoal = '';
  for (let i = parsed.bodyStartLine; i < lines.length; i++) {
    if (flags[i].inCode) continue;
    if (!bodyName) {
      const nm = lines[i].match(/\(name::\s*([^)]+)\)/);
      if (nm) bodyName = nm[1].trim();
    }
    if (!bodyGoal) {
      const gm = lines[i].match(/\(goal::\s*([^)]+)\)/);
      if (gm) bodyGoal = gm[1].trim();
    }
    if (bodyName && bodyGoal) break;
  }

  const aliasClean = (parsed.aliases[0] || '').replace(/^#Project\//, '').trim();
  const name = bodyName || aliasClean || basename;

  let area = '';
  for (const t of parsed.tags) {
    if (t.startsWith('Area/')) {
      area = t.slice(5);
      break;
    }
  }

  let status = 'doing';
  if (parsed.tags.includes('cancel')) status = 'cancel';
  else if (parsed.tags.includes('done')) status = 'done';
  else if (parsed.tags.includes('doing')) status = 'doing';

  const fileMeta = {
    filePath,
    basename,
    sourceKind: 'project',
    projectPath: filePath,
    projectName: name,
    area,
    implicitDate: '',
    mtime: mtime || 0,
  };

  let planStart = -1;
  let planEnd = lines.length;
  for (let i = parsed.bodyStartLine; i < lines.length; i++) {
    if (flags[i].inCode) continue;
    if (/^\s*#\s*(?:项目)?规划\s*$/.test(lines[i])) {
      planStart = i;
      for (let j = i + 1; j < lines.length; j++) {
        if (flags[j].inCode) continue;
        if (/^\s*#+\s+/.test(lines[j]) || /^\s*---\s*$/.test(lines[j])) {
          planEnd = j;
          break;
        }
      }
      break;
    }
  }

  const allTasks = [];
  const planTasks = [];
  for (let i = parsed.bodyStartLine; i < lines.length; i++) {
    if (flags[i].inCode || flags[i].inAgentDeck) continue;
    const t = parseTaskLine(lines[i], i, fileMeta);
    if (!t) continue;
    const enriched = projectByTagName ? resolveTaskProjectAndArea(t, fileMeta, projectByTagName) : t;
    allTasks.push(enriched);
    if (planStart !== -1 && i > planStart && i < planEnd) {
      planTasks.push(enriched);
    }
  }

  const treeTasks = planTasks.length > 0 ? planTasks : allTasks;
  const leafTasks = [];
  for (let i = 0; i < treeTasks.length; i++) {
    const curr = treeTasks[i];
    const next = treeTasks[i + 1];
    const hasChild = next && next.indentDepth > curr.indentDepth;
    if (!hasChild && ['todo', 'doing', 'done', 'cancelled'].includes(curr.status)) {
      leafTasks.push(curr);
    }
  }

  const activeLeaves = leafTasks.filter((t) => t.status !== 'cancelled');
  const doneCount = activeLeaves.filter((t) => t.status === 'done').length;
  const totalCount = activeLeaves.length;

  if (!parsed.tags.includes('doing') && !parsed.tags.includes('done') && !parsed.tags.includes('cancel')) {
    if (totalCount > 0 && doneCount === totalCount) {
      status = 'done';
    }
  }

  const ganttTasks = treeTasks
    .filter((t) => ['todo', 'doing', 'done'].includes(t.status))
    .map((t, idx) => {
      const next = treeTasks[idx + 1];
      const hasChild = next && next.indentDepth > t.indentDepth;
      const barStart = t.start || t.scheduled || t.due || t.doneDate;
      let barEnd = t.due || t.doneDate || t.scheduled || t.start;
      if (barStart && barEnd && barEnd < barStart) barEnd = barStart;
      return {
        ...t,
        isGroupHeader: hasChild,
        barStart,
        barEnd,
      };
    });

  const datedTaskBars = ganttTasks.filter((t) => t.barStart && t.barEnd);
  let projStart = parsed.startDate;
  let projEnd = parsed.endDate;
  if (!projStart && datedTaskBars.length > 0) {
    projStart = datedTaskBars.reduce((min, t) => (t.barStart < min ? t.barStart : min), datedTaskBars[0].barStart);
  }
  if (!projEnd && datedTaskBars.length > 0) {
    projEnd = datedTaskBars.reduce((max, t) => (t.barEnd > max ? t.barEnd : max), datedTaskBars[0].barEnd);
  }

  return {
    filePath,
    basename,
    name,
    goal: bodyGoal,
    area,
    tags: parsed.tags,
    aliases: parsed.aliases,
    status,
    fmStartDate: parsed.startDate,
    fmEndDate: parsed.endDate,
    projStart,
    projEnd,
    unscheduled: !projStart && !projEnd,
    doneCount,
    totalCount,
    progressPct: totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : status === 'done' ? 100 : 0,
    tasks: allTasks,
    ganttTasks,
  };
}

/**
 * 原地修改任务行（状态、🛫/⏳/📅/✅/❌ 日期、🆔、⛔ 依赖），保留缩进、标签与块引用。
 */
function upsertEmojiDate(body, emoji, dateStr) {
  const esc = emoji.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const existingRe = new RegExp(`(\\s*)${esc}\\s*\\d{4}-\\d{2}-\\d{2}`);
  if (dateStr === null) {
    return body.replace(existingRe, '').replace(/\s{2,}/g, ' ').trimEnd();
  }
  if (typeof dateStr !== 'string' || !dateStr) return body;

  if (existingRe.test(body)) {
    return body.replace(existingRe, `$1${emoji} ${dateStr}`);
  }

  const tailRe = /(\s+(?:🆔\s*[A-Za-z0-9_-]+|⛔\s*[A-Za-z0-9_-]+(?:\s*,\s*[A-Za-z0-9_-]+)*|\^[A-Za-z0-9_-]+).*)$/;
  const tm = body.match(tailRe);
  if (tm) {
    const head = body.slice(0, tm.index).trimEnd();
    return `${head} ${emoji} ${dateStr}${tm[1]}`;
  }
  return `${body.trimEnd()} ${emoji} ${dateStr}`;
}

function upsertTaskId(body, taskId) {
  const existingRe = /(\s*)🆔\s*[A-Za-z0-9_-]+/;
  if (!taskId) {
    return body.replace(existingRe, '').replace(/\s{2,}/g, ' ').trim();
  }
  const cleanId = String(taskId).trim();
  if (existingRe.test(body)) {
    return body.replace(existingRe, `$1🆔 ${cleanId}`);
  }
  const tailRe = /(\s+(?:⛔\s*[A-Za-z0-9_-]+(?:\s*,\s*[A-Za-z0-9_-]+)*|\^[A-Za-z0-9_-]+).*)$/;
  const tm = body.match(tailRe);
  if (tm) {
    const head = body.slice(0, tm.index).trimEnd();
    return `${head} 🆔 ${cleanId}${tm[1]}`;
  }
  return `${body.trimEnd()} 🆔 ${cleanId}`;
}

function upsertDependsOn(body, dependsOnList) {
  const list = Array.isArray(dependsOnList)
    ? Array.from(new Set(dependsOnList.map((x) => String(x || '').trim()).filter(Boolean)))
    : [];
  const existingRe = /(\s*)⛔\s*[A-Za-z0-9_-]+(?:\s*,\s*[A-Za-z0-9_-]+)*/g;
  if (list.length === 0) {
    return body.replace(existingRe, '').replace(/\s{2,}/g, ' ').trim();
  }
  const depStr = list.join(',');
  if (existingRe.test(body)) {
    existingRe.lastIndex = 0;
    return body.replace(existingRe, `$1⛔ ${depStr}`);
  }
  const tailRe = /(\s+\^[A-Za-z0-9_-]+.*)$/;
  const tm = body.match(tailRe);
  if (tm) {
    const head = body.slice(0, tm.index).trimEnd();
    return `${head} ⛔ ${depStr}${tm[1]}`;
  }
  return `${body.trimEnd()} ⛔ ${depStr}`;
}

function patchTaskLine(originalLine, patch) {
  const m = String(originalLine || '').match(/^(\s*)([-*+]\s+\[)(.)(\]\s*)(.*)$/);
  if (!m) return originalLine;
  const indent = m[1];
  const prefix = m[2];
  let statusChar = m[3];
  const mid = m[4];
  let body = m[5];

  if (typeof patch.statusChar === 'string' && patch.statusChar.length === 1) {
    statusChar = patch.statusChar;
  }
  if ('start' in patch) {
    body = upsertEmojiDate(body, '🛫', patch.start);
  }
  if ('scheduled' in patch) {
    body = upsertEmojiDate(body, '⏳', patch.scheduled);
  }
  if ('due' in patch) {
    body = upsertEmojiDate(body, '📅', patch.due);
  }
  if ('doneDate' in patch) {
    body = upsertEmojiDate(body, '✅', patch.doneDate);
  }
  if ('cancelledDate' in patch) {
    body = upsertEmojiDate(body, '❌', patch.cancelledDate);
  }
  if ('taskId' in patch) {
    body = upsertTaskId(body, patch.taskId);
  }
  if ('dependsOn' in patch) {
    body = upsertDependsOn(body, patch.dependsOn);
  }

  return `${indent}${prefix}${statusChar}${mid}${body.trim()}`;
}

function generateTaskId(usedIds) {
  const used = usedIds instanceof Set ? usedIds : new Set(usedIds || []);
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let attempt = 0; attempt < 256; attempt++) {
    let id = '';
    for (let i = 0; i < 6; i++) {
      id += chars[Math.floor(Math.random() * chars.length)];
    }
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
  }
  let fallback = `t${Date.now().toString(36).slice(-5)}`;
  while (used.has(fallback)) fallback += 'x';
  used.add(fallback);
  return fallback;
}

function computeTaskBarDates(t) {
  const barStart = (t && (t.start || t.scheduled || t.due || t.doneDate)) || '';
  let barEnd = (t && (t.due || t.doneDate || t.scheduled || t.start)) || '';
  if (barStart && barEnd && barEnd < barStart) barEnd = barStart;
  return { barStart, barEnd };
}

function buildOrthogonalDepPath(x1, y1, x2, y2) {
  const sx = Math.round(x1 * 10) / 10;
  const sy = Math.round(y1 * 10) / 10;
  const ex = Math.round(x2 * 10) / 10;
  const ey = Math.round(y2 * 10) / 10;
  if (ex >= sx + 18) {
    const xMid = Math.round(((sx + ex) / 2) * 10) / 10;
    return `M ${sx} ${sy} L ${xMid} ${sy} L ${xMid} ${ey} L ${ex} ${ey}`;
  }
  const padOut = Math.round((sx + 10) * 10) / 10;
  const padIn = Math.round((ex - 12) * 10) / 10;
  const yMid = sy === ey ? Math.round((sy - 17) * 10) / 10 : Math.round((sy < ey ? sy + 17 : sy - 17) * 10) / 10;
  return `M ${sx} ${sy} L ${padOut} ${sy} L ${padOut} ${yMid} L ${padIn} ${yMid} L ${padIn} ${ey} L ${ex} ${ey}`;
}

function planAddTaskDependency(allTasks, predTask, succTask, idGenerator) {
  if (!predTask || !succTask) {
    return { ok: false, reason: 'invalid', message: '无效的任务对象' };
  }
  const keyOf = (t) => (t && (t.id || `${t.filePath}:${t.lineNumber}`)) || '';
  const predKey = keyOf(predTask);
  const succKey = keyOf(succTask);
  if (
    predTask === succTask ||
    (predKey && predKey === succKey) ||
    (predTask.filePath && predTask.filePath === succTask.filePath && predTask.lineNumber === succTask.lineNumber)
  ) {
    return { ok: false, reason: 'self', message: '不能将任务连接到自身' };
  }
  if (predTask.taskId && Array.isArray(succTask.dependsOn) && succTask.dependsOn.includes(predTask.taskId)) {
    return { ok: false, reason: 'duplicate', message: `「${succTask.title}」已依赖于「${predTask.title}」` };
  }

  const taskPool = Array.isArray(allTasks) ? allTasks.slice() : [];
  if (!taskPool.some((t) => keyOf(t) === predKey)) taskPool.push(predTask);
  if (!taskPool.some((t) => keyOf(t) === succKey)) taskPool.push(succTask);

  const byTaskId = new Map();
  const usedIds = new Set();
  for (const t of taskPool) {
    if (t && t.taskId) {
      usedIds.add(t.taskId);
      if (!byTaskId.has(t.taskId)) byTaskId.set(t.taskId, t);
    }
  }
  if (succTask.taskId) {
    const visited = new Set();
    const bfs = [...(predTask.dependsOn || [])];
    while (bfs.length > 0) {
      const cid = bfs.shift();
      if (!cid || visited.has(cid)) continue;
      if (cid === succTask.taskId) {
        return {
          ok: false,
          reason: 'cycle',
          message: `无法建立依赖：「${predTask.title}」→「${succTask.title}」会形成循环依赖`,
        };
      }
      visited.add(cid);
      const anc = byTaskId.get(cid);
      if (anc && Array.isArray(anc.dependsOn)) {
        for (const upId of anc.dependsOn) bfs.push(upId);
      }
    }
  }

  const predNeedsId = !predTask.taskId;
  const gen = typeof idGenerator === 'function' ? idGenerator : generateTaskId;
  const predId = predTask.taskId || String(gen(usedIds));
  usedIds.add(predId);
  const nextSuccDeps = Array.from(new Set([...(succTask.dependsOn || []), predId]));

  const vByKey = new Map();
  const vByTaskId = new Map();
  for (const t of taskPool) {
    const k = keyOf(t);
    const tid = k === predKey ? predId : (t.taskId || '');
    const deps = k === succKey ? nextSuccDeps.slice() : Array.isArray(t.dependsOn) ? t.dependsOn.slice() : [];
    const { barStart, barEnd } = computeTaskBarDates(t);
    const node = {
      orig: t,
      key: k,
      status: t.status,
      taskId: tid,
      dependsOn: deps,
      start: t.start || '',
      scheduled: t.scheduled || '',
      due: t.due || '',
      doneDate: t.doneDate || '',
      barStart,
      barEnd,
      shifted: false,
      patch: {},
    };
    if (k === predKey && predNeedsId) node.patch.taskId = predId;
    if (k === succKey) node.patch.dependsOn = nextSuccDeps;
    vByKey.set(k, node);
    if (tid && !vByTaskId.has(tid)) vByTaskId.set(tid, node);
  }

  const dependentsByPredKey = new Map();
  for (const node of vByKey.values()) {
    for (const depId of node.dependsOn) {
      const pNode = vByTaskId.get(depId);
      if (!pNode || pNode.key === node.key) continue;
      if (!dependentsByPredKey.has(pNode.key)) dependentsByPredKey.set(pNode.key, []);
      dependentsByPredKey.get(pNode.key).push(node.key);
    }
  }

  function shiftTaskIfNeeded(pNode, sNode) {
    if (!pNode || !sNode) return false;
    if (sNode.status === 'done') return false;
    if (!pNode.barEnd || !sNode.barStart) return false;
    if (sNode.barStart >= pNode.barEnd) return false;
    if (!sNode.start && !sNode.scheduled && !sNode.due) return false;
    const delta = diffDaysYMD(sNode.barStart, pNode.barEnd);
    if (delta <= 0) return false;
    for (const field of ['start', 'scheduled', 'due']) {
      if (sNode[field]) {
        sNode[field] = addDaysYMD(sNode[field], delta);
        sNode.patch[field] = sNode[field];
      }
    }
    const nextDates = computeTaskBarDates(sNode);
    sNode.barStart = nextDates.barStart;
    sNode.barEnd = nextDates.barEnd;
    sNode.shifted = true;
    return true;
  }

  const predNode = vByKey.get(predKey);
  const succNode = vByKey.get(succKey);
  const cascadeQueue = [];
  if (shiftTaskIfNeeded(predNode, succNode)) {
    cascadeQueue.push(succKey);
  }

  let steps = 0;
  const maxSteps = taskPool.length * 4 + 20;
  let qi = 0;
  while (qi < cascadeQueue.length && steps < maxSteps) {
    steps++;
    const curKey = cascadeQueue[qi++];
    const curNode = vByKey.get(curKey);
    if (!curNode) continue;
    const childKeys = dependentsByPredKey.get(curKey) || [];
    for (const childKey of childKeys) {
      const childNode = vByKey.get(childKey);
      if (shiftTaskIfNeeded(curNode, childNode)) {
        cascadeQueue.push(childKey);
      }
    }
  }

  const patches = [];
  let shiftedCount = 0;
  for (const node of vByKey.values()) {
    if (node.shifted) shiftedCount++;
    if (Object.keys(node.patch).length > 0) {
      patches.push({ task: node.orig, patch: node.patch });
    }
  }

  return { ok: true, predId, patches, shiftedCount };
}

function planRemoveTaskDependency(succTask, predId) {
  if (!succTask || !predId) return { ok: false, patches: [] };
  const current = Array.isArray(succTask.dependsOn) ? succTask.dependsOn : [];
  const nextDeps = current.filter((id) => id !== predId);
  return {
    ok: true,
    patches: [{ task: succTask, patch: { dependsOn: nextDeps } }],
  };
}

module.exports = {
  planProjectTaskInsertion,
  parseProjectNote,
  upsertEmojiDate,
  upsertTaskId,
  upsertDependsOn,
  patchTaskLine,
  generateTaskId,
  computeTaskBarDates,
  buildOrthogonalDepPath,
  planAddTaskDependency,
  planRemoveTaskDependency,
};
