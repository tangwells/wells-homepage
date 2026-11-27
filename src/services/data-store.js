'use strict';

const { formatDateYMD, getPeriodTitleByHour, pickDefaultJournalPeriod } = require('../utils/date');
const { getBookmarksPlugin, buildBookmarkTree } = require('./bookmarks-adapter');
const { getWeeklyNotePreset } = require('./periodic-notes-adapter');
const { scanMarkdownTasks } = require('../parsers/markdown');
const { parseDailyActiveStatus, parseDailyJournalTimeline } = require('../parsers/journal');
const { parseExecutionTasksFromDaily } = require('../parsers/execution');
const { parseProjectNote } = require('../parsers/project');

function emptyJournalData(filePath) {
  return {
    exists: false,
    filePath,
    periods: { 清晨: [], 上午: [], 下午: [], 晚上: [] },
    periodLineNumbers: { 清晨: -1, 上午: -1, 下午: -1, 晚上: -1 },
    totalCount: 0,
  };
}

function emptyActiveStatus() {
  return {
    items: [],
    primary: null,
    nextTodo: null,
    counts: { humanActive: 0, aiDoing: 0, aiPaused: 0, aiToReview: 0 },
  };
}

function extractDailyDate(path) {
  const dm = String(path || '').match(/^06_日志\/(?:.*\/)?(\d{4}-\d{2}-\d{2})\.md$/);
  return dm ? dm[1] : '';
}

function isRecentCandidatePath(p) {
  return (
    typeof p === 'string' &&
    p.endsWith('.md') &&
    !p.startsWith('01_附件/') &&
    !p.startsWith('.trash/') &&
    !p.startsWith('Agent Deck/派发/') &&
    !p.startsWith('Agent Deck/Conversations/')
  );
}

/**
 * 增量内存数据仓库：
 * - 首屏 loadAll() 并行扫描 04_Project 与 06_日志，建立分文件缓存；
 * - 后续 Vault 变动仅重读受影响的单个文件，并返回精确 dirty mask，
 *   避免全库重扫和无关模块 DOM 重建。
 */
class VaultDataStore {
  constructor(app) {
    this.app = app;
    this.loadSeq = 0;

    const todayStr = formatDateYMD(new Date());
    this.state = {
      ideas: [],
      importants: [],
      ideaBatch: [],
      ideaPage: 0,
      stickyAreaFilter: '',
      stickyProjectFilter: '',
      activeStatus: emptyActiveStatus(),
      calCursorYMD: todayStr,
      selectedDate: '',
      dailyFilesSet: new Set(),
      recentNotes: [],
      bookmarksEnabled: true,
      bookmarkTree: [],
      bookmarkGroups: [],
      bookmarkCollapsed: new Set(),
      projects: [],
      execTasks: [],
      execQuickScope: 'today', // today | overdue | open | done
      execKeyword: '',
      execExpandState: new Map(),
      journalDate: todayStr,
      journalPeriod: getPeriodTitleByHour(new Date().getHours()),
      journalData: emptyJournalData(`06_日志/${todayStr}.md`),
      journalExpandState: new Map(),
      ganttSearch: '',
      ganttStatusFilter: 'doing', // doing | all | overdue | done
      ganttExpanded: new Set(),
      ganttScrollLeft: null,
      searchMode: 'note', // note | command
      searchQuery: '',
      searchResults: [],
      searchIndex: 0,
    };

    // 增量缓存
    this.projectCache = new Map(); // path -> { mtime, rawText, prelim, proj }
    this.projectByTagName = new Map();
    this.logCache = new Map(); // path -> { mtime, rawText, dateStr, basename, execTasks, ideas, importants, activeStatus, isToday }
  }

  shuffleIdeas() {
    const arr = this.state.ideas.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    this.state.ideaBatch = arr;
    this.state.ideaPage = 0;
  }

  _syncIdeaBatchOrder(allIdeas) {
    if (this.state.ideaBatch.length === 0 && allIdeas.length > 0) {
      this.shuffleIdeas();
      return;
    }
    const byId = new Map(allIdeas.map((x) => [x.id, x]));
    this.state.ideaBatch = this.state.ideaBatch.map((x) => byId.get(x.id)).filter(Boolean);
    for (const idea of allIdeas) {
      if (!this.state.ideaBatch.some((b) => b.id === idea.id)) {
        this.state.ideaBatch.unshift(idea);
      }
    }
  }

  _buildRecentNotes() {
    const files = this.app.vault.getMarkdownFiles ? this.app.vault.getMarkdownFiles() : [];
    const recentCandidates = [];
    for (const f of files) {
      const p = f.path;
      if (!isRecentCandidatePath(p)) continue;
      const cache = this.app.metadataCache?.getFileCache?.(f);
      const rawAlias = cache?.frontmatter?.aliases;
      const alias = Array.isArray(rawAlias) ? rawAlias[0] : rawAlias;
      const title =
        (p.startsWith('05_Study/') || p.startsWith('04_Project/')) && alias
          ? String(alias).replace(/^#Project\//, '').trim()
          : f.basename;
      recentCandidates.push({
        path: p,
        title: title || f.basename,
        mtime: f.stat?.mtime || 0,
      });
    }
    recentCandidates.sort((a, b) => b.mtime - a.mtime);
    this.state.recentNotes = recentCandidates;
  }

  _rebuildProjectByTagName() {
    const map = new Map();
    for (const entry of this.projectCache.values()) {
      const p0 = entry.prelim;
      for (const al of p0.aliases) {
        const clean = al.replace(/^#/, '');
        map.set(clean, p0);
        map.set('#' + clean, p0);
      }
      map.set('Project/' + p0.name, p0);
    }
    this.projectByTagName = map;
  }

  _getDoingProjectFilterSignature() {
    return (this.state.projects || [])
      .filter((p) => p.status === 'doing')
      .map((p) => `${p.filePath}|${p.name}|${(p.aliases || []).join(',')}`)
      .sort()
      .join('\n');
  }

  _recomputeAllProjectsFromCache() {
    this._rebuildProjectByTagName();
    const parsedProjects = [];
    for (const entry of this.projectCache.values()) {
      entry.proj = parseProjectNote(entry.rawText, entry.filePath, this.projectByTagName, entry.mtime);
      parsedProjects.push(entry.proj);
    }
    parsedProjects.sort((a, b) => (a.projStart || '9999').localeCompare(b.projStart || '9999'));
    this.state.projects = parsedProjects;
  }

  _parseLogEntry(filePath, basename, rawText, mtime, todayPath) {
    const dateStr = extractDailyDate(filePath);
    const execTasks = dateStr ? parseExecutionTasksFromDaily(rawText, filePath, dateStr, mtime) : [];
    const fileMeta = {
      filePath,
      basename,
      sourceKind: 'log',
      projectPath: '',
      projectName: '',
      area: '',
      implicitDate: dateStr,
      mtime,
    };
    const res = scanMarkdownTasks(rawText, fileMeta, this.projectByTagName);
    const ideas = res.skippedCancelled ? [] : res.ideas;
    const importants = res.skippedCancelled ? [] : res.importants || [];
    const activeStatus = filePath === todayPath ? parseDailyActiveStatus(rawText) : null;
    return {
      filePath,
      basename,
      mtime,
      rawText,
      dateStr,
      execTasks,
      ideas,
      importants,
      activeStatus,
    };
  }

  _aggregateLogsFromCache(todayPath) {
    const dailySet = new Set();
    const allExecTasks = [];
    const allIdeas = [];
    const allImportants = [];
    let todayActive = emptyActiveStatus();

    for (const entry of this.logCache.values()) {
      if (entry.dateStr) dailySet.add(entry.dateStr);
      if (entry.execTasks.length > 0) allExecTasks.push(...entry.execTasks);
      if (entry.ideas.length > 0) allIdeas.push(...entry.ideas);
      if (entry.importants.length > 0) allImportants.push(...entry.importants);
      if (entry.filePath === todayPath && entry.activeStatus) {
        todayActive = entry.activeStatus;
      }
    }

    allExecTasks.sort((a, b) => b.date.localeCompare(a.date) || a.lineNumber - b.lineNumber);
    allImportants.sort(
      (a, b) =>
        (b.implicitDate || b.fileBasename || '').localeCompare(a.implicitDate || a.fileBasename || '') ||
        (b.mtime || 0) - (a.mtime || 0) ||
        a.lineNumber - b.lineNumber
    );

    this.state.dailyFilesSet = dailySet;
    this.state.execTasks = allExecTasks;
    this.state.ideas = allIdeas;
    this.state.importants = allImportants;
    this.state.activeStatus = todayActive;
    this._syncIdeaBatchOrder(allIdeas);
  }

  refreshBookmarks() {
    const plugin = getBookmarksPlugin(this.app);
    const tree = buildBookmarkTree(this.app, plugin);
    this.state.bookmarksEnabled = tree.enabled;
    this.state.bookmarkTree = tree.items;
    this.state.bookmarkGroups = tree.groups;
    return tree;
  }

  hasBookmarkForPath(targetPath) {
    if (!targetPath) return false;
    const walk = (nodes) => {
      for (const n of nodes) {
        if (n.path === targetPath) return true;
        if (n.children && n.children.length > 0 && walk(n.children)) return true;
      }
      return false;
    };
    return walk(this.state.bookmarkTree || []);
  }

  async loadAll() {
    const seq = ++this.loadSeq;
    const files = this.app.vault.getMarkdownFiles ? this.app.vault.getMarkdownFiles() : [];
    const today = formatDateYMD(new Date());
    const todayPath = `06_日志/${today}.md`;

    const projectFiles = [];
    const logFiles = [];
    for (const f of files) {
      if (f.path.startsWith('04_Project/')) projectFiles.push(f);
      else if (f.path.startsWith('06_日志/')) logFiles.push(f);
    }

    const [projectContents, logContents] = await Promise.all([
      Promise.all(projectFiles.map(async (f) => ({ file: f, text: await this.app.vault.cachedRead(f) }))),
      Promise.all(logFiles.map(async (f) => ({ file: f, text: await this.app.vault.cachedRead(f) }))),
    ]);
    if (seq !== this.loadSeq) return false;

    this.projectCache.clear();
    for (const item of projectContents) {
      const mtime = item.file.stat?.mtime || 0;
      const prelim = parseProjectNote(item.text, item.file.path, null, mtime);
      this.projectCache.set(item.file.path, {
        filePath: item.file.path,
        mtime,
        rawText: item.text,
        prelim,
        proj: prelim,
      });
    }
    this._recomputeAllProjectsFromCache();

    this.logCache.clear();
    for (const item of logContents) {
      const mtime = item.file.stat?.mtime || 0;
      const entry = this._parseLogEntry(item.file.path, item.file.basename, item.text, mtime, todayPath);
      this.logCache.set(item.file.path, entry);
    }
    this._aggregateLogsFromCache(todayPath);
    this._buildRecentNotes();
    this.refreshBookmarks();

    const journalPath = `06_日志/${this.state.journalDate}.md`;
    const cachedJournalEntry = this.logCache.get(journalPath);
    if (cachedJournalEntry) {
      this.state.journalData = parseDailyJournalTimeline(cachedJournalEntry.rawText, journalPath);
    } else {
      const journalFile = this.app.vault.getAbstractFileByPath(journalPath);
      if (journalFile) {
        const jText = await this.app.vault.cachedRead(journalFile);
        if (seq !== this.loadSeq) return false;
        this.state.journalData = parseDailyJournalTimeline(jText, journalPath);
      } else {
        this.state.journalData = emptyJournalData(journalPath);
      }
    }

    return true;
  }

  /**
   * 增量处理一批文件变更（由 Vault 事件或写回适配器调用）。
   * 返回 { sticky, spiral, calendar, bookmarks, recent, journal, tasks, gantt }
   */
  async handleBatchChanges(changes) {
    const dirty = {
      sticky: false,
      spiral: false,
      calendar: false,
      bookmarks: false,
      recent: false,
      journal: false,
      tasks: false,
      gantt: false,
    };
    if (!Array.isArray(changes) || changes.length === 0) return dirty;

    const today = formatDateYMD(new Date());
    const todayPath = `06_日志/${today}.md`;
    const activeJournalPath = `06_日志/${this.state.journalDate}.md`;

    let projectsDirty = false;
    let logsDirty = false;
    let weeklyDirty = false;
    let recentDirty = false;
    const weeklyFolder = getWeeklyNotePreset(this.app).folder;

    const toReadProjects = new Map();
    const toReadLogs = new Map();

    for (const ch of changes) {
      if (!ch) continue;
      const pathsToCheck = [];
      if (ch.oldPath && ch.oldPath !== ch.path) {
        pathsToCheck.push({ path: ch.oldPath, removed: true });
      }
      if (ch.path) {
        pathsToCheck.push({ path: ch.path, removed: ch.type === 'delete' });
      }

      for (const item of pathsToCheck) {
        const p = item.path;
        if (!p || !p.endsWith('.md')) continue;
        if (isRecentCandidatePath(p)) recentDirty = true;
        if (weeklyFolder ? p.startsWith(`${weeklyFolder}/`) : !p.includes('/')) {
          weeklyDirty = true;
        }

        if (p.startsWith('04_Project/')) {
          if (item.removed) {
            if (this.projectCache.delete(p)) projectsDirty = true;
            toReadProjects.delete(p);
          } else {
            const f = this.app.vault.getAbstractFileByPath(p);
            if (f) toReadProjects.set(p, f);
            else if (this.projectCache.delete(p)) projectsDirty = true;
          }
        } else if (p.startsWith('06_日志/')) {
          if (item.removed) {
            if (this.logCache.delete(p)) logsDirty = true;
            toReadLogs.delete(p);
            if (p === activeJournalPath) {
              this.state.journalData = emptyJournalData(activeJournalPath);
              dirty.journal = true;
              dirty.spiral = true;
            }
          } else {
            const f = this.app.vault.getAbstractFileByPath(p);
            if (f) toReadLogs.set(p, f);
            else if (this.logCache.delete(p)) {
              logsDirty = true;
              if (p === activeJournalPath) {
                this.state.journalData = emptyJournalData(activeJournalPath);
                dirty.journal = true;
                dirty.spiral = true;
              }
            }
          }
        }
      }
    }

    // 仅重读真正变更的 04_Project 单文件
    if (toReadProjects.size > 0) {
      const readList = await Promise.all(
        Array.from(toReadProjects.values()).map(async (f) => ({
          file: f,
          text: await this.app.vault.cachedRead(f),
        }))
      );
      for (const { file, text } of readList) {
        const prev = this.projectCache.get(file.path);
        const mtime = file.stat?.mtime || 0;
        if (prev && prev.rawText === text && prev.mtime === mtime) continue;
        const prelim = parseProjectNote(text, file.path, null, mtime);
        this.projectCache.set(file.path, {
          filePath: file.path,
          mtime,
          rawText: text,
          prelim,
          proj: prelim,
        });
        projectsDirty = true;
      }
    }

    if (projectsDirty) {
      const prevDoingSig = this._getDoingProjectFilterSignature();
      this._recomputeAllProjectsFromCache();
      dirty.gantt = true;
      if (this._getDoingProjectFilterSignature() !== prevDoingSig) {
        dirty.sticky = true;
      }
    }

    // 仅重读真正变更的 06_日志 单文件
    if (toReadLogs.size > 0) {
      const readLogs = await Promise.all(
        Array.from(toReadLogs.values()).map(async (f) => ({
          file: f,
          text: await this.app.vault.cachedRead(f),
        }))
      );
      for (const { file, text } of readLogs) {
        const prev = this.logCache.get(file.path);
        const mtime = file.stat?.mtime || 0;
        if (prev && prev.rawText === text && prev.mtime === mtime) continue;
        const entry = this._parseLogEntry(file.path, file.basename, text, mtime, todayPath);
        this.logCache.set(file.path, entry);
        logsDirty = true;

        if (file.path === activeJournalPath) {
          this.state.journalData = parseDailyJournalTimeline(text, activeJournalPath);
          dirty.journal = true;
          dirty.spiral = true;
        }
      }
    }

    if (logsDirty) {
      this._aggregateLogsFromCache(todayPath);
      dirty.sticky = true;
      dirty.calendar = true;
      dirty.tasks = true;
    } else if (weeklyDirty) {
      dirty.calendar = true;
    }

    if (recentDirty) {
      this._buildRecentNotes();
      dirty.recent = true;
    }

    return dirty;
  }

  async handleFileChange(type, path, oldPath) {
    return this.handleBatchChanges([{ type, path, oldPath }]);
  }

  async switchJournalDate(dateStr, syncCalendar) {
    const today = formatDateYMD(new Date());
    this.state.journalDate = dateStr;
    if (syncCalendar) {
      this.state.calCursorYMD = dateStr;
      this.state.selectedDate = dateStr === today ? '' : dateStr;
    }

    const jPath = `06_日志/${dateStr}.md`;
    const cached = this.logCache.get(jPath);
    if (cached) {
      this.state.journalData = parseDailyJournalTimeline(cached.rawText, jPath);
    } else {
      const jFile = this.app.vault.getAbstractFileByPath(jPath);
      if (jFile) {
        const text = await this.app.vault.cachedRead(jFile);
        if (this.state.journalDate !== dateStr) return null;
        this.state.journalData = parseDailyJournalTimeline(text, jPath);
      } else {
        this.state.journalData = emptyJournalData(jPath);
      }
    }

    this.state.journalPeriod = pickDefaultJournalPeriod(this.state.journalData, dateStr, today, new Date().getHours());
    return {
      journal: true,
      spiral: true,
      calendar: true,
      tasks: true,
    };
  }
}

module.exports = {
  VaultDataStore,
  emptyJournalData,
  emptyActiveStatus,
  extractDailyDate,
  isRecentCandidatePath,
};
