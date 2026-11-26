'use strict';

const Obsidian = require('obsidian');
const { ItemView } = Obsidian;
const { VIEW_TYPE } = require('../constants');
const { el } = require('../utils/dom');
const { VaultDataStore } = require('../services/data-store');
const { createVaultActions } = require('../services/vault-adapter');
const { SpiralEmbedController } = require('../services/spiral-embed');
const { createModalManager } = require('../ui/modals');
const { createStickyHeaderSection } = require('../ui/sticky-header');
const { createLeftColumnSection } = require('../ui/left-column');
const { createJournalCardSection } = require('../ui/journal-card');
const { createTasksCardSection } = require('../ui/tasks-card');
const { createGanttCardSection } = require('../ui/gantt-card');

class CarrotHomeView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.isClosed = false;

    this.rootEl = null;
    this.bgEl = null;
    this.scrollEl = null;

    this.store = null;
    this.spiralController = null;
    this.modals = null;
    this.stickyHeader = null;
    this.leftCol = null;
    this.journalCard = null;
    this.tasksCard = null;
    this.ganttCard = null;

    this.clockTimer = null;
    this.spiralMinuteTimer = null;
    this.resizeObserver = null;
    this.batchTimer = null;
    this.pendingChanges = [];
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return (this.plugin && this.plugin.settings && this.plugin.settings.title) || '我的工作台';
  }

  getIcon() {
    return 'home';
  }

  getSettings() {
    return this.plugin.settings;
  }

  applyThemeVars() {
    if (!this.rootEl) return;
    const settings = this.getSettings();
    const isImageBg = settings.backgroundKind === 'image';
    this.rootEl.style.setProperty('--ch-card-opacity', String(settings.cardOpacity));
    this.rootEl.style.setProperty('--ch-card-blur', `${settings.cardBlur}px`);
    this.rootEl.style.setProperty('--ch-card-radius', `${settings.cardRadius}px`);
    this.rootEl.style.setProperty('--ch-bg-opacity', String(settings.backgroundOpacity));
    this.rootEl.style.setProperty('--ch-bg-blur', `${settings.backgroundBlur}px`);
    this.rootEl.classList.toggle('ch-glass', isImageBg && settings.cardBlur > 0);
    this.rootEl.classList.toggle('ch-density-small', settings.taskDensity === 'small');
    this.rootEl.classList.toggle('ch-density-large', settings.taskDensity === 'large');
    if (this.bgEl) {
      this.bgEl.classList.toggle('is-image-blur', isImageBg && settings.backgroundBlur > 0 && Boolean(this.bgEl.style.backgroundImage));
    }
  }

  applyBackground() {
    if (!this.bgEl) return;
    const settings = this.getSettings();
    const bg = this.bgEl;
    bg.className = 'ch-bg-layer';
    bg.style.background = '';
    bg.style.backgroundImage = '';

    if (settings.backgroundKind === 'default') {
      bg.classList.add('is-default');
    } else if (settings.backgroundKind === 'color' && settings.backgroundValue) {
      bg.style.background = settings.backgroundValue;
    } else if (settings.backgroundKind === 'image' && settings.backgroundValue) {
      const val = settings.backgroundValue;
      if (/^(https?:|data:|app:)/i.test(val)) {
        bg.style.backgroundImage = `url("${val}")`;
      } else {
        const f = this.app.vault.getAbstractFileByPath(val);
        const src = f && this.app.vault.getResourcePath ? this.app.vault.getResourcePath(f) : '';
        if (src) bg.style.backgroundImage = `url("${src}")`;
        else bg.classList.add('is-default');
      }
    } else {
      bg.classList.add('is-default');
    }

    bg.classList.toggle(
      'is-image-blur',
      settings.backgroundKind === 'image' && settings.backgroundBlur > 0 && Boolean(bg.style.backgroundImage)
    );
  }

  applyResponsiveClasses(width) {
    if (!this.rootEl) return;
    this.rootEl.classList.toggle('ch-compact', width > 0 && width < 600);
    this.rootEl.classList.toggle('ch-narrow', width >= 600 && width < 720);
    this.rootEl.classList.toggle('ch-medium', width >= 720 && width < 980);
  }

  applyDirty(dirty) {
    if (!dirty || this.isClosed) return;
    if (dirty.sticky) this.stickyHeader.updateSticky();
    if (dirty.spiral) this.stickyHeader.updateSpiral();
    if (dirty.hero) this.stickyHeader.updateHero();
    if (dirty.compact) this.stickyHeader.updateCompactBar();
    if (dirty.clock) this.leftCol.updateClock();
    if (dirty.calendar) this.leftCol.updateCalendar();
    if (dirty.bookmarks) this.leftCol.updateBookmarks();
    if (dirty.recent) this.leftCol.updateRecent();
    if (dirty.journal) this.journalCard.update();
    if (dirty.tasks) this.tasksCard.update();
    if (dirty.gantt) this.ganttCard.update();
  }

  async refreshPaths(paths) {
    if (this.isClosed || !this.store || !Array.isArray(paths) || paths.length === 0) return;
    const changes = paths.map((p) => ({ type: 'modify', path: p }));
    const dirty = await this.store.handleBatchChanges(changes);
    if (this.isClosed) return;
    this.applyDirty(dirty);
  }

  async switchJournalDate(dateStr, syncCalendar) {
    if (this.isClosed || !this.store) return;
    const dirty = await this.store.switchJournalDate(dateStr, syncCalendar);
    if (this.isClosed || !dirty) return;
    this.applyDirty(dirty);
  }

  async forceReloadAll() {
    if (this.isClosed || !this.store) return;
    this.spiralController.resetRenderedFlag();
    const ok = await this.store.loadAll();
    if (!ok || this.isClosed) return;
    this.stickyHeader.updateAll();
    this.leftCol.updateAll();
    this.journalCard.update();
    this.tasksCard.update();
    this.ganttCard.update();
    if (!this.spiralController.wasRenderedDuringUI()) {
      this.spiralController.scheduleRender({ force: true });
    }
  }

  queueFileChange(type, path, oldPath) {
    if (this.isClosed || !path) return;
    if (!/\.md$/i.test(path) && !(oldPath && /\.md$/i.test(oldPath))) return;
    this.pendingChanges.push({ type, path, oldPath });
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      void this.flushPendingChanges();
    }, 260);
  }

  async flushPendingChanges() {
    if (this.isClosed || !this.store || this.pendingChanges.length === 0) return;
    const batch = this.pendingChanges.splice(0, this.pendingChanges.length);
    const dirty = await this.store.handleBatchChanges(batch);
    if (this.isClosed) return;
    this.applyDirty(dirty);
  }

  applySettingsChange(changedKeys = [], opts = {}) {
    if (this.isClosed || !this.rootEl) return;
    this.applyThemeVars();
    this.applyBackground();
    if (changedKeys.includes('title')) {
      try { this.leaf?.updateHeader?.(); } catch (_e) {}
    }
    if (opts && opts.skipModuleRefresh) return;

    const has = (k) => changedKeys.length === 0 || changedKeys.includes(k);
    if (has('showStickyNotes') || has('stickyFolded')) {
      this.stickyHeader.updateSticky();
      this.stickyHeader.updateCompactBar();
    }
    if (has('showFocusDial') || has('focusFolded')) {
      if (has('focusFolded') && !this.getSettings().focusFolded) {
        this.spiralController.markNeedsSync();
      }
      this.stickyHeader.updateSpiral();
      this.stickyHeader.updateCompactBar();
    }
    if (has('title') || has('showTitle')) this.stickyHeader.updateHero();
    if (has('showClock')) this.leftCol.updateClock();
    if (has('showCalendar')) this.leftCol.updateCalendar();
    if (has('showBookmarks') || has('pinnedEntries')) this.leftCol.updateBookmarks();
    if (has('showRecent') || has('recentCount')) this.leftCol.updateRecent();
    if (has('showJournal')) this.journalCard.update();
    if (has('showTasks') || has('taskLayout') || has('showCompletedTasks') || has('taskDensity')) {
      this.tasksCard.update();
    }
    if (has('showGantt') || has('ganttZoom') || has('ganttStatusFilter')) {
      this.ganttCard.update();
    }
  }

  openSettings() {
    this.modals?.openSettingsModal();
  }

  async onOpen() {
    this.isClosed = false;
    const container = this.contentEl;
    container.replaceChildren();

    this.addAction('refresh-cw', '刷新工作台数据', () => {
      void this.forceReloadAll();
    });
    this.addAction('settings', '工作台设置', () => {
      this.openSettings();
    });

    // 一次性搭建持久化壳层（.ch-scroll 永不销毁，彻底杜绝跳页首）
    this.rootEl = el('div', 'ch-root');
    this.bgEl = el('div', 'ch-bg-layer');
    this.scrollEl = el('div', 'ch-scroll');
    const inner = el('div', 'ch-inner');

    const stickySlot = el('div', 'ch-slot-sticky');
    const headerSlot = el('div', 'ch-slot-header');
    const compactBarSlot = el('div', 'ch-slot-compact');
    const mainGrid = el('div', 'ch-main-grid');
    const leftColSlot = el('div', 'ch-left-col');
    const rightCol = el('div', 'ch-right-col');
    const journalSlot = el('div', 'ch-slot-journal');
    const tasksSlot = el('div', 'ch-slot-tasks');
    const ganttSlot = el('div', 'ch-slot-gantt');

    rightCol.appendChild(journalSlot);
    rightCol.appendChild(tasksSlot);
    rightCol.appendChild(ganttSlot);
    mainGrid.appendChild(leftColSlot);
    mainGrid.appendChild(rightCol);

    inner.appendChild(stickySlot);
    inner.appendChild(headerSlot);
    inner.appendChild(compactBarSlot);
    inner.appendChild(mainGrid);
    this.scrollEl.appendChild(inner);
    this.rootEl.appendChild(this.bgEl);
    this.rootEl.appendChild(this.scrollEl);
    container.appendChild(this.rootEl);

    this.applyThemeVars();
    this.applyBackground();
    this.applyResponsiveClasses(container.clientWidth || container.offsetWidth || 1200);

    // 初始化核心服务与子模块
    this.store = new VaultDataStore(this.app);
    this.store.actions = createVaultActions({
      app: this.app,
      obsidian: Obsidian,
      store: this.store,
      onPathsChanged: (paths) => this.refreshPaths(paths),
    });

    const getSettings = () => this.getSettings();
    const getRootEl = () => this.rootEl;
    const getScrollEl = () => this.scrollEl;
    const updateSettings = (patch, opts) => this.plugin.updateSettings(patch, opts);

    this.spiralController = new SpiralEmbedController(
      this.app,
      () => this.store.state.journalDate,
      () => !this.isClosed && getSettings().showFocusDial && !getSettings().focusFolded,
      () => {
        if (!this.isClosed && this.stickyHeader) this.stickyHeader.updateSpiral();
      }
    );

    this.modals = createModalManager({
      app: this.app,
      store: this.store,
      actions: this.store.actions,
      getSettings,
      updateSettings,
    });

    this.stickyHeader = createStickyHeaderSection({
      app: this.app,
      obsidian: Obsidian,
      store: this.store,
      spiralController: this.spiralController,
      modals: this.modals,
      getSettings,
      getRootEl,
      getScrollEl,
      updateSettings,
      onSwitchJournalDate: (d, syncCal) => this.switchJournalDate(d, syncCal),
      stickySlot,
      headerSlot,
      compactBarSlot,
    });

    this.leftCol = createLeftColumnSection({
      app: this.app,
      obsidian: Obsidian,
      store: this.store,
      modals: this.modals,
      getSettings,
      getScrollEl,
      updateSettings,
      onSwitchJournalDate: (d, syncCal) => this.switchJournalDate(d, syncCal),
      leftColSlot,
    });

    this.journalCard = createJournalCardSection({
      app: this.app,
      store: this.store,
      getSettings,
      getScrollEl,
      onSwitchJournalDate: (d, syncCal) => this.switchJournalDate(d, syncCal),
      onRefreshPaths: (paths) => this.refreshPaths(paths),
      journalSlot,
    });

    this.tasksCard = createTasksCardSection({
      app: this.app,
      store: this.store,
      modals: this.modals,
      getSettings,
      getScrollEl,
      updateSettings,
      onSwitchJournalDate: (d, syncCal) => this.switchJournalDate(d, syncCal),
      tasksSlot,
    });

    this.ganttCard = createGanttCardSection({
      app: this.app,
      obsidian: Obsidian,
      store: this.store,
      modals: this.modals,
      getSettings,
      getScrollEl,
      updateSettings,
      ganttSlot,
    });

    this.bindEvents(container);
    await this.forceReloadAll();
  }

  bindEvents(container) {
    if (typeof ResizeObserver !== 'undefined' && container) {
      this.resizeObserver = new ResizeObserver((entries) => {
        const w = entries[0]?.contentRect?.width || container.clientWidth || 1200;
        const prevMedium = this.rootEl?.classList.contains('ch-medium');
        const prevNarrow = this.rootEl?.classList.contains('ch-narrow');
        const prevCompact = this.rootEl?.classList.contains('ch-compact');
        this.applyResponsiveClasses(w);
        const changed =
          prevMedium !== this.rootEl?.classList.contains('ch-medium') ||
          prevNarrow !== this.rootEl?.classList.contains('ch-narrow') ||
          prevCompact !== this.rootEl?.classList.contains('ch-compact');
        if (changed) {
          this.stickyHeader?.updateSticky();
        }
      });
      this.resizeObserver.observe(container);
    }

    this.clockTimer = setInterval(() => this.leftCol?.updateClockDigits(), 15000);
    this.spiralMinuteTimer = setInterval(() => this.spiralController?.sync({ force: true }), 60 * 1000);

    if (this.app?.workspace?.on) {
      this.registerEvent(
        this.app.workspace.on('agent-deck:sessions-changed', () => {
          this.spiralController?.scheduleRender({ force: true });
        })
      );
    }

    if (this.app?.workspace?.onLayoutReady) {
      this.app.workspace.onLayoutReady(() => {
        if (!this.isClosed && this.spiralController && !this.spiralController.hasView()) {
          this.stickyHeader?.updateSpiral();
        }
      });
    }

    if (this.app?.vault?.on) {
      for (const evt of ['modify', 'create', 'delete']) {
        this.registerEvent(
          this.app.vault.on(evt, (file) => {
            if (file && file.path) this.queueFileChange(evt, file.path);
          })
        );
      }
      this.registerEvent(
        this.app.vault.on('rename', (file, oldPath) => {
          if (file && file.path) this.queueFileChange('rename', file.path, oldPath);
        })
      );
    }

    if (this.app?.metadataCache?.on) {
      this.registerEvent(
        this.app.metadataCache.on('changed', (file) => {
          if (file && file.path) this.queueFileChange('modify', file.path);
        })
      );
    }
  }

  async onClose() {
    this.isClosed = true;
    if (this.clockTimer) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
    if (this.spiralMinuteTimer) {
      clearInterval(this.spiralMinuteTimer);
      this.spiralMinuteTimer = null;
    }
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.pendingChanges = [];
    if (this.resizeObserver) {
      try { this.resizeObserver.disconnect(); } catch (_e) {}
      this.resizeObserver = null;
    }
    this.modals?.cleanup();
    this.stickyHeader?.cleanup?.();
    this.journalCard?.cleanup?.();
    this.tasksCard?.cleanup?.();
    this.ganttCard?.cleanup();
    this.spiralController?.destroy();

    this.rootEl = null;
    this.bgEl = null;
    this.scrollEl = null;
    this.contentEl?.replaceChildren?.();
  }
}

module.exports = {
  CarrotHomeView,
};
