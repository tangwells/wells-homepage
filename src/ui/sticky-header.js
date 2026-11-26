'use strict';

const { formatDateYMD, extractLabelFromPath } = require('../utils/date');
const { el, setIconSafe, preserveScroll } = require('../utils/dom');
const {
  hasActiveTextSelection,
  isInteractiveMarkdownTarget,
  createMarkdownRenderScope,
} = require('../utils/markdown-render');
const { ensureNoteFromTemplate, openFileAtLine, runQuickAddChoice, runObsidianCommand } = require('../services/vault-adapter');

function createStickyHeaderSection({
  app,
  obsidian,
  store,
  spiralController,
  modals,
  getSettings,
  getRootEl,
  getScrollEl,
  updateSettings,
  onSwitchJournalDate,
  stickySlot,
  headerSlot,
  compactBarSlot,
}) {
  const stickyMdScope = createMarkdownRenderScope();
  const focusZoneSlot = el('div', 'ch-focus-slot');
  const heroSlot = el('div', 'ch-hero-slot');
  const headerEl = el('div', 'ch-header');
  headerEl.appendChild(focusZoneSlot);
  headerEl.appendChild(heroSlot);
  headerSlot.appendChild(headerEl);

  function computeSearchResults(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    if (store.state.searchMode === 'command') {
      const cmds = app.commands?.listCommands ? app.commands.listCommands() : [];
      return cmds
        .filter((c) => (c.name || '').toLowerCase().includes(q) || (c.id || '').toLowerCase().includes(q))
        .slice(0, 12)
        .map((c) => ({ kind: 'command', id: c.id, title: c.name, sub: c.id }));
    }
    const files = app.vault.getMarkdownFiles ? app.vault.getMarkdownFiles() : [];
    const scored = [];
    for (const f of files) {
      if (f.path.startsWith('01_附件/') && !q.includes('01_')) continue;
      const cache = app.metadataCache?.getFileCache?.(f);
      const rawAliases = cache?.frontmatter?.aliases;
      const aliasArr = Array.isArray(rawAliases) ? rawAliases : rawAliases ? [rawAliases] : [];
      const aliasStr = aliasArr.map((x) => String(x)).join(' ');
      const bLower = f.basename.toLowerCase();
      const aLower = aliasStr.toLowerCase();
      const pLower = f.path.toLowerCase();
      if (bLower.includes(q) || aLower.includes(q) || pLower.includes(q)) {
        const score = bLower.startsWith(q) ? 0 : aLower.includes(q) ? 1 : bLower.includes(q) ? 2 : 3;
        scored.push({
          kind: 'file',
          path: f.path,
          title: aliasArr[0] ? `${aliasArr[0]} (${f.basename})` : f.basename,
          sub: f.path,
          score,
          mtime: f.stat?.mtime || 0,
        });
      }
    }
    scored.sort((a, b) => a.score - b.score || b.mtime - a.mtime);
    return scored.slice(0, 14);
  }

  function updateSticky() {
    const settings = getSettings();
    const state = store.state;
    const rootEl = getRootEl();
    const today = formatDateYMD(new Date());

    preserveScroll(getScrollEl(), () => {
      stickyMdScope.reset();
      stickySlot.replaceChildren();
      if (!settings.showStickyNotes) {
        stickySlot.style.display = 'none';
        return;
      }
      stickySlot.style.display = '';

      const stickyZone = el('div', 'ch-sticky-zone');
      const pinnedImportants = state.importants || [];

      if (settings.stickyFolded) {
        const summaryText =
          pinnedImportants.length > 0
            ? `» 随手晾晾 (要事 ${pinnedImportants.length} · 闪念 ${state.ideaBatch.length})`
            : `» 随手晾晾 (${state.ideaBatch.length})`;
        const unfoldBtn = el('button', 'ch-folded-rope-btn', summaryText);
        unfoldBtn.addEventListener('click', () => {
          updateSettings({ stickyFolded: false });
        });
        const quickCap = el('button', 'ch-text-btn', '+ 贴一张');
        quickCap.addEventListener('click', modals.openFlashCaptureModal);
        stickyZone.appendChild(unfoldBtn);
        stickyZone.appendChild(quickCap);
      } else {
        const ropeWrap = el('div', 'ch-sticky-rope-wrap');
        const svgNS = 'http://www.w3.org/2000/svg';
        const ropeSvg = document.createElementNS(svgNS, 'svg');
        ropeSvg.setAttribute('class', 'ch-sticky-rope-svg');
        ropeSvg.setAttribute('viewBox', '0 0 1200 22');
        ropeSvg.setAttribute('preserveAspectRatio', 'none');
        const pathEl = document.createElementNS(svgNS, 'path');
        pathEl.setAttribute('d', 'M 4 5 Q 600 20 1196 5');
        pathEl.setAttribute('fill', 'none');
        pathEl.setAttribute('stroke', 'var(--ch-rope)');
        pathEl.setAttribute('stroke-width', '2');
        pathEl.setAttribute('stroke-linecap', 'round');
        ropeSvg.appendChild(pathEl);
        ropeWrap.appendChild(ropeSvg);

        const foldBtn = el('button', 'ch-sticky-fold-btn', '«');
        foldBtn.title = '收起随手晾晾';
        foldBtn.addEventListener('click', () => {
          updateSettings({ stickyFolded: true });
        });
        ropeWrap.appendChild(foldBtn);

        const totalSlots =
          rootEl && rootEl.classList.contains('ch-narrow')
            ? 2
            : rootEl && rootEl.classList.contains('ch-medium')
            ? 3
            : 6;
        const ideaSlots = Math.max(0, totalSlots - pinnedImportants.length);
        const ideaSlice = ideaSlots > 0 ? state.ideaBatch.slice(0, ideaSlots) : [];

        const renderStickyCardBody = (bodyEl, item) => {
          const stickyMd = String(item.rawMarkdown || item.title || '')
            .replace(/<br\s*\/?>/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          void stickyMdScope.render({
            app,
            container: bodyEl,
            markdown: stickyMd,
            sourcePath: item.filePath,
            fallbackTokens: item.tokens,
          });
        };

        const cardsGrid = el('div', 'ch-sticky-cards');
        if (pinnedImportants.length === 0 && ideaSlice.length === 0) {
          const emptyCard = el('div', 'ch-sticky-card');
          emptyCard.appendChild(el('div', 'ch-clothespin'));
          emptyCard.appendChild(el('div', 'ch-sticky-card-head', '闪念漫步'));
          emptyCard.appendChild(el('div', 'ch-sticky-card-body', '暂无历史 [I] 闪念或 #要事，点下方「+ 贴一张」开始记录。'));
          emptyCard.addEventListener('click', modals.openFlashCaptureModal);
          cardsGrid.appendChild(emptyCard);
        } else {
          for (const imp of pinnedImportants) {
            const card = el('div', 'ch-sticky-card is-important');
            card.appendChild(el('div', 'ch-clothespin'));
            const head = el('div', 'ch-sticky-card-head');
            head.appendChild(el('span', '', extractLabelFromPath(imp.filePath)));

            const headRight = el('div', 'ch-sticky-head-right');
            headRight.appendChild(el('span', 'ch-sticky-kind-tag is-important', imp.timestamp ? `要事 · ${imp.timestamp}` : '要事'));
            const doneBtn = el('button', 'ch-sticky-done-btn', '✓');
            doneBtn.title = '完成要事（改为 [x] 并下架）';
            doneBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              void store.actions?.writeTaskLinePatch(imp, { statusChar: 'x', doneDate: today });
            });
            headRight.appendChild(doneBtn);
            head.appendChild(headRight);
            card.appendChild(head);

            const body = el('div', 'ch-sticky-card-body');
            renderStickyCardBody(body, imp);
            card.appendChild(body);
            card.title = `要事（固定展示）· 点击打开 ${imp.filePath}`;
            card.addEventListener('click', (e) => {
              if (hasActiveTextSelection() || isInteractiveMarkdownTarget(e?.target)) return;
              openFileAtLine(app, imp.filePath, imp.lineNumber);
            });
            cardsGrid.appendChild(card);
          }

          for (const idea of ideaSlice) {
            const card = el('div', 'ch-sticky-card');
            card.appendChild(el('div', 'ch-clothespin'));
            const head = el('div', 'ch-sticky-card-head');
            head.appendChild(el('span', '', extractLabelFromPath(idea.filePath)));
            head.appendChild(el('span', '', idea.timestamp || '闪念'));
            card.appendChild(head);
            const body = el('div', 'ch-sticky-card-body');
            renderStickyCardBody(body, idea);
            card.appendChild(body);
            card.title = `点击打开 ${idea.filePath}`;
            card.addEventListener('click', (e) => {
              if (hasActiveTextSelection() || isInteractiveMarkdownTarget(e?.target)) return;
              openFileAtLine(app, idea.filePath, idea.lineNumber);
            });
            cardsGrid.appendChild(card);
          }
        }
        ropeWrap.appendChild(cardsGrid);
        stickyZone.appendChild(ropeWrap);

        const ctrlRow = el('div', 'ch-sticky-controls');
        const leftCtrl = el('div', '');
        leftCtrl.style.display = 'flex';
        leftCtrl.style.gap = '4px';
        const addBtn = el('button', 'ch-text-btn', '+ 贴一张');
        addBtn.addEventListener('click', modals.openFlashCaptureModal);
        const randBtn = el('button', 'ch-text-btn', '换一批');
        randBtn.addEventListener('click', () => {
          store.shuffleIdeas();
          updateSticky();
        });
        leftCtrl.appendChild(addBtn);
        leftCtrl.appendChild(randBtn);

        ctrlRow.appendChild(leftCtrl);
        stickyZone.appendChild(ctrlRow);
      }
      stickySlot.appendChild(stickyZone);
    });
  }

  function updateSpiral() {
    const settings = getSettings();
    const state = store.state;
    const today = formatDateYMD(new Date());

    headerEl.classList.toggle('no-spiral', !settings.showFocusDial);
    focusZoneSlot.replaceChildren();
    if (!settings.showFocusDial) {
      focusZoneSlot.style.display = 'none';
      return;
    }
    focusZoneSlot.style.display = '';

    const focusZone = el('div', 'ch-focus-zone');
    if (settings.focusFolded) {
      const pill = el('div', 'ch-focus-pill');
      pill.appendChild(el('span', 'ch-focus-badge', '🌀'));
      pill.appendChild(
        el(
          'span',
          'ch-focus-pill-title',
          state.journalDate === today ? '今日螺旋' : `${state.journalDate.slice(5).replace('-', '/')} 螺旋`
        )
      );
      pill.title = '点击展开螺旋日程图';
      pill.addEventListener('click', () => {
        spiralController.markNeedsSync();
        updateSettings({ focusFolded: false });
      });
      focusZone.appendChild(pill);
    } else {
      const shell = el('div', 'ch-spiral-shell');
      const toolbar = el('div', 'ch-spiral-toolbar');

      const dateSlot = el('div', 'ch-spiral-date-slot');
      if (state.journalDate !== today) {
        const dateChip = el(
          'button',
          'ch-spiral-date-chip',
          `${state.journalDate.slice(5).replace('-', '/')} · 回今天`
        );
        dateChip.title = '点击切换回今天';
        dateChip.addEventListener('click', () => onSwitchJournalDate(today, true));
        dateSlot.appendChild(dateChip);
      }
      toolbar.appendChild(dateSlot);

      const actions = el('div', 'ch-spiral-actions');
      const miniQuick = el('button', 'ch-spiral-mini-btn');
      miniQuick.title = '打开螺旋快速面板';
      setIconSafe(obsidian, miniQuick, 'zap', '⚡');
      miniQuick.addEventListener('click', () =>
        runObsidianCommand(app, obsidian, 'nautilus-spiral:quick-panel', '螺旋快速面板')
      );
      actions.appendChild(miniQuick);

      const spiralBtn = el('button', 'ch-spiral-mini-btn');
      spiralBtn.title = '打开 Nautilus Spiral 螺旋日程';
      setIconSafe(obsidian, spiralBtn, 'compass', '🧭');
      spiralBtn.addEventListener('click', () =>
        runObsidianCommand(app, obsidian, 'nautilus-spiral:open', '螺旋日程')
      );
      actions.appendChild(spiralBtn);

      const foldBtn = el('button', 'ch-spiral-mini-btn', '«');
      foldBtn.title = '收起螺旋日程图';
      foldBtn.addEventListener('click', () => {
        updateSettings({ focusFolded: true });
      });
      actions.appendChild(foldBtn);

      toolbar.appendChild(actions);
      shell.appendChild(toolbar);

      const spiralRes = spiralController.ensure();
      if (spiralRes.status === 'ready') {
        shell.appendChild(spiralRes.hostEl);
        spiralController.sync({ force: false });

        if (!state.journalData.exists) {
          const emptyAct = el('div', 'ch-spiral-empty-action');
          const createBtn = el('button', 'ch-btn is-primary', `创建 ${state.journalDate} 日注`);
          createBtn.addEventListener('click', async () => {
            await ensureNoteFromTemplate(
              app,
              `06_日志/${state.journalDate}.md`,
              '02_模版/日志.md',
              'daily',
              state.journalDate
            );
            await onSwitchJournalDate(state.journalDate, false);
            spiralController.sync({ force: true, animate: true });
          });
          emptyAct.appendChild(createBtn);
          shell.appendChild(emptyAct);
        }
      } else if (spiralRes.status === 'loading') {
        shell.appendChild(el('div', 'ch-spiral-status', '螺旋日程加载中…'));
      } else {
        const statusBox = el('div', 'ch-spiral-status');
        statusBox.appendChild(el('span', '', '未启用螺旋日程插件 (Nautilus Spiral)'));
        const openDailyBtn = el('button', 'ch-btn', `打开 ${state.journalDate} 日注`);
        openDailyBtn.addEventListener('click', () => store.actions?.openOrCreateDailyNote(state.journalDate));
        statusBox.appendChild(openDailyBtn);
        shell.appendChild(statusBox);
      }

      focusZone.appendChild(shell);
    }
    focusZoneSlot.appendChild(focusZone);
  }

  function updateHero() {
    const settings = getSettings();
    const state = store.state;
    const today = formatDateYMD(new Date());

    heroSlot.replaceChildren();
    const center = el('div', 'ch-hero-center');
    if (settings.showTitle) {
      center.appendChild(el('h1', 'ch-title', settings.title));
    }

    const searchRow = el('div', 'ch-search-row');
    const searchBox = el('div', 'ch-search-box');
    const sIcon = el('span', '');
    sIcon.style.display = 'inline-flex';
    sIcon.style.color = 'var(--ch-text-faint)';
    setIconSafe(obsidian, sIcon, 'search', '🔍');

    const searchInput = el('input', 'ch-search-input');
    searchInput.type = 'text';
    searchInput.placeholder = state.searchMode === 'command' ? '搜索并运行 Obsidian 命令…' : '搜索笔记、别名或切命令…';
    searchInput.value = state.searchQuery;

    const modeChip = el('button', `ch-mode-chip ${state.searchMode === 'command' ? 'is-cmd' : ''}`, state.searchMode === 'command' ? '命令' : '笔记');
    modeChip.title = '切换搜索笔记 / 运行命令';
    modeChip.addEventListener('click', () => {
      state.searchMode = state.searchMode === 'note' ? 'command' : 'note';
      state.searchResults = computeSearchResults(state.searchQuery);
      state.searchIndex = 0;
      modeChip.classList.toggle('is-cmd', state.searchMode === 'command');
      modeChip.textContent = state.searchMode === 'command' ? '命令' : '笔记';
      searchInput.placeholder = state.searchMode === 'command' ? '搜索并运行 Obsidian 命令…' : '搜索笔记、别名或切命令…';
      syncDropdown();
      searchInput.focus();
    });

    searchBox.appendChild(sIcon);
    searchBox.appendChild(searchInput);
    searchBox.appendChild(modeChip);

    const newNoteBtn = el('button', 'ch-new-note-btn', '+ 新建笔记');
    newNoteBtn.addEventListener('click', modals.openNewNoteModal);

    searchRow.appendChild(searchBox);
    searchRow.appendChild(newNoteBtn);

    const dropdown = el('div', 'ch-search-dropdown');
    dropdown.style.display = 'none';
    searchRow.appendChild(dropdown);

    function syncDropdown() {
      const results = computeSearchResults(searchInput.value);
      state.searchResults = results;
      dropdown.replaceChildren();
      if (!searchInput.value.trim() || results.length === 0) {
        dropdown.style.display = 'none';
        return;
      }
      dropdown.style.display = 'block';
      results.forEach((item, idx) => {
        const row = el('div', `ch-search-item ${idx === state.searchIndex ? 'is-selected' : ''}`);
        row.appendChild(el('span', '', item.title));
        row.appendChild(el('span', 'ch-search-item-sub', item.sub));
        row.addEventListener('mousedown', (e) => {
          e.preventDefault();
          executeSearchItem(item);
        });
        dropdown.appendChild(row);
      });
    }

    function executeSearchItem(item) {
      if (!item) return;
      state.searchQuery = '';
      searchInput.value = '';
      dropdown.style.display = 'none';
      if (item.kind === 'command') {
        runObsidianCommand(app, obsidian, item.id, item.title);
      } else {
        openFileAtLine(app, item.path);
      }
    }

    searchInput.addEventListener('input', () => {
      state.searchQuery = searchInput.value;
      state.searchIndex = 0;
      syncDropdown();
    });
    searchInput.addEventListener('keydown', (e) => {
      const results = state.searchResults;
      if (e.key === 'ArrowDown' && results.length > 0) {
        e.preventDefault();
        state.searchIndex = (state.searchIndex + 1) % results.length;
        syncDropdown();
      } else if (e.key === 'ArrowUp' && results.length > 0) {
        e.preventDefault();
        state.searchIndex = (state.searchIndex - 1 + results.length) % results.length;
        syncDropdown();
      } else if (e.key === 'Enter' && results.length > 0) {
        e.preventDefault();
        executeSearchItem(results[state.searchIndex] || results[0]);
      } else if (e.key === 'Escape') {
        dropdown.style.display = 'none';
      }
    });
    searchInput.addEventListener('blur', () => {
      setTimeout(() => { dropdown.style.display = 'none'; }, 150);
    });
    searchInput.addEventListener('focus', () => {
      if (searchInput.value.trim()) syncDropdown();
    });

    center.appendChild(searchRow);

    const quickBar = el('div', 'ch-quick-actions');
    const quickItems = [
      { icon: 'calendar-days', tip: '打开/创建今日日注', action: () => store.actions?.openOrCreateDailyNote(today) },
      { icon: 'calendar-range', tip: '打开/创建本周周志', action: () => store.actions?.openOrCreateWeeklyNote() },
      { icon: 'layout-dashboard', tip: '打开原 APS 看板', action: () => openFileAtLine(app, '01_附件/components/组件/APS.components') },
      { icon: 'folder-plus', tip: 'QuickAdd 新建项目', action: () => runQuickAddChoice(app, obsidian, '项目') },
      { icon: 'book-plus', tip: 'QuickAdd 新建课题', action: () => runQuickAddChoice(app, obsidian, '课题') },
      { icon: 'compass', tip: '打开螺旋日程 (Nautilus Spiral)', action: () => runObsidianCommand(app, obsidian, 'nautilus-spiral:open', '螺旋日程') },
      { icon: 'zap', tip: '螺旋快速面板', action: () => runObsidianCommand(app, obsidian, 'nautilus-spiral:quick-panel', '螺旋快速面板') },
      { icon: 'lightbulb', tip: '贴一张闪念到今日日注', action: () => modals.openFlashCaptureModal() },
    ];
    for (const qi of quickItems) {
      const tile = el('button', 'ch-quick-tile');
      tile.title = qi.tip;
      setIconSafe(obsidian, tile, qi.icon, '•');
      tile.addEventListener('click', qi.action);
      quickBar.appendChild(tile);
    }
    center.appendChild(quickBar);
    heroSlot.appendChild(center);
  }

  function updateCompactBar() {
    const settings = getSettings();
    const state = store.state;
    const today = formatDateYMD(new Date());

    compactBarSlot.replaceChildren();
    const compactBar = el('div', 'ch-compact-bar');
    if (settings.showStickyNotes) {
      const btn = el('button', 'ch-mini-pill-btn', '+ 贴一张');
      btn.addEventListener('click', modals.openFlashCaptureModal);
      compactBar.appendChild(btn);
    }
    if (settings.showFocusDial) {
      const label = `螺旋日程 · ${state.journalDate === today ? '今天' : state.journalDate.slice(5)}`;
      const btn = el('button', 'ch-mini-pill-btn', label);
      btn.addEventListener('click', () =>
        runObsidianCommand(app, obsidian, 'nautilus-spiral:open', '螺旋日程')
      );
      compactBar.appendChild(btn);
    }
    compactBarSlot.appendChild(compactBar);
  }

  function updateAll() {
    updateSticky();
    updateSpiral();
    updateHero();
    updateCompactBar();
  }

  return {
    updateSticky,
    updateSpiral,
    updateHero,
    updateCompactBar,
    updateAll,
    cleanup: () => stickyMdScope.destroy(),
  };
}

module.exports = {
  createStickyHeaderSection,
};
