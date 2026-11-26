'use strict';

const { CN_WEEKDAYS } = require('../constants');
const {
  pad2,
  formatDateYMD,
  parseYMD,
  addDaysYMD,
  getIsoWeekInfo,
  getGreeting,
  formatRelativeTime,
} = require('../utils/date');
const { el, setIconSafe, preserveScroll } = require('../utils/dom');
const { openFileAtLine } = require('../services/vault-adapter');

function createLeftColumnSection({
  app,
  obsidian,
  store,
  modals,
  getSettings,
  getScrollEl,
  updateSettings,
  onSwitchJournalDate,
  leftColSlot,
}) {
  const leftCol = el('div', 'ch-left-col');
  const clockSlot = el('div', 'ch-left-slot');
  const calendarSlot = el('div', 'ch-left-slot');
  const bookmarksSlot = el('div', 'ch-left-slot');
  const recentSlot = el('div', 'ch-left-slot');
  leftCol.appendChild(clockSlot);
  leftCol.appendChild(calendarSlot);
  leftCol.appendChild(bookmarksSlot);
  leftCol.appendChild(recentSlot);
  leftColSlot.appendChild(leftCol);

  let clockTimeEl = null;
  let clockGreetEl = null;
  let clockDateEl = null;

  function updateClockDigits() {
    if (!clockTimeEl) return;
    const now = new Date();
    clockTimeEl.textContent = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    if (clockGreetEl) clockGreetEl.textContent = getGreeting(now.getHours());
    if (clockDateEl) {
      const todayYmd = formatDateYMD(now);
      const weekInfo = getIsoWeekInfo(todayYmd);
      clockDateEl.textContent = `${todayYmd} · 周${CN_WEEKDAYS[now.getDay()]} · ${weekInfo.weekTitle}`;
    }
  }

  function updateClock() {
    const settings = getSettings();
    clockSlot.replaceChildren();
    if (!settings.showClock) {
      clockSlot.style.display = 'none';
      clockGreetEl = null;
      clockTimeEl = null;
      clockDateEl = null;
      return;
    }
    clockSlot.style.display = '';
    const card = el('div', 'ch-card ch-clock-card');
    clockGreetEl = el('div', 'ch-clock-greeting', '');
    clockTimeEl = el('div', 'ch-clock-time', '');
    clockDateEl = el('div', 'ch-clock-date', '');
    card.appendChild(clockGreetEl);
    card.appendChild(clockTimeEl);
    card.appendChild(clockDateEl);
    updateClockDigits();
    clockSlot.appendChild(card);
  }

  function updateCalendar() {
    const settings = getSettings();
    const state = store.state;
    const today = formatDateYMD(new Date());

    preserveScroll(getScrollEl(), () => {
      calendarSlot.replaceChildren();
      if (!settings.showCalendar) {
        calendarSlot.style.display = 'none';
        return;
      }
      calendarSlot.style.display = '';

      const card = el('div', 'ch-card');
      const head = el('div', 'ch-card-head');
      const titleWrap = el('div', 'ch-card-title-wrap');
      titleWrap.appendChild(el('span', 'ch-card-accent-bar'));
      titleWrap.appendChild(el('h3', 'ch-card-title', '日历'));
      head.appendChild(titleWrap);
      const openTodayBtn = el('button', 'ch-mini-pill-btn', '今日日注');
      openTodayBtn.addEventListener('click', () => store.actions?.openOrCreateDailyNote(state.selectedDate || today));
      head.appendChild(openTodayBtn);
      card.appendChild(head);

      const taskDayStatus = new Map();
      for (const t of state.execTasks) {
        if (t.bucket !== 'todo' && t.bucket !== 'doing') continue;
        const prev = taskDayStatus.get(t.date);
        const isOver = t.date < today;
        if (isOver || prev === 'overdue') taskDayStatus.set(t.date, 'overdue');
        else taskDayStatus.set(t.date, 'task');
      }

      const cursorDt = parseYMD(state.calCursorYMD) || new Date();
      const nav = el('div', 'ch-cal-nav');
      const navLeft = el('div', 'ch-cal-nav-left');
      const prevM = el('button', 'ch-mini-pill-btn', '‹');
      const todayBtn = el('button', 'ch-mini-pill-btn', '今天');
      const nextM = el('button', 'ch-mini-pill-btn', '›');
      prevM.addEventListener('click', () => {
        const d = new Date(cursorDt);
        if (state.calMode === 'month') d.setMonth(d.getMonth() - 1);
        else if (state.calMode === 'week') d.setDate(d.getDate() - 7);
        else d.setDate(d.getDate() - 1);
        state.calCursorYMD = formatDateYMD(d);
        updateCalendar();
      });
      todayBtn.addEventListener('click', () => {
        state.calCursorYMD = today;
        updateCalendar();
      });
      nextM.addEventListener('click', () => {
        const d = new Date(cursorDt);
        if (state.calMode === 'month') d.setMonth(d.getMonth() + 1);
        else if (state.calMode === 'week') d.setDate(d.getDate() + 7);
        else d.setDate(d.getDate() + 1);
        state.calCursorYMD = formatDateYMD(d);
        updateCalendar();
      });
      navLeft.appendChild(prevM);
      navLeft.appendChild(todayBtn);
      navLeft.appendChild(nextM);
      nav.appendChild(navLeft);
      nav.appendChild(el('span', '', `${cursorDt.getFullYear()}年 ${cursorDt.getMonth() + 1}月`));
      card.appendChild(nav);

      const seg = el('div', 'ch-seg-tabs');
      for (const [mode, lbl] of [['month', '月'], ['week', '周'], ['day', '日']]) {
        const b = el('button', `ch-seg-tab ${state.calMode === mode ? 'is-active' : ''}`, lbl);
        b.addEventListener('click', () => {
          state.calMode = mode;
          updateCalendar();
        });
        seg.appendChild(b);
      }
      card.appendChild(seg);

      if (state.calMode === 'day') {
        const dayStr = state.selectedDate || state.calCursorYMD;
        const dayTasks = state.execTasks.filter(
          (t) => t.bucket !== 'cancelled' && t.date === dayStr
        );
        const dayBox = el('div', 'ch-item-list');
        if (dayTasks.length === 0) {
          dayBox.appendChild(el('div', 'ch-empty', `${dayStr} 今日执行暂无任务`));
        } else {
          for (const t of dayTasks.slice(0, 8)) {
            const row = el('div', 'ch-list-row');
            row.appendChild(el('span', 'ch-list-row-text', `${t.bucket === 'done' ? '✓ ' : `${t.keyword} `}${t.title}`));
            row.addEventListener('click', () => openFileAtLine(app, t.filePath, t.lineNumber));
            dayBox.appendChild(row);
          }
        }
        card.appendChild(dayBox);
      } else {
        const wds = el('div', 'ch-cal-weekdays');
        for (const w of ['一', '二', '三', '四', '五', '六', '日']) {
          wds.appendChild(el('div', 'ch-cal-wd', w));
        }
        card.appendChild(wds);

        const grid = el('div', 'ch-cal-grid');
        const cells = [];
        if (state.calMode === 'week') {
          const wk = getIsoWeekInfo(state.calCursorYMD);
          for (let i = 0; i < 7; i++) {
            const dStr = addDaysYMD(wk.weekStart, i);
            cells.push({ dateStr: dStr, dt: parseYMD(dStr), otherMonth: false });
          }
        } else {
          const firstOfMonth = new Date(cursorDt.getFullYear(), cursorDt.getMonth(), 1);
          const startOffset = (firstOfMonth.getDay() + 6) % 7;
          const startDt = new Date(firstOfMonth);
          startDt.setDate(startDt.getDate() - startOffset);
          for (let i = 0; i < 42; i++) {
            const d = new Date(startDt);
            d.setDate(startDt.getDate() + i);
            cells.push({
              dateStr: formatDateYMD(d),
              dt: d,
              otherMonth: d.getMonth() !== cursorDt.getMonth(),
            });
          }
        }

        for (const c of cells) {
          const cell = el('button', 'ch-cal-cell');
          if (c.otherMonth) cell.classList.add('is-other-month');
          if (c.dateStr === today) cell.classList.add('is-today');
          if (c.dateStr === state.selectedDate) cell.classList.add('is-selected');
          cell.appendChild(el('span', '', c.dt.getDate()));
          const dots = el('div', 'ch-cal-dots');
          if (state.dailyFilesSet.has(c.dateStr)) {
            dots.appendChild(el('span', 'ch-cal-dot is-daily'));
          }
          const tStat = taskDayStatus.get(c.dateStr);
          if (tStat) {
            dots.appendChild(el('span', `ch-cal-dot ${tStat === 'overdue' ? 'is-overdue' : 'is-task'}`));
          }
          cell.appendChild(dots);
          cell.title = `${c.dateStr}（单击联动日志与任务 · 双击打开日注）`;
          cell.addEventListener('click', () => {
            const nextSel = state.selectedDate === c.dateStr ? '' : c.dateStr;
            state.selectedDate = nextSel;
            state.calCursorYMD = c.dateStr;
            void onSwitchJournalDate(nextSel || today, false);
          });
          cell.addEventListener('dblclick', () => store.actions?.openOrCreateDailyNote(c.dateStr));
          grid.appendChild(cell);
        }
        card.appendChild(grid);
      }

      if (state.selectedDate) {
        const selBar = el('div', 'ch-cal-selected-bar');
        selBar.appendChild(el('span', '', `已选：${state.selectedDate}`));
        const ops = el('div', '');
        ops.style.display = 'flex';
        ops.style.gap = '4px';
        const openBtn = el('button', 'ch-mini-pill-btn', '打开');
        openBtn.addEventListener('click', () => store.actions?.openOrCreateDailyNote(state.selectedDate));
        const clrBtn = el('button', 'ch-mini-pill-btn', '清除');
        clrBtn.addEventListener('click', () => {
          state.selectedDate = '';
          void onSwitchJournalDate(today, false);
        });
        ops.appendChild(openBtn);
        ops.appendChild(clrBtn);
        selBar.appendChild(ops);
        card.appendChild(selBar);
      }
      calendarSlot.appendChild(card);
    });
  }

  function updateBookmarks() {
    const settings = getSettings();
    const state = store.state;

    preserveScroll(getScrollEl(), () => {
      bookmarksSlot.replaceChildren();
      if (!settings.showBookmarks) {
        bookmarksSlot.style.display = 'none';
        return;
      }
      bookmarksSlot.style.display = '';

      const card = el('div', 'ch-card');
      const head = el('div', 'ch-card-head');
      const titleWrap = el('div', 'ch-card-title-wrap');
      titleWrap.appendChild(el('span', 'ch-card-accent-bar'));
      titleWrap.appendChild(el('h3', 'ch-card-title', '书签'));
      head.appendChild(titleWrap);
      const addPinBtn = el('button', 'ch-mini-pill-btn', '+ 添加');
      addPinBtn.addEventListener('click', modals.openAddPinModal);
      head.appendChild(addPinBtn);
      card.appendChild(head);

      const list = el('div', 'ch-item-list');
      list.appendChild(el('div', 'ch-sub-section-label', '工作台常用入口'));
      for (const pin of settings.pinnedEntries) {
        const row = el('div', 'ch-list-row');
        const left = el('div', 'ch-list-row-left');
        const ico = el('span', '');
        ico.style.display = 'inline-flex';
        setIconSafe(obsidian, ico, pin.icon || 'bookmark', '★');
        left.appendChild(ico);
        left.appendChild(el('span', 'ch-list-row-text', pin.label));
        row.appendChild(left);

        const del = el('button', 'ch-list-row-del', '×');
        del.title = '移除入口';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          const next = getSettings().pinnedEntries.filter((x) => x.id !== pin.id);
          updateSettings({ pinnedEntries: next });
        });
        row.appendChild(del);
        row.addEventListener('click', () => store.actions?.triggerPinnedEntry(pin));
        list.appendChild(row);
      }

      if (state.obsidianBookmarks.length > 0) {
        list.appendChild(el('div', 'ch-sub-section-label', 'Obsidian 原生书签'));
        for (const bm of state.obsidianBookmarks.slice(0, 12)) {
          const row = el('div', 'ch-list-row');
          const left = el('div', 'ch-list-row-left');
          const ico = el('span', '');
          ico.style.display = 'inline-flex';
          setIconSafe(obsidian, ico, bm.type === 'search' ? 'search' : 'bookmark', '🔖');
          left.appendChild(ico);
          left.appendChild(el('span', 'ch-list-row-text', bm.title));
          row.appendChild(left);
          row.addEventListener('click', () => {
            if (bm.path) {
              app.workspace.openLinkText(bm.subpath ? `${bm.path}${bm.subpath}` : bm.path, '', false);
            } else if (bm.query) {
              app.internalPlugins?.plugins?.['global-search']?.instance?.openGlobalSearch?.(bm.query);
            }
          });
          list.appendChild(row);
        }
      }
      card.appendChild(list);
      bookmarksSlot.appendChild(card);
    });
  }

  function updateRecent() {
    const settings = getSettings();
    const state = store.state;

    preserveScroll(getScrollEl(), () => {
      recentSlot.replaceChildren();
      if (!settings.showRecent) {
        recentSlot.style.display = 'none';
        return;
      }
      recentSlot.style.display = '';

      const card = el('div', 'ch-card');
      const head = el('div', 'ch-card-head');
      const titleWrap = el('div', 'ch-card-title-wrap');
      titleWrap.appendChild(el('span', 'ch-card-accent-bar'));
      titleWrap.appendChild(el('h3', 'ch-card-title', '最近笔记'));
      head.appendChild(titleWrap);
      card.appendChild(head);

      const list = el('div', 'ch-item-list');
      const nowMs = Date.now();
      const recent = state.recentNotes.slice(0, settings.recentCount);
      if (recent.length === 0) {
        list.appendChild(el('div', 'ch-empty', '暂无最近笔记'));
      } else {
        for (const note of recent) {
          const row = el('div', 'ch-list-row');
          const left = el('div', 'ch-list-row-left');
          const ico = el('span', '');
          ico.style.display = 'inline-flex';
          setIconSafe(obsidian, ico, 'file-text', '📄');
          left.appendChild(ico);
          left.appendChild(el('span', 'ch-list-row-text', note.title));
          row.appendChild(left);
          row.appendChild(el('span', 'ch-count-muted', formatRelativeTime(note.mtime, nowMs)));
          row.title = note.path;
          row.addEventListener('click', () => openFileAtLine(app, note.path));
          list.appendChild(row);
        }
      }
      card.appendChild(list);
      recentSlot.appendChild(card);
    });
  }

  function updateAll() {
    updateClock();
    updateCalendar();
    updateBookmarks();
    updateRecent();
  }

  return {
    updateClockDigits,
    updateClock,
    updateCalendar,
    updateBookmarks,
    updateRecent,
    updateAll,
  };
}

module.exports = {
  createLeftColumnSection,
};
