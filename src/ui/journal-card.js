'use strict';

const { DAY_PERIODS, CN_WEEKDAYS } = require('../constants');
const { formatDateYMD, parseYMD, addDaysYMD, pickDefaultJournalPeriod } = require('../utils/date');
const { el, preserveScroll } = require('../utils/dom');
const { createMarkdownRenderScope } = require('../utils/markdown-render');
const { ensureNoteFromTemplate, openFileAtLine } = require('../services/vault-adapter');
const { renderExpandableChildren } = require('./expandable');

function createJournalCardSection({
  app,
  store,
  getSettings,
  getScrollEl,
  onSwitchJournalDate,
  onRefreshPaths,
  journalSlot,
}) {
  const contentMdScope = createMarkdownRenderScope();

  function update() {
    const settings = getSettings();
    const state = store.state;
    const today = formatDateYMD(new Date());
    const journal = state.journalData;

    preserveScroll(getScrollEl(), () => {
      contentMdScope.reset();
      journalSlot.replaceChildren();
      if (!settings.showJournal) {
        journalSlot.style.display = 'none';
        return;
      }
      journalSlot.style.display = '';

      if (!DAY_PERIODS.some((p) => p.title === state.journalPeriod)) {
        state.journalPeriod = pickDefaultJournalPeriod(journal, state.journalDate, today, new Date().getHours());
      }

      const card = el('div', 'ch-card');
      const head = el('div', 'ch-card-head ch-journal-head');
      const titleWrap = el('div', 'ch-card-title-wrap');
      titleWrap.appendChild(el('span', 'ch-card-accent-bar'));
      titleWrap.appendChild(el('h3', 'ch-card-title', '日注'));

      const periodBar = el('div', 'ch-period-bar');
      const periodButtons = new Map();
      const bodyMount = el('div', '');

      function syncPeriodBarActive() {
        for (const [key, b] of periodButtons.entries()) {
          b.classList.toggle('is-active', state.journalPeriod === key);
        }
      }

      for (const p of DAY_PERIODS) {
        const hasEntries = (journal.periods[p.title] || []).length > 0;
        const btn = el('button', `ch-period-btn ${state.journalPeriod === p.title ? 'is-active' : ''}`);
        btn.appendChild(el('span', 'ch-period-name', p.title));
        if (hasEntries) {
          btn.appendChild(el('span', 'ch-period-dot'));
        }
        btn.addEventListener('click', () => {
          state.journalPeriod = p.title;
          syncPeriodBarActive();
          renderJournalContent();
        });
        periodButtons.set(p.title, btn);
        periodBar.appendChild(btn);
      }
      titleWrap.appendChild(periodBar);
      head.appendChild(titleWrap);

      const headRight = el('div', 'ch-util-right');

      const prevDayBtn = el('button', 'ch-mini-pill-btn', '‹');
      prevDayBtn.title = '前一天日志';
      prevDayBtn.addEventListener('click', () => onSwitchJournalDate(addDaysYMD(state.journalDate, -1), true));
      headRight.appendChild(prevDayBtn);

      if (state.journalDate !== today) {
        const jDt = parseYMD(state.journalDate) || new Date();
        const wdLabel = `周${CN_WEEKDAYS[jDt.getDay()]}`;
        headRight.appendChild(el('span', 'ch-badge-pill', `${state.journalDate} (${wdLabel})`));
      }

      const nextDayBtn = el('button', 'ch-mini-pill-btn', '›');
      nextDayBtn.title = '后一天日志';
      nextDayBtn.addEventListener('click', () => onSwitchJournalDate(addDaysYMD(state.journalDate, 1), true));
      headRight.appendChild(nextDayBtn);

      if (state.journalDate !== today) {
        const backTodayBtn = el('button', 'ch-mini-pill-btn', '今天');
        backTodayBtn.addEventListener('click', () => onSwitchJournalDate(today, true));
        headRight.appendChild(backTodayBtn);
      }

      const openNoteBtn = el('button', 'ch-mini-pill-btn is-active', '打开日注');
      openNoteBtn.addEventListener('click', () => store.actions?.openOrCreateDailyNote(state.journalDate));
      headRight.appendChild(openNoteBtn);

      head.appendChild(headRight);
      card.appendChild(head);

      function renderTimelineEntry(entry) {
        const itemEl = el('div', 'ch-tl-item');

        const timeCol = el('div', 'ch-tl-time-col');
        const dot = el('span', `ch-tl-dot kind-${entry.kind}`);
        timeCol.appendChild(dot);

        const timeBtn = el('button', 'ch-tl-time-btn', entry.timeLabel);
        timeBtn.title = `点击跳转 ${journal.filePath} 第 ${entry.lineNumber + 1} 行`;
        timeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openFileAtLine(app, journal.filePath, entry.lineNumber);
        });
        timeCol.appendChild(timeBtn);
        itemEl.appendChild(timeCol);

        const hasChildren = entry.children && entry.children.length > 0;
        const tlCard = el('div', `ch-tl-card ${hasChildren ? 'has-children' : ''}`);
        const headRow = el('div', 'ch-tl-head-row');

        if (entry.isCheckbox) {
          const cb = el(
            'button',
            `ch-checkbox ${entry.kind === 'done' ? 'is-done' : entry.kind === 'doing' ? 'is-doing' : ''}`
          );
          cb.textContent = entry.kind === 'done' ? '✓' : entry.kind === 'doing' ? '/' : '';
          cb.title = entry.kind === 'done' ? '标记为待办' : '标记为已完成';
          cb.addEventListener('click', (e) => {
            e.stopPropagation();
            void store.actions?.writeTaskLinePatch(
              { filePath: journal.filePath, lineNumber: entry.lineNumber, rawLine: entry.rawLine },
              entry.kind === 'done' ? { statusChar: ' ', doneDate: null } : { statusChar: 'x', doneDate: today }
            );
          });
          headRow.appendChild(cb);
        } else if (entry.badge || entry.hasRobot) {
          const badgeText = `${entry.hasRobot ? '🤖 ' : ''}${entry.badge || ''}`.trim();
          if (badgeText) {
            headRow.classList.add('has-badge');
            headRow.appendChild(el('span', `ch-tl-badge kind-${entry.kind}`, badgeText));
          }
        }

        const bodyEl = el('div', `ch-tl-body ${entry.kind === 'done' && entry.isCheckbox ? 'is-done' : ''}`);
        const mdHost = el('div', 'ch-md-host');
        void contentMdScope.render({
          app,
          container: mdHost,
          markdown: entry.bodyText,
          sourcePath: journal.filePath,
          fallbackTokens: entry.tokens,
        });
        bodyEl.appendChild(mdHost);
        if (entry.dateChips && entry.dateChips.length > 0) {
          for (const dc of entry.dateChips) {
            bodyEl.appendChild(document.createTextNode(' '));
            bodyEl.appendChild(el('span', 'ch-tag-chip', dc));
          }
        }
        headRow.appendChild(bodyEl);
        tlCard.appendChild(headRow);

        renderExpandableChildren({
          hostEl: tlCard,
          entryKey: entry.key,
          children: entry.children,
          childrenMeta: entry.childrenMeta,
          expandMap: state.journalExpandState,
          app,
          mdScope: contentMdScope,
          sourcePath: journal.filePath,
          onToggle: renderJournalContent,
          collapsedPrefix: '▸ 展开 ',
          bindHostClick: true,
          indentPlainChildren: true,
        });

        itemEl.appendChild(tlCard);
        return itemEl;
      }

      function renderJournalContent() {
        preserveScroll(getScrollEl(), () => {
          contentMdScope.reset();
          bodyMount.replaceChildren();

          if (!journal.exists) {
            const emptyBox = el('div', 'ch-empty');
            emptyBox.style.display = 'flex';
            emptyBox.style.flexDirection = 'column';
            emptyBox.style.alignItems = 'center';
            emptyBox.style.gap = '10px';
            emptyBox.style.padding = '18px 12px';
            emptyBox.appendChild(el('span', '', `${state.journalDate} 尚未创建日注`));
            const createBtn = el('button', 'ch-btn is-primary', `一键创建 ${state.journalDate} 日注`);
            createBtn.addEventListener('click', async () => {
              const targetPath = `06_日志/${state.journalDate}.md`;
              await ensureNoteFromTemplate(app, targetPath, '02_模版/日志.md', 'daily', state.journalDate);
              if (onRefreshPaths) await onRefreshPaths([targetPath]);
            });
            emptyBox.appendChild(createBtn);
            bodyMount.appendChild(emptyBox);
            return;
          }

          const panel = el('div', 'ch-timeline-panel');
          const entries = journal.periods[state.journalPeriod] || [];
          if (entries.length === 0) {
            const emptyWrap = el('div', 'ch-empty');
            emptyWrap.style.display = 'flex';
            emptyWrap.style.flexDirection = 'column';
            emptyWrap.style.alignItems = 'center';
            emptyWrap.style.gap = '8px';
            emptyWrap.appendChild(el('span', '', `${state.journalDate}「${state.journalPeriod}」时段暂无记录`));
            const nonEmpty = DAY_PERIODS.filter((p) => journal.periods[p.title].length > 0);
            if (nonEmpty.length > 0) {
              const hints = el('div', 'ch-pills-row');
              hints.style.justifyContent = 'center';
              hints.appendChild(el('span', 'ch-count-muted', '当天其他时段有记录：'));
              for (const np of nonEmpty) {
                const chip = el('button', 'ch-mini-pill-btn', np.title);
                chip.addEventListener('click', () => {
                  state.journalPeriod = np.title;
                  syncPeriodBarActive();
                  renderJournalContent();
                });
                hints.appendChild(chip);
              }
              emptyWrap.appendChild(hints);
            }
            panel.appendChild(emptyWrap);
          } else {
            const pHead = el('div', 'ch-tl-period-head');
            pHead.appendChild(el('span', '', `## ${state.journalPeriod}`));
            pHead.appendChild(el('span', '', `${entries.length} 条 · 点击打开标题行`));
            pHead.addEventListener('click', () => {
              const ln = journal.periodLineNumbers[state.journalPeriod];
              openFileAtLine(app, journal.filePath, ln >= 0 ? ln : undefined);
            });
            panel.appendChild(pHead);

            const list = el('div', 'ch-tl-list');
            for (const entry of entries) list.appendChild(renderTimelineEntry(entry));
            panel.appendChild(list);
          }

          bodyMount.appendChild(panel);
        });
      }

      renderJournalContent();
      card.appendChild(bodyMount);
      journalSlot.appendChild(card);
    });
  }

  return {
    update,
    cleanup: () => contentMdScope.destroy(),
  };
}

module.exports = {
  createJournalCardSection,
};
