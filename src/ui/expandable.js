'use strict';

const { el, renderTokensInto } = require('../utils/dom');
const { hasActiveTextSelection, isInteractiveMarkdownTarget } = require('../utils/markdown-render');

function renderExpandableChildren({
  hostEl,
  entryKey,
  children,
  childrenMeta,
  expandMap,
  app,
  mdScope,
  sourcePath,
  onToggle,
  collapsedPrefix = '▸ ',
  bindHostClick = false,
  indentPlainChildren = false,
}) {
  if (!children || children.length === 0 || !childrenMeta) return;
  const level = expandMap.get(entryKey) || 0;

  const foldBar = el('div', 'ch-tl-fold-bar');
  foldBar.appendChild(
    el(
      'span',
      '',
      level === 0
        ? `${collapsedPrefix}${childrenMeta.totalCount} 条子记录${childrenMeta.clockPreview ? ` · ${childrenMeta.clockPreview}` : ''}`
        : `▾ 收起子记录 (${childrenMeta.totalCount})`
    )
  );
  if (level === 0 && childrenMeta.goalPreview) {
    foldBar.appendChild(el('span', 'ch-tl-fold-preview', `🎯 ${childrenMeta.goalPreview}`));
  }
  foldBar.addEventListener('click', (e) => {
    e.stopPropagation();
    expandMap.set(entryKey, level === 0 ? 1 : 0);
    if (onToggle) onToggle();
  });
  if (bindHostClick) {
    hostEl.addEventListener('click', (e) => {
      if (hasActiveTextSelection() || isInteractiveMarkdownTarget(e?.target)) return;
      expandMap.set(entryKey, level === 0 ? 1 : 0);
      if (onToggle) onToggle();
    });
  }
  hostEl.appendChild(foldBar);

  if (level < 1) return;

  const childBox = el('div', 'ch-tl-children');
  childBox.addEventListener('click', (e) => e.stopPropagation());
  const renderChildInto = (rowEl, item) => {
    if (mdScope) {
      void mdScope.render({
        app,
        container: rowEl,
        markdown: item.text,
        sourcePath: sourcePath || '',
        fallbackTokens: item.tokens,
      });
    } else {
      renderTokensInto(rowEl, item.tokens, app);
    }
  };
  const appendChildRow = (child) => {
    const rowCls =
      child.kind === 'goal'
        ? 'is-goal'
        : child.kind === 'summary'
        ? 'is-summary'
        : child.kind === 'clock'
        ? 'is-clock'
        : '';
    const cRow = el('div', `ch-tl-child-row ${rowCls}`);
    if (indentPlainChildren && child.depth > 1 && !childrenMeta.isAgentSession) {
      cRow.style.paddingLeft = `${(child.depth - 1) * 14 + 4}px`;
    }
    renderChildInto(cRow, child);
    childBox.appendChild(cRow);
  };

  if (childrenMeta.isAgentSession) {
    for (const sItem of childrenMeta.summaryItems) appendChildRow(sItem);
    for (const pItem of childrenMeta.plainItems) appendChildRow(pItem);

    const turnsToShow = level === 1 ? childrenMeta.turnItems.slice(0, 3) : childrenMeta.turnItems;
    if (turnsToShow.length > 0) {
      const turnsWrap = el('div', level >= 2 ? 'ch-tl-turns-scroll' : '');
      turnsWrap.style.display = 'flex';
      turnsWrap.style.flexDirection = 'column';
      turnsWrap.style.gap = '4px';
      for (const tItem of turnsToShow) {
        const cRow = el('div', 'ch-tl-child-row');
        renderChildInto(cRow, tItem);
        turnsWrap.appendChild(cRow);
      }
      childBox.appendChild(turnsWrap);
    }

    if (childrenMeta.hiddenTurnCount > 0) {
      const moreBtn = el(
        'button',
        'ch-tl-more-btn',
        level === 1
          ? `展开全部 ${childrenMeta.turnItems.length} 轮对话（还有 ${childrenMeta.hiddenTurnCount} 轮）`
          : '仅看摘要与最近 3 轮'
      );
      moreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        expandMap.set(entryKey, level === 1 ? 2 : 1);
        if (onToggle) onToggle();
      });
      childBox.appendChild(moreBtn);
    }
  } else {
    for (const c of children) appendChildRow(c);
  }

  hostEl.appendChild(childBox);
}

module.exports = {
  renderExpandableChildren,
};
