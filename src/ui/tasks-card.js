'use strict';

const { formatDateYMD } = require('../utils/date');
const { el, preserveScroll } = require('../utils/dom');
const {
  hasActiveTextSelection,
  isInteractiveMarkdownTarget,
  createMarkdownRenderScope,
} = require('../utils/markdown-render');
const { openFileAtLine } = require('../services/vault-adapter');
const { renderExpandableChildren } = require('./expandable');

function createTasksCardSection({
  app,
  store,
  modals,
  getSettings,
  getScrollEl,
  updateSettings,
  onSwitchJournalDate,
  tasksSlot,
}) {
  const mdScope = createMarkdownRenderScope();
  let cardBuilt = false;
  let activeCountBadge = null;
  let pillsContainer = null;
  let bodyContainer = null;
  let densButtons = new Map();
  let layButtons = new Map();
  let actorButtons = new Map();
  let doneCheckbox = null;
  let kwInput = null;

  function renderExecTaskCard(t, today, onToggleExpand) {
    const card = el('div', `ch-task-card ${t.bucket === 'done' ? 'is-done' : ''}`);
    card.draggable = t.bucket !== 'cancelled';
    card.addEventListener('dragstart', (e) => {
      if (e.dataTransfer) e.dataTransfer.setData('text/plain', t.id);
    });

    const top = el('div', 'ch-task-top');
    const cb = el('button', `ch-checkbox ${t.bucket === 'done' ? 'is-done' : t.bucket === 'doing' ? 'is-doing' : ''}`);
    cb.textContent = t.bucket === 'done' ? '✓' : t.bucket === 'doing' ? '▶' : '';
    cb.title = t.bucket === 'done' ? '恢复为 TODO' : '标记为 DONE';
    cb.addEventListener('click', (e) => {
      e.stopPropagation();
      void store.actions?.updateExecutionTaskKeyword(t, t.bucket === 'done' ? 'TODO' : 'DONE');
    });
    top.appendChild(cb);

    if ((t.keyword !== 'TODO' && t.keyword !== 'DONE') || t.hasRobot) {
      const kwText = `${t.hasRobot ? '🤖 ' : ''}${t.keyword}`.trim();
      const kwCls = t.bucket === 'doing' ? 'kind-agent' : t.bucket === 'done' ? 'kind-done' : 'kind-idea';
      top.appendChild(el('span', `ch-tl-badge ${kwCls}`, kwText));
    }

    const titleEl = el('div', 'ch-task-title');
    void mdScope.render({
      app,
      container: titleEl,
      markdown: t.title,
      sourcePath: t.filePath,
      fallbackTokens: t.tokens,
    });
    titleEl.addEventListener('click', (e) => {
      if (hasActiveTextSelection() || isInteractiveMarkdownTarget(e?.target)) return;
      openFileAtLine(app, t.filePath, t.lineNumber);
    });
    top.appendChild(titleEl);
    card.appendChild(top);

    const meta = el('div', 'ch-task-meta');
    const badges = el('div', 'ch-task-badges');
    if (t.priority) {
      badges.appendChild(el('span', 'ch-tag-chip', `[#${t.priority}]`));
    }
    if (t.date) {
      const isOverdue = t.bucket !== 'done' && t.date < today;
      const cls = isOverdue ? 'is-overdue' : t.date === today ? 'is-today' : '';
      const lbl = t.date === today ? '今天' : isOverdue ? `${t.date.slice(5)} 延期` : t.date.slice(5);
      badges.appendChild(el('span', `ch-tag-chip ${cls}`, lbl));
    }
    if (t.timeRange) {
      badges.appendChild(el('span', 'ch-tag-chip', t.timeRange));
    }
    if (t.duration) {
      badges.appendChild(el('span', 'ch-tag-chip', t.duration));
    }
    meta.appendChild(badges);

    const actions = el('div', 'ch-task-actions');
    const stateBtn = el(
      'button',
      'ch-tiny-icon-btn',
      t.keyword === 'DOING' ? '⏸' : t.bucket === 'doing' ? '↺' : '▶'
    );
    stateBtn.title =
      t.keyword === 'DOING' ? '切为 PAUSED' : t.bucket === 'doing' ? '退回 TODO' : '切为 DOING';
    stateBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const nextKw = t.keyword === 'DOING' ? 'PAUSED' : t.bucket === 'doing' ? 'TODO' : 'DOING';
      void store.actions?.updateExecutionTaskKeyword(t, nextKw);
    });
    actions.appendChild(stateBtn);

    if (t.date < today && (t.bucket === 'todo' || t.bucket === 'doing')) {
      const moveBtn = el('button', 'ch-mini-pill-btn', '移到今日');
      moveBtn.title = `连同子块移到今日 (${today}) ## 今日执行`;
      moveBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void store.actions?.moveExecutionTaskToToday(t);
      });
      actions.appendChild(moveBtn);
    }
    meta.appendChild(actions);
    card.appendChild(meta);

    renderExpandableChildren({
      hostEl: card,
      entryKey: t.key,
      children: t.children,
      childrenMeta: t.childrenMeta,
      expandMap: store.state.execExpandState,
      app,
      mdScope,
      sourcePath: t.filePath,
      onToggle: onToggleExpand,
      collapsedPrefix: '▸ ',
      bindHostClick: false,
      indentPlainChildren: false,
    });

    return card;
  }

  function syncToolbarControls() {
    const settings = getSettings();
    const state = store.state;
    for (const [k, btn] of densButtons.entries()) {
      btn.classList.toggle('is-active', settings.taskDensity === k);
    }
    for (const [k, btn] of layButtons.entries()) {
      btn.classList.toggle('is-active', settings.taskLayout === k);
    }
    for (const [k, btn] of actorButtons.entries()) {
      btn.classList.toggle('is-active', state.execActorFilter === k);
    }
    if (doneCheckbox) {
      doneCheckbox.checked = Boolean(settings.showCompletedTasks);
    }
    if (kwInput && kwInput.value !== state.execKeyword) {
      kwInput.value = state.execKeyword;
    }
  }

  function renderTaskBody() {
    if (!cardBuilt || !bodyContainer || !pillsContainer || !activeCountBadge) return;
    const settings = getSettings();
    const state = store.state;
    const today = formatDateYMD(new Date());

    function matchesBaseFilters(t) {
      if (t.bucket === 'cancelled') return false;
      if (state.execActorFilter === 'human' && t.hasRobot) return false;
      if (state.execActorFilter === 'ai' && !t.hasRobot) return false;
      if (state.selectedDate && t.date !== state.selectedDate) return false;
      const kw = state.execKeyword.trim().toLowerCase();
      if (kw) {
        const hay = `${t.title} ${t.keyword} ${t.date} ${t.duration}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    }

    const isFocusMatch = (t) =>
      t.date === today
        ? settings.showCompletedTasks || t.bucket !== 'done'
        : t.date < today && (t.bucket === 'todo' || t.bucket === 'doing');
    const isTodayMatch = (t) =>
      t.date === today && (settings.showCompletedTasks || t.bucket !== 'done');
    const isOverdueMatch = (t) =>
      t.date < today && (t.bucket === 'todo' || t.bucket === 'doing');
    const isOpenMatch = (t) => t.bucket === 'todo' || t.bucket === 'doing';
    const isDoneMatch = (t) => t.bucket === 'done';

    preserveScroll(getScrollEl(), () => {
      const baseList = state.execTasks.filter(matchesBaseFilters);

      const counts = {
        focus: baseList.filter(isFocusMatch).length,
        today: baseList.filter(isTodayMatch).length,
        overdue: baseList.filter(isOverdueMatch).length,
        open: baseList.filter(isOpenMatch).length,
        done: baseList.filter(isDoneMatch).length,
      };

      pillsContainer.replaceChildren();
      const scopes = [
        ['focus', '默认聚焦'],
        ['today', '仅今日'],
        ['overdue', '历史延期'],
        ['open', '全部待办'],
        ['done', '已完成'],
      ];
      for (const [sk, sl] of scopes) {
        const p = el('button', `ch-pill ${state.execQuickScope === sk ? 'is-active' : ''}`, `${sl} ${counts[sk]}`);
        p.addEventListener('click', () => {
          state.execQuickScope = sk;
          renderTaskBody();
        });
        pillsContainer.appendChild(p);
      }
      if (state.selectedDate) {
        const chip = el('button', 'ch-pill is-active', `日期: ${state.selectedDate} ×`);
        chip.addEventListener('click', () => {
          state.selectedDate = '';
          void onSwitchJournalDate(today, false);
        });
        pillsContainer.appendChild(chip);
      }

      let scoped = [];
      if (state.selectedDate) {
        scoped = baseList.filter((t) => settings.showCompletedTasks || state.execQuickScope === 'done' || t.bucket !== 'done');
      } else if (state.execQuickScope === 'focus') {
        scoped = baseList.filter(isFocusMatch);
      } else if (state.execQuickScope === 'today') {
        scoped = baseList.filter(isTodayMatch);
      } else if (state.execQuickScope === 'overdue') {
        scoped = baseList.filter(isOverdueMatch);
      } else if (state.execQuickScope === 'open') {
        scoped = baseList.filter(isOpenMatch);
      } else if (state.execQuickScope === 'done') {
        scoped = baseList.filter(isDoneMatch);
      }

      activeCountBadge.textContent = `${scoped.length} 项`;
      mdScope.reset();
      bodyContainer.replaceChildren();

      if (settings.taskLayout === 'kanban') {
        const cols = [
          { key: 'doing', title: 'DOING', filter: (t) => t.bucket === 'doing', dropKeyword: 'DOING' },
          { key: 'todo', title: 'TODO', filter: (t) => t.bucket === 'todo', dropKeyword: 'TODO' },
        ];
        if (settings.showCompletedTasks || state.execQuickScope === 'done') {
          cols.push({ key: 'done', title: 'DONE', filter: (t) => t.bucket === 'done', dropKeyword: 'DONE' });
        }

        const board = el('div', `ch-kanban-grid ${cols.length === 3 ? 'cols-3' : 'cols-2'}`);
        for (const col of cols) {
          const colItems = scoped.filter(col.filter);
          colItems.sort((a, b) => b.date.localeCompare(a.date) || a.lineNumber - b.lineNumber);

          const colEl = el('div', 'ch-kanban-col');
          colEl.dataset.col = col.key;
          const colHead = el('div', 'ch-kanban-col-head');
          colHead.appendChild(el('span', '', col.title));
          colHead.appendChild(el('span', 'ch-count-muted', String(colItems.length)));
          colEl.appendChild(colHead);

          colEl.addEventListener('dragover', (e) => {
            e.preventDefault();
            colEl.classList.add('is-drag-over');
          });
          colEl.addEventListener('dragleave', () => colEl.classList.remove('is-drag-over'));
          colEl.addEventListener('drop', async (e) => {
            e.preventDefault();
            colEl.classList.remove('is-drag-over');
            const id = e.dataTransfer?.getData('text/plain');
            const task = state.execTasks.find((x) => x.id === id);
            if (!task) return;
            await store.actions?.updateExecutionTaskKeyword(task, col.dropKeyword);
          });

          const listEl = el('div', 'ch-kanban-list');
          if (colItems.length === 0) {
            listEl.appendChild(el('div', 'ch-empty', '暂无任务'));
          } else {
            for (const t of colItems.slice(0, 60)) {
              listEl.appendChild(renderExecTaskCard(t, today, renderTaskBody));
            }
            if (colItems.length > 60) {
              listEl.appendChild(el('div', 'ch-empty', `仅显示前 60 项（共 ${colItems.length} 项，可用筛选缩小范围）`));
            }
          }
          colEl.appendChild(listEl);

          if (col.key !== 'done') {
            const addBtn = el('button', 'ch-col-add-btn', '+');
            addBtn.title = `在今日执行新建 ${col.title} 任务`;
            addBtn.addEventListener('click', () =>
              modals.openNewExecutionTaskModal({ keyword: col.key === 'doing' ? 'DOING' : 'TODO' })
            );
            colEl.appendChild(addBtn);
          }
          board.appendChild(colEl);
        }
        bodyContainer.appendChild(board);
      } else {
        const listWrap = el('div', 'ch-agenda-list');
        if (scoped.length === 0) {
          listWrap.appendChild(el('div', 'ch-empty', '当前筛选条件下暂无今日执行任务'));
        } else {
          const buckets = [
            { title: '进行中 (DOING)', items: [] },
            { title: '今日待办 (TODO)', items: [] },
            { title: '历史未完成', items: [] },
            { title: '已完成 (DONE)', items: [] },
          ];
          for (const t of scoped) {
            if (t.bucket === 'done') buckets[3].items.push(t);
            else if (t.bucket === 'doing' && t.date >= today) buckets[0].items.push(t);
            else if (t.date < today) buckets[2].items.push(t);
            else buckets[1].items.push(t);
          }
          for (const b of buckets) {
            if (b.items.length === 0) continue;
            b.items.sort((a, b2) => b2.date.localeCompare(a.date) || a.lineNumber - b2.lineNumber);
            const gHead = el('div', 'ch-agenda-group-head');
            gHead.appendChild(el('span', '', b.title));
            gHead.appendChild(el('span', '', `${b.items.length}`));
            listWrap.appendChild(gHead);
            for (const t of b.items.slice(0, 60)) {
              listWrap.appendChild(renderExecTaskCard(t, today, renderTaskBody));
            }
            if (b.items.length > 60) {
              listWrap.appendChild(el('div', 'ch-empty', `${b.title}仅显示前 60 项（共 ${b.items.length} 项）`));
            }
          }
        }
        bodyContainer.appendChild(listWrap);
      }
    });
  }

  function buildCardShell() {
    const settings = getSettings();
    const state = store.state;
    tasksSlot.replaceChildren();
    densButtons = new Map();
    layButtons = new Map();
    actorButtons = new Map();

    const card = el('div', 'ch-card');

    const head = el('div', 'ch-card-head');
    const titleWrap = el('div', 'ch-card-title-wrap');
    titleWrap.appendChild(el('span', 'ch-card-accent-bar'));
    titleWrap.appendChild(el('h3', 'ch-card-title', '任务工作区'));
    activeCountBadge = el('span', 'ch-count-muted', '');
    titleWrap.appendChild(activeCountBadge);
    head.appendChild(titleWrap);

    const headRight = el('div', 'ch-util-right');

    const densSeg = el('div', 'ch-seg-tabs');
    for (const [dk, dl] of [['large', '大'], ['medium', '中'], ['small', '小']]) {
      const b = el('button', `ch-seg-tab ${settings.taskDensity === dk ? 'is-active' : ''}`, dl);
      b.addEventListener('click', () => {
        updateSettings({ taskDensity: dk }, { skipModuleRefresh: true, applyTheme: true });
        syncToolbarControls();
      });
      densButtons.set(dk, b);
      densSeg.appendChild(b);
    }
    headRight.appendChild(densSeg);

    const doneLabel = el('label', 'ch-mini-pill-btn');
    doneLabel.style.display = 'inline-flex';
    doneLabel.style.alignItems = 'center';
    doneLabel.style.gap = '4px';
    doneCheckbox = document.createElement('input');
    doneCheckbox.type = 'checkbox';
    doneCheckbox.checked = Boolean(settings.showCompletedTasks);
    doneCheckbox.addEventListener('change', () => {
      updateSettings({ showCompletedTasks: doneCheckbox.checked }, { skipModuleRefresh: true });
      renderTaskBody();
    });
    doneLabel.appendChild(doneCheckbox);
    doneLabel.appendChild(document.createTextNode('显示已完成'));
    headRight.appendChild(doneLabel);

    const laySeg = el('div', 'ch-seg-tabs');
    for (const [lk, ll] of [['kanban', '看板'], ['list', '清单']]) {
      const b = el('button', `ch-seg-tab ${settings.taskLayout === lk ? 'is-active' : ''}`, ll);
      b.addEventListener('click', () => {
        updateSettings({ taskLayout: lk }, { skipModuleRefresh: true });
        syncToolbarControls();
        renderTaskBody();
      });
      layButtons.set(lk, b);
      laySeg.appendChild(b);
    }
    headRight.appendChild(laySeg);

    const addTaskBtn = el('button', 'ch-mini-pill-btn is-active', '+ 新建任务');
    addTaskBtn.addEventListener('click', () => modals.openNewExecutionTaskModal({}));
    headRight.appendChild(addTaskBtn);
    head.appendChild(headRight);
    card.appendChild(head);

    const filterRow = el('div', 'ch-toolbar-row');
    const fg = el('div', 'ch-filter-group');

    kwInput = el('input', 'ch-input');
    kwInput.placeholder = '搜索今日执行任务…';
    kwInput.value = state.execKeyword;
    kwInput.style.minWidth = '180px';
    kwInput.style.flex = '1';
    kwInput.addEventListener('input', () => {
      state.execKeyword = kwInput.value;
      renderTaskBody();
    });

    const actorSeg = el('div', 'ch-seg-tabs');
    for (const [ak, al] of [['all', '全部'], ['human', '仅人工'], ['ai', '仅 🤖 AI']]) {
      const b = el('button', `ch-seg-tab ${state.execActorFilter === ak ? 'is-active' : ''}`, al);
      b.addEventListener('click', () => {
        state.execActorFilter = ak;
        syncToolbarControls();
        renderTaskBody();
      });
      actorButtons.set(ak, b);
      actorSeg.appendChild(b);
    }

    fg.appendChild(kwInput);
    fg.appendChild(actorSeg);
    filterRow.appendChild(fg);
    card.appendChild(filterRow);

    pillsContainer = el('div', 'ch-pills-row');
    card.appendChild(pillsContainer);

    bodyContainer = el('div', '');
    card.appendChild(bodyContainer);

    tasksSlot.appendChild(card);
    cardBuilt = true;
  }

  function update() {
    const settings = getSettings();
    if (!settings.showTasks) {
      mdScope.reset();
      tasksSlot.replaceChildren();
      tasksSlot.style.display = 'none';
      cardBuilt = false;
      activeCountBadge = null;
      pillsContainer = null;
      bodyContainer = null;
      return;
    }
    tasksSlot.style.display = '';
    if (!cardBuilt) {
      buildCardShell();
    } else {
      syncToolbarControls();
    }
    renderTaskBody();
  }

  return {
    update,
    renderTaskBody,
    cleanup: () => mdScope.destroy(),
  };
}

module.exports = {
  createTasksCardSection,
};
