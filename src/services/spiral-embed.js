'use strict';

const { formatDateYMD, diffDaysYMD } = require('../utils/date');
const { el } = require('../utils/dom');

function computeSpiralOffset(nautPlugin, targetDateYMD, fallbackTodayYMD) {
  const fallbackToday =
    typeof fallbackTodayYMD === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fallbackTodayYMD)
      ? fallbackTodayYMD
      : formatDateYMD(new Date());
  const targetYMD =
    typeof targetDateYMD === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(targetDateYMD)
      ? targetDateYMD
      : fallbackToday;
  let baseYMD = fallbackToday;
  try {
    const formatted = nautPlugin?.today?.()?.format?.('YYYY-MM-DD');
    if (typeof formatted === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(formatted)) {
      baseYMD = formatted;
    }
  } catch (_e) {}
  return diffDaysYMD(baseYMD, targetYMD);
}

function resolveSpiralViewPrototype(app) {
  try {
    const leaves = app?.workspace?.getLeavesOfType?.('nautilus-spiral');
    if (Array.isArray(leaves)) {
      for (const leaf of leaves) {
        if (leaf?.view && typeof leaf.view.render === 'function') {
          return Object.getPrototypeOf(leaf.view);
        }
      }
    }
  } catch (_e) {}

  try {
    const reg = app?.viewRegistry;
    const creator =
      (reg && typeof reg.getViewCreatorByType === 'function' && reg.getViewCreatorByType('nautilus-spiral')) ||
      reg?.viewByType?.['nautilus-spiral'];
    if (typeof creator === 'function') {
      const mockContainer = typeof document !== 'undefined' ? document.createElement('div') : null;
      if (mockContainer && typeof mockContainer.createDiv !== 'function') {
        mockContainer.createDiv = function (arg) {
          const child = document.createElement('div');
          if (typeof arg === 'string') child.className = arg;
          else if (arg && typeof arg === 'object' && arg.cls) child.className = arg.cls;
          this.appendChild(child);
          return child;
        };
      }
      const mockLeaf = {
        app,
        containerEl: mockContainer,
        history: { backHistory: [], forwardHistory: [] },
        getRoot: () => null,
        on: () => {},
        off: () => {},
        registerEvent: () => {},
      };
      const probe = creator(mockLeaf);
      if (probe && typeof probe.render === 'function') {
        const proto = Object.getPrototypeOf(probe);
        try { probe.onClose?.(); } catch (_e) {}
        try { probe.unload?.(); } catch (_e) {}
        try { probe.containerEl?.remove?.(); } catch (_e) {}
        return proto;
      }
    }
  } catch (_e) {}

  return null;
}

class SpiralEmbedController {
  constructor(app, getTargetDateYMD, isVisibleFn, onBootRetry) {
    this.app = app;
    this.getTargetDateYMD = getTargetDateYMD;
    this.isVisibleFn = isVisibleFn;
    this.onBootRetry = onBootRetry;

    this.hostEl = null;
    this.viewInst = null;
    this.pluginRef = null;
    this.lastOffset = null;
    this.bootRetryTimer = null;
    this.bootRetryCount = 0;
    this.renderTimer = null;
    this.handleTimer = null;
    this.domAc = null;
    this.needsSync = false;
    this.renderedDuringUI = false;
  }

  hasView() {
    return Boolean(this.viewInst);
  }

  markNeedsSync() {
    this.needsSync = true;
  }

  resetRenderedFlag() {
    this.renderedDuringUI = false;
  }

  wasRenderedDuringUI() {
    return this.renderedDuringUI;
  }

  destroy() {
    if (this.bootRetryTimer) {
      clearTimeout(this.bootRetryTimer);
      this.bootRetryTimer = null;
    }
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    if (this.handleTimer) {
      clearTimeout(this.handleTimer);
      this.handleTimer = null;
    }
    if (this.domAc) {
      try { this.domAc.abort(); } catch (_e) {}
      this.domAc = null;
    }
    if (this.viewInst) {
      try { this.viewInst.onClose?.(); } catch (_e) {}
    }
    this.viewInst = null;
    this.pluginRef = null;
    this.hostEl = null;
    this.lastOffset = null;
    this.bootRetryCount = 0;
    this.needsSync = false;
    this.renderedDuringUI = false;
  }

  ensure() {
    const app = this.app;
    const nautPlugin = app?.plugins?.plugins?.['nautilus-spiral'] || null;
    const pluginReady = Boolean(nautPlugin && typeof nautPlugin.today === 'function' && nautPlugin.settings);

    if (this.viewInst && this.pluginRef === nautPlugin && this.hostEl) {
      return { status: 'ready', hostEl: this.hostEl, view: this.viewInst, plugin: nautPlugin };
    }

    if (this.viewInst && this.pluginRef !== nautPlugin) {
      if (this.domAc) {
        try { this.domAc.abort(); } catch (_e) {}
        this.domAc = null;
      }
      try { this.viewInst.onClose?.(); } catch (_e) {}
      this.viewInst = null;
      this.pluginRef = null;
      this.hostEl = null;
      this.lastOffset = null;
    }

    if (pluginReady) {
      const proto = resolveSpiralViewPrototype(app);
      if (proto) {
        const hostEl = el('div', 'ch-naut-container');
        hostEl.appendChild(el('div', 'ch-naut-dummy-head')); // children[0]
        hostEl.appendChild(el('div', 'naut-root')); // children[1]

        if (typeof AbortController !== 'undefined') {
          this.domAc = new AbortController();
          const onHandleFinish = (ev) => {
            if (!ev.target?.closest?.('.naut-handle')) return;
            if (this.handleTimer) clearTimeout(this.handleTimer);
            this.handleTimer = setTimeout(() => {
              this.handleTimer = null;
              this.sync({ force: true });
            }, 120);
          };
          hostEl.addEventListener('pointerup', onHandleFinish, { capture: true, signal: this.domAc.signal });
          hostEl.addEventListener('dblclick', onHandleFinish, { capture: true, signal: this.domAc.signal });
        }

        const view = Object.create(proto);
        Object.assign(view, {
          app,
          plugin: nautPlugin,
          offset: computeSpiralOffset(nautPlugin, this.getTargetDateYMD()),
          containerEl: hostEl,
        });

        this.hostEl = hostEl;
        this.viewInst = view;
        this.pluginRef = nautPlugin;
        this.lastOffset = null;
        this.bootRetryCount = 0;
        if (this.bootRetryTimer) {
          clearTimeout(this.bootRetryTimer);
          this.bootRetryTimer = null;
        }
        return { status: 'ready', hostEl, view, plugin: nautPlugin };
      }
    }

    const isEnabled = Boolean(app?.plugins?.enabledPlugins?.has?.('nautilus-spiral'));
    if (isEnabled && this.bootRetryCount < 15) {
      if (!this.bootRetryTimer) {
        this.bootRetryTimer = setTimeout(() => {
          this.bootRetryTimer = null;
          this.bootRetryCount++;
          if (typeof this.onBootRetry === 'function') this.onBootRetry();
        }, 300);
      }
      return { status: 'loading' };
    }
    return { status: 'unavailable' };
  }

  sync({ force = false, animate = false } = {}) {
    if (typeof this.isVisibleFn === 'function' && !this.isVisibleFn()) {
      if (force) this.needsSync = true;
      return;
    }
    const res = this.ensure();
    if (res.status !== 'ready') {
      if (force) this.needsSync = true;
      return;
    }
    const shouldForce = force || this.needsSync;
    this.needsSync = false;
    const targetOffset = computeSpiralOffset(res.plugin, this.getTargetDateYMD());
    if (this.lastOffset === null) {
      this.lastOffset = targetOffset;
      res.view.offset = targetOffset;
      res.view._enter = true;
      this.renderedDuringUI = true;
      void Promise.resolve(res.view.render({ force: true })).catch(() => {});
    } else if (targetOffset !== this.lastOffset) {
      this.lastOffset = targetOffset;
      this.renderedDuringUI = true;
      void Promise.resolve(res.view.go(targetOffset)).catch(() => {});
    } else if (shouldForce || animate) {
      if (animate) res.view._enter = true;
      this.renderedDuringUI = true;
      void Promise.resolve(res.view.render({ force: shouldForce })).catch(() => {});
    }
  }

  scheduleRender({ force = true } = {}) {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.sync({ force });
    }, 140);
  }
}

module.exports = {
  computeSpiralOffset,
  resolveSpiralViewPrototype,
  SpiralEmbedController,
};
