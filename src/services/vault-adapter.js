'use strict';

const { formatDateYMD, pad2, renderTemplateText } = require('../utils/date');
const { resolveWeeklyNoteTarget, resolveTemplateFile, renderWeeklyTemplate } = require('./periodic-notes-adapter');
const { planDailyEntryInsertion, buildFlashEntryLine, buildImportantEntryLine } = require('../parsers/journal');
const { patchAgentDeckTaskKeyword, planExecutionTaskInsertion, planRemoveTaskBlock } = require('../parsers/execution');
const { planProjectTaskInsertion, patchTaskLine, planAddTaskDependency, planRemoveTaskDependency } = require('../parsers/project');
const { addVaultBookmark, removeVaultBookmark, openVaultBookmark } = require('./bookmarks-adapter');

async function ensureFolderExists(app, filePath) {
  const parts = String(filePath || '').split('/');
  parts.pop();
  let cur = '';
  for (const part of parts) {
    if (!part) continue;
    cur = cur ? `${cur}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(cur)) {
      try {
        await app.vault.createFolder(cur);
      } catch (_e) {}
    }
  }
}

async function ensureNoteFromTemplate(app, targetPath, templatePath, kind, dateStr) {
  const existing = app.vault.getAbstractFileByPath(targetPath);
  if (existing) return existing;

  await ensureFolderExists(app, targetPath);
  let content = '';
  if (templatePath) {
    const tplFile = app.vault.getAbstractFileByPath(templatePath);
    if (tplFile) {
      content = await app.vault.read(tplFile);
      content = renderTemplateText(content, kind, dateStr);
    }
  }
  const file = await app.vault.create(targetPath, content);
  return file;
}

async function openFileAtLine(app, filePath, lineNumber, newTab) {
  const file = app.vault.getAbstractFileByPath(filePath);
  if (!file) return;
  const leaf = app.workspace.getLeaf(Boolean(newTab));
  await leaf.openFile(file, typeof lineNumber === 'number' ? { eState: { line: lineNumber } } : undefined);
}

function runQuickAddChoice(app, obsidian, choiceName) {
  const qa = app?.plugins?.plugins?.quickadd;
  const choices = qa?.settings?.choices || [];
  const hit = choices.find((c) => c && c.name === choiceName);
  if (hit && app.commands?.executeCommandById) {
    const ok = app.commands.executeCommandById(`quickadd:choice:${hit.id}`);
    if (ok) return true;
  }
  if (qa?.api && typeof qa.api.executeChoice === 'function') {
    Promise.resolve(qa.api.executeChoice(choiceName)).catch((err) => {
      if (obsidian?.Notice) new obsidian.Notice(`执行 QuickAdd「${choiceName}」失败：${err?.message || err}`);
    });
    return true;
  }
  if (obsidian?.Notice) {
    new obsidian.Notice(`未找到 QuickAdd 命令「${choiceName}」，请检查 QuickAdd 设置`);
  }
  return false;
}

function runObsidianCommand(app, obsidian, commandId, fallbackLabel) {
  if (app?.commands?.executeCommandById) {
    const ok = app.commands.executeCommandById(commandId);
    if (ok) return true;
  }
  if (obsidian?.Notice) {
    new obsidian.Notice(`未找到或无法执行命令：${fallbackLabel || commandId}`);
  }
  return false;
}

/**
 * 封装对 Vault 的各类写回操作，并在写回后触发增量刷新回调 onPathsChanged。
 */
function createVaultActions({ app, obsidian, store, onPathsChanged, onBookmarksChanged }) {
  async function notifyChanged(paths) {
    if (typeof onPathsChanged === 'function') {
      await onPathsChanged(paths);
    }
  }

  async function writeTaskLinePatch(task, patch) {
    const file = app.vault.getAbstractFileByPath(task.filePath);
    if (!file) return;
    const content = await app.vault.read(file);
    const lines = content.replace(/\r\n?/g, '\n').split('\n');
    let targetIdx = task.lineNumber;
    if (lines[targetIdx] !== task.rawLine) {
      targetIdx = lines.findIndex((l) => l === task.rawLine);
    }
    if (targetIdx < 0 || targetIdx >= lines.length) return;
    lines[targetIdx] = patchTaskLine(lines[targetIdx], patch);
    await app.vault.modify(file, lines.join('\n'));
    await notifyChanged([task.filePath]);
  }

  async function applyTaskPatches(patches) {
    if (!Array.isArray(patches) || patches.length === 0) return [];
    const byFile = new Map();
    for (const item of patches) {
      if (!item || !item.task || !item.task.filePath) continue;
      if (!byFile.has(item.task.filePath)) byFile.set(item.task.filePath, []);
      byFile.get(item.task.filePath).push(item);
    }
    const touched = [];
    for (const [filePath, filePatches] of byFile.entries()) {
      const file = app.vault.getAbstractFileByPath(filePath);
      if (!file) continue;
      const content = await app.vault.read(file);
      const lines = content.replace(/\r\n?/g, '\n').split('\n');
      let changed = false;
      for (const { task, patch } of filePatches) {
        let targetIdx = task.lineNumber;
        if (lines[targetIdx] !== task.rawLine) {
          targetIdx = lines.findIndex((l) => l === task.rawLine);
        }
        if (targetIdx < 0 || targetIdx >= lines.length) continue;
        const nextLine = patchTaskLine(lines[targetIdx], patch);
        if (nextLine !== lines[targetIdx]) {
          lines[targetIdx] = nextLine;
          changed = true;
        }
      }
      if (changed) {
        await app.vault.modify(file, lines.join('\n'));
        touched.push(filePath);
      }
    }
    return touched;
  }

  async function handleAddGanttDependency(predTask, succTask) {
    const allGanttTasks = [];
    for (const p of store.state.projects || []) {
      for (const gt of p.ganttTasks || []) allGanttTasks.push(gt);
    }
    const plan = planAddTaskDependency(allGanttTasks, predTask, succTask);
    if (!plan.ok) {
      if (obsidian?.Notice && plan.message) new obsidian.Notice(plan.message);
      return false;
    }
    const touched = await applyTaskPatches(plan.patches);
    if (obsidian?.Notice) {
      const shiftHint = plan.shiftedCount > 0 ? `（并自动顺延 ${plan.shiftedCount} 项下游排期）` : '';
      new obsidian.Notice(`已建立依赖：${predTask.title} → ${succTask.title}${shiftHint}`);
    }
    await notifyChanged(touched);
    return true;
  }

  async function handleRemoveGanttDependency(predTask, succTask) {
    if (!predTask?.taskId) return false;
    const plan = planRemoveTaskDependency(succTask, predTask.taskId);
    if (!plan.ok) return false;
    const touched = await applyTaskPatches(plan.patches);
    if (obsidian?.Notice) {
      new obsidian.Notice(`已断开依赖：${predTask.title} → ${succTask.title}`);
    }
    await notifyChanged(touched);
    return true;
  }

  async function updateExecutionTaskKeyword(task, newKeyword) {
    const file = app.vault.getAbstractFileByPath(task.filePath);
    if (!file) return;
    const content = await app.vault.read(file);
    const lines = content.replace(/\r\n?/g, '\n').split('\n');
    let targetIdx = task.lineNumber;
    if (lines[targetIdx] !== task.rawLine) {
      targetIdx = lines.findIndex((l) => l === task.rawLine);
    }
    if (targetIdx < 0 || targetIdx >= lines.length) return;
    lines[targetIdx] = patchAgentDeckTaskKeyword(lines[targetIdx], newKeyword);
    await app.vault.modify(file, lines.join('\n'));
    await notifyChanged([task.filePath]);
  }

  async function moveExecutionTaskToToday(task) {
    const today = formatDateYMD(new Date());
    const srcFile = app.vault.getAbstractFileByPath(task.filePath);
    if (!srcFile) return;

    const srcBefore = await app.vault.read(srcFile);
    const { nextContent, removedLines } = planRemoveTaskBlock(srcBefore, task);
    if (removedLines.length === 0) return;
    await app.vault.modify(srcFile, nextContent);

    const todayPath = `06_日志/${today}.md`;
    const todayFile = await ensureNoteFromTemplate(app, todayPath, '02_模版/日志.md', 'daily', today);
    const todayBefore = await app.vault.read(todayFile);
    const todayAfter = planExecutionTaskInsertion(todayBefore, removedLines);
    await app.vault.modify(todayFile, todayAfter);
    if (obsidian?.Notice) new obsidian.Notice(`已移至今日执行 → ${todayPath}`);
    await notifyChanged([task.filePath, todayPath]);
  }

  async function createNewExecutionTask(payload) {
    const today = formatDateYMD(new Date());
    const kw = payload.keyword || 'TODO';
    const prio = payload.priority ? `[#${payload.priority}] ` : '';
    const dur = payload.duration && payload.duration.trim() ? ` ${payload.duration.trim()}` : '';
    const taskLine = `- ${kw} ${prio}${payload.title.trim()}${dur}`;

    const todayPath = `06_日志/${today}.md`;
    const dFile = await ensureNoteFromTemplate(app, todayPath, '02_模版/日志.md', 'daily', today);
    const before = await app.vault.read(dFile);
    const after = planExecutionTaskInsertion(before, [taskLine]);
    await app.vault.modify(dFile, after);
    if (obsidian?.Notice) new obsidian.Notice(`已写入今日执行 → ${todayPath}`);
    await notifyChanged([todayPath]);
    return true;
  }

  async function saveFlashIdea(rawText, kind = 'idea') {
    const now = new Date();
    const today = formatDateYMD(now);
    const hhmm = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    const entry = kind === 'important' ? buildImportantEntryLine(rawText, hhmm) : buildFlashEntryLine(rawText, hhmm);
    if (!entry) return false;

    const path = `06_日志/${today}.md`;
    const file = await ensureNoteFromTemplate(app, path, '02_模版/日志.md', 'daily', today);
    const before = await app.vault.read(file);
    const after = planDailyEntryInsertion(before, { hhmm, entryText: entry, hour: now.getHours() });
    await app.vault.modify(file, after);
    if (obsidian?.Notice) new obsidian.Notice(`${kind === 'important' ? '已写入今日要事' : '已写入今日闪念'} → ${path}`);
    await notifyChanged([path]);
    return true;
  }

  async function createNewTask(payload) {
    const now = new Date();
    const today = formatDateYMD(now);
    const hhmm = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    const statusChar = payload.status === 'doing' ? '/' : ' ';
    const prioEmoji = payload.priority === 'high' ? ' ⏫' : payload.priority === 'medium' ? ' 🔼' : payload.priority === 'low' ? ' 🔽' : '';
    const parts = [`- [${statusChar}] ${payload.title.trim()}${prioEmoji}`];
    if (payload.scheduled && (payload.projectPath || payload.scheduled !== today)) {
      parts.push(`⏳ ${payload.scheduled}`);
    }
    if (payload.due) {
      parts.push(`📅 ${payload.due}`);
    }
    const taskLine = parts.join(' ');

    if (payload.projectPath) {
      const pFile = app.vault.getAbstractFileByPath(payload.projectPath);
      if (!pFile) return false;
      const before = await app.vault.read(pFile);
      const after = planProjectTaskInsertion(before, taskLine);
      await app.vault.modify(pFile, after);
      if (obsidian?.Notice) new obsidian.Notice(`已添加到项目「${payload.projectName || pFile.basename}」`);
      await notifyChanged([payload.projectPath]);
    } else {
      const path = `06_日志/${today}.md`;
      const dFile = await ensureNoteFromTemplate(app, path, '02_模版/日志.md', 'daily', today);
      const before = await app.vault.read(dFile);
      const after = planDailyEntryInsertion(before, { hhmm, entryText: taskLine, hour: now.getHours() });
      await app.vault.modify(dFile, after);
      if (obsidian?.Notice) new obsidian.Notice(`已写入今日日注 → ${path}`);
      await notifyChanged([path]);
    }
    return true;
  }

  async function openOrCreateDailyNote(dateStr) {
    const path = `06_日志/${dateStr}.md`;
    await ensureNoteFromTemplate(app, path, '02_模版/日志.md', 'daily', dateStr);
    await notifyChanged([path]);
    await openFileAtLine(app, path);
  }

  async function openOrCreateWeeklyNote(dateStr, newTab = false) {
    const targetDate = dateStr || formatDateYMD(new Date());
    const target = resolveWeeklyNoteTarget(app, targetDate);
    if (!target || !target.filePath) return '';

    const existing = app.vault.getAbstractFileByPath(target.filePath);
    if (!existing) {
      await ensureFolderExists(app, target.filePath);
      let content = '';
      const templatePath = target.preset?.template || '';
      if (templatePath) {
        const tplFile = resolveTemplateFile(app, templatePath);
        if (tplFile) {
          const rawTemplate = await app.vault.read(tplFile);
          content = renderWeeklyTemplate(rawTemplate, target);
        } else if (obsidian?.Notice) {
          new obsidian.Notice(`未找到周志模板：${templatePath}，已创建空白周志`);
        }
      }
      await app.vault.create(target.filePath, content);
      await notifyChanged([target.filePath]);
    }

    await openFileAtLine(app, target.filePath, undefined, Boolean(newTab));
    return target.filePath;
  }

  function addBookmark(payload) {
    const res = addVaultBookmark(app, obsidian, payload);
    if (res.ok) {
      store.refreshBookmarks();
      if (typeof onBookmarksChanged === 'function') onBookmarksChanged();
    }
    return res;
  }

  function removeBookmark(node) {
    const ok = removeVaultBookmark(app, obsidian, node && node.raw, node && node.title);
    if (ok) {
      store.refreshBookmarks();
      if (typeof onBookmarksChanged === 'function') onBookmarksChanged();
    }
    return ok;
  }

  async function openBookmark(node, newLeaf = false) {
    return openVaultBookmark(app, obsidian, node, newLeaf);
  }

  return {
    writeTaskLinePatch,
    applyTaskPatches,
    handleAddGanttDependency,
    handleRemoveGanttDependency,
    updateExecutionTaskKeyword,
    moveExecutionTaskToToday,
    createNewExecutionTask,
    saveFlashIdea,
    createNewTask,
    openOrCreateDailyNote,
    openOrCreateWeeklyNote,
    addBookmark,
    removeBookmark,
    openBookmark,
  };
}

module.exports = {
  ensureFolderExists,
  ensureNoteFromTemplate,
  openFileAtLine,
  runQuickAddChoice,
  runObsidianCommand,
  createVaultActions,
};
