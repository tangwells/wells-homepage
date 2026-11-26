'use strict';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function setIconSafe(obsidian, targetEl, iconName, fallbackText) {
  if (obsidian && typeof obsidian.setIcon === 'function') {
    try {
      obsidian.setIcon(targetEl, iconName);
      if (targetEl.childElementCount > 0) return;
    } catch (_e) {}
  }
  targetEl.textContent = fallbackText || '';
}

function renderTokensInto(container, tokens, app) {
  for (const tok of tokens) {
    if (tok.kind === 'text') {
      container.appendChild(document.createTextNode(tok.text));
    } else if (tok.kind === 'br') {
      container.appendChild(document.createElement('br'));
    } else if (tok.kind === 'wiki') {
      const a = el('a', 'ch-inline-link', tok.display);
      a.href = '#';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        app.workspace.openLinkText(tok.target, '', false);
      });
      container.appendChild(a);
    } else if (tok.kind === 'md') {
      const a = el('a', 'ch-inline-link', tok.display);
      a.href = tok.url;
      a.addEventListener('click', (e) => {
        e.stopPropagation();
        if (tok.url.startsWith('http://') || tok.url.startsWith('https://')) {
          e.preventDefault();
          window.open(tok.url, '_blank');
        }
      });
      container.appendChild(a);
    }
  }
}

/**
 * 局部重绘兜底：保留外层滚动容器 scrollTop，防止浏览器因瞬时高度收缩将 scrollTop 重置为 0。
 */
function preserveScroll(scrollEl, fn) {
  const prevTop = scrollEl && typeof scrollEl.scrollTop === 'number' ? scrollEl.scrollTop : 0;
  const res = fn();
  if (scrollEl && typeof prevTop === 'number' && prevTop > 0) {
    const sh = Number(scrollEl.scrollHeight || 0);
    const ch = Number(scrollEl.clientHeight || 0);
    const maxTop = sh > 0 && ch > 0 ? Math.max(0, sh - ch) : prevTop;
    scrollEl.scrollTop = Math.min(prevTop, maxTop);
  }
  return res;
}

module.exports = {
  el,
  setIconSafe,
  renderTokensInto,
  preserveScroll,
};
