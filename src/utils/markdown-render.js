'use strict';

const Obsidian = require('obsidian');
const { renderTokensInto } = require('./dom');
const { tokenizeRichLine } = require('../parsers/markdown');

function hasActiveTextSelection() {
  try {
    const sel =
      typeof window !== 'undefined' && typeof window.getSelection === 'function'
        ? window.getSelection()
        : null;
    return Boolean(sel && String(sel.toString() || '').trim());
  } catch (_e) {
    return false;
  }
}

function isInteractiveMarkdownTarget(target) {
  if (!target || typeof target.closest !== 'function') return false;
  return Boolean(
    target.closest('a, button, input, .copy-code-button, .ch-tl-children, .ch-tl-more-btn')
  );
}

function bindNativeMarkdownEvents(container, app, sourcePath) {
  if (!container) return;
  container.__chSourcePath = sourcePath || '';
  if (container.__chMdBound) return;
  container.__chMdBound = true;

  let lastHoveredEl = null;

  container.addEventListener('click', (e) => {
    const target = e && e.target;
    if (!target || typeof target.closest !== 'function') return;

    const copyBtn = target.closest('button.copy-code-button');
    if (copyBtn) {
      e.stopPropagation?.();
      return;
    }

    const intLink = target.closest('a.internal-link');
    if (intLink) {
      e.preventDefault?.();
      e.stopPropagation?.();
      const href =
        intLink.getAttribute?.('data-href') ||
        intLink.getAttribute?.('href') ||
        intLink.textContent ||
        '';
      if (href && app?.workspace?.openLinkText) {
        const isMod = Boolean(
          Obsidian.Keymap &&
            typeof Obsidian.Keymap.isModEvent === 'function' &&
            Obsidian.Keymap.isModEvent(e)
        );
        const newTab = Boolean(e.metaKey || e.ctrlKey || isMod);
        app.workspace.openLinkText(href, container.__chSourcePath || '', newTab);
      }
      return;
    }

    const tagLink = target.closest('a.tag');
    if (tagLink) {
      e.preventDefault?.();
      e.stopPropagation?.();
      const rawTag = tagLink.getAttribute?.('href') || tagLink.textContent || '';
      const cleanTag = String(rawTag).trim().replace(/^#+/, '');
      if (cleanTag) {
        app?.internalPlugins?.plugins?.['global-search']?.instance?.openGlobalSearch?.(
          `tag:#${cleanTag}`
        );
      }
      return;
    }

    const extLink = target.closest('a.external-link, a[href]');
    if (extLink) {
      e.stopPropagation?.();
    }
  });

  container.addEventListener('auxclick', (e) => {
    if (!e || e.button !== 1) return;
    const target = e.target;
    const intLink = target && typeof target.closest === 'function' ? target.closest('a.internal-link') : null;
    if (!intLink) return;
    e.preventDefault?.();
    e.stopPropagation?.();
    const href =
      intLink.getAttribute?.('data-href') ||
      intLink.getAttribute?.('href') ||
      intLink.textContent ||
      '';
    if (href && app?.workspace?.openLinkText) {
      app.workspace.openLinkText(href, container.__chSourcePath || '', true);
    }
  });

  container.addEventListener('mouseover', (e) => {
    const target = e && e.target;
    const link = target && typeof target.closest === 'function' ? target.closest('a.internal-link') : null;
    if (!link) {
      lastHoveredEl = null;
      return;
    }
    if (link === lastHoveredEl) return;
    lastHoveredEl = link;
    const href =
      link.getAttribute?.('data-href') ||
      link.getAttribute?.('href') ||
      link.textContent ||
      '';
    if (href) {
      app?.workspace?.trigger?.('hover-link', {
        event: e,
        source: 'carrot-home-view',
        hoverParent: container,
        targetEl: link,
        linktext: href,
        sourcePath: container.__chSourcePath || '',
      });
    }
  });

  container.addEventListener('mouseout', (e) => {
    if (!lastHoveredEl) return;
    const rel = e && e.relatedTarget;
    if (rel && typeof lastHoveredEl.contains === 'function' && lastHoveredEl.contains(rel)) {
      return;
    }
    lastHoveredEl = null;
  });
}

function createMarkdownRenderScope() {
  let components = [];
  let seq = 0;

  function reset() {
    seq++;
    const toUnload = components;
    components = [];
    for (const comp of toUnload) {
      try {
        comp?.unload?.();
      } catch (_e) {}
    }
  }

  function render({ app, container, markdown, sourcePath, fallbackTokens }) {
    if (!container) return Promise.resolve();
    container.classList?.add('ch-md-inline', 'markdown-rendered');
    bindNativeMarkdownEvents(container, app, sourcePath);

    const text = String(markdown ?? '');
    if (Obsidian.MarkdownRenderer && typeof Obsidian.MarkdownRenderer.render === 'function') {
      const comp =
        typeof Obsidian.Component === 'function'
          ? new Obsidian.Component()
          : { load() {}, unload() {} };
      try {
        comp.load?.();
      } catch (_e) {}
      const mySeq = seq;
      components.push(comp);
      try {
        return Promise.resolve(
          Obsidian.MarkdownRenderer.render(app, text, container, sourcePath || '', comp)
        )
          .then(() => {
            if (mySeq !== seq) {
              try {
                comp.unload?.();
              } catch (_e) {}
            }
          })
          .catch(() => {});
      } catch (_err) {
        if (mySeq !== seq) {
          try {
            comp.unload?.();
          } catch (_e) {}
        }
      }
    }

    const tokens =
      Array.isArray(fallbackTokens) && fallbackTokens.length > 0
        ? fallbackTokens
        : tokenizeRichLine(text);
    renderTokensInto(container, tokens, app);
    return Promise.resolve();
  }

  return {
    render,
    reset,
    destroy: reset,
  };
}

module.exports = {
  hasActiveTextSelection,
  isInteractiveMarkdownTarget,
  bindNativeMarkdownEvents,
  createMarkdownRenderScope,
};
