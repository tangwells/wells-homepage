'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const path = require('path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');

// ======================== 轻量 Mock DOM 与 Obsidian 环境 ========================

function createMockDOM() {
  class MockClassList {
    constructor(el) {
      this._el = el;
      this._set = new Set();
    }
    _syncFromAttr(str) {
      this._set.clear();
      for (const s of String(str || '').split(/\s+/)) {
        if (s) this._set.add(s);
      }
    }
    _syncToAttr() {
      this._el._className = Array.from(this._set).join(' ');
    }
    add(...tokens) {
      for (const t of tokens) {
        if (t) this._set.add(t);
      }
      this._syncToAttr();
    }
    remove(...tokens) {
      for (const t of tokens) this._set.delete(t);
      this._syncToAttr();
    }
    toggle(token, force) {
      if (force === true) {
        this._set.add(token);
        this._syncToAttr();
        return true;
      }
      if (force === false) {
        this._set.delete(token);
        this._syncToAttr();
        return false;
      }
      if (this._set.has(token)) {
        this._set.delete(token);
        this._syncToAttr();
        return false;
      }
      this._set.add(token);
      this._syncToAttr();
      return true;
    }
    contains(token) {
      return this._set.has(token);
    }
  }

  function matchesSingleSelector(node, sel) {
    if (!node || node.nodeType !== 1) return false;
    let s = sel.trim();
    if (!s) return false;
    // Attribute selector [data-foo] or [data-foo="bar"]
    const attrMatches = [];
    s = s.replace(/\[([^\]=]+)(?:="([^"]*)")?\]/g, (_m, k, v) => {
      attrMatches.push([k.trim(), v]);
      return '';
    });
    const parts = s.split(/(?=[.#])/);
    for (const p of parts) {
      if (!p) continue;
      if (p.startsWith('.')) {
        if (!node.classList.contains(p.slice(1))) return false;
      } else if (p.startsWith('#')) {
        if (node.id !== p.slice(1)) return false;
      } else {
        if (node.tagName.toLowerCase() !== p.toLowerCase()) return false;
      }
    }
    for (const [k, v] of attrMatches) {
      const actual = node.getAttribute(k);
      if (actual === null) return false;
      if (v !== undefined && actual !== v) return false;
    }
    return true;
  }

  function matchesSelectorList(node, selectorList) {
    return String(selectorList || '')
      .split(',')
      .some((sel) => {
        const parts = sel.trim().split(/\s+/).filter(Boolean);
        if (parts.length === 0) return false;
        if (!matchesSingleSelector(node, parts[parts.length - 1])) return false;
        let cur = node.parentNode;
        for (let i = parts.length - 2; i >= 0; i--) {
          while (cur && !matchesSingleSelector(cur, parts[i])) {
            cur = cur.parentNode;
          }
          if (!cur) return false;
          cur = cur.parentNode;
        }
        return true;
      });
  }

  class MockTextNode {
    constructor(text) {
      this.nodeType = 3;
      this.textContent = String(text ?? '');
      this.parentNode = null;
    }
  }

  class MockElement {
    constructor(tagName, namespaceURI = null) {
      this.nodeType = 1;
      this.tagName = String(tagName || 'div').toUpperCase();
      this.namespaceURI = namespaceURI;
      this.parentNode = null;
      this.children = [];
      this.childNodes = [];
      this.attrs = new Map();
      this._className = '';
      this.classList = new MockClassList(this);
      this.dataset = {};
      this.style = {
        _props: new Map(),
        setProperty: (k, v) => { this.style._props.set(k, String(v)); },
        getPropertyValue: (k) => this.style._props.get(k) || '',
      };
      this.listeners = new Map();
      this.scrollTop = 0;
      this.scrollLeft = 0;
      this.scrollHeight = 2000;
      this.clientHeight = 700;
      this.clientWidth = 1000;
      this.offsetWidth = 1000;
      this.value = '';
      this.checked = false;
      this.disabled = false;
      this.title = '';
      this.type = '';
      this.placeholder = '';
      this.href = '';
      this._textContent = '';
    }

    get className() {
      return this._className;
    }
    set className(v) {
      this._className = String(v || '');
      this.classList._syncFromAttr(this._className);
    }

    get textContent() {
      if (this.childNodes.length === 0) return this._textContent;
      return this.childNodes.map((c) => c.textContent || '').join('');
    }
    set textContent(v) {
      this.childNodes = [];
      this.children = [];
      this._textContent = v == null ? '' : String(v);
    }

    get innerHTML() {
      return this.textContent;
    }
    set innerHTML(v) {
      this.textContent = String(v || '');
    }

    get childElementCount() {
      return this.children.length;
    }

    appendChild(child) {
      if (!child) return child;
      if (child.parentNode && typeof child.parentNode.removeChild === 'function') {
        child.parentNode.removeChild(child);
      }
      child.parentNode = this;
      this.childNodes.push(child);
      if (child.nodeType === 1) this.children.push(child);
      return child;
    }

    removeChild(child) {
      const idx = this.childNodes.indexOf(child);
      if (idx !== -1) this.childNodes.splice(idx, 1);
      const eidx = this.children.indexOf(child);
      if (eidx !== -1) this.children.splice(eidx, 1);
      child.parentNode = null;
      return child;
    }

    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    }

    replaceChildren(...nodes) {
      for (const c of this.childNodes.slice()) {
        c.parentNode = null;
      }
      this.childNodes = [];
      this.children = [];
      this._textContent = '';
      for (const n of nodes) this.appendChild(n);
    }

    empty() {
      this.replaceChildren();
    }

    setAttribute(k, v) {
      if (k === 'class') this.className = v;
      else if (k === 'id') this.id = String(v);
      this.attrs.set(k, String(v));
    }

    getAttribute(k) {
      if (k === 'class') return this.className;
      if (k === 'id') return this.id ?? null;
      return this.attrs.has(k) ? this.attrs.get(k) : null;
    }

    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }

    removeEventListener(type, fn) {
      const arr = this.listeners.get(type);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx !== -1) arr.splice(idx, 1);
    }

    dispatchEvent(ev) {
      const event = ev || { type: '' };
      if (!event.target) event.target = this;
      if (typeof event.cancelBubble !== 'boolean') event.cancelBubble = false;
      if (typeof event.defaultPrevented !== 'boolean') event.defaultPrevented = false;
      event.preventDefault = () => { event.defaultPrevented = true; };
      event.stopPropagation = () => { event.cancelBubble = true; };
      let cur = this;
      while (cur) {
        event.currentTarget = cur;
        const arr = cur.listeners.get(event.type) || [];
        for (const fn of arr.slice()) fn(event);
        if (event.cancelBubble) break;
        cur = cur.parentNode;
      }
    }

    contains(node) {
      let cur = node;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentNode;
      }
      return false;
    }

    click(extra = {}) {
      this.dispatchEvent({ type: 'click', target: this, ...extra });
    }

    focus() {}

    scrollTo(opts) {
      if (opts && typeof opts.left === 'number') this.scrollLeft = opts.left;
      if (opts && typeof opts.top === 'number') this.scrollTop = opts.top;
    }

    getBoundingClientRect() {
      return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
    }

    closest(selectorList) {
      let cur = this;
      while (cur) {
        if (matchesSelectorList(cur, selectorList)) return cur;
        cur = cur.parentNode;
      }
      return null;
    }

    querySelector(selectorList) {
      return this.querySelectorAll(selectorList)[0] || null;
    }

    querySelectorAll(selectorList) {
      const out = [];
      const walk = (node) => {
        for (const c of node.children) {
          if (matchesSelectorList(c, selectorList)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }
  }

  const body = new MockElement('body');
  const docListeners = new Map();
  const doc = {
    body,
    createElement: (tag) => new MockElement(tag),
    createElementNS: (ns, tag) => new MockElement(tag, ns),
    createTextNode: (text) => new MockTextNode(text),
    addEventListener: (type, fn) => {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    removeEventListener: (type, fn) => {
      const arr = docListeners.get(type);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx !== -1) arr.splice(idx, 1);
    },
    elementFromPoint: () => null,
  };

  return { document: doc, MockElement };
}

function createMockObsidianClasses() {
  class Plugin {
    constructor(app, manifest) {
      this.app = app;
      this.manifest = manifest || { id: 'carrot-home' };
      this._views = new Map();
      this._commands = [];
      this._ribbons = [];
      this._settingTabs = [];
      this._events = [];
    }
    registerView(type, creator) {
      this._views.set(type, creator);
      this.app._viewCreators.set(type, creator);
    }
    addRibbonIcon(icon, title, cb) {
      const item = { icon, title, cb };
      this._ribbons.push(item);
      return item;
    }
    addCommand(cmd) {
      this._commands.push(cmd);
      return cmd;
    }
    addSettingTab(tab) {
      this._settingTabs.push(tab);
    }
    registerEvent(ref) {
      this._events.push(ref);
    }
    async loadData() {
      return this.app._pluginData || {};
    }
    async saveData(data) {
      this.app._pluginData = JSON.parse(JSON.stringify(data));
    }
  }

  class ItemView {
    constructor(leaf) {
      this.leaf = leaf;
      this.app = leaf.app;
      this.contentEl = global.document.createElement('div');
      this._events = [];
      this._actions = [];
    }
    addAction(icon, title, cb) {
      const act = { icon, title, cb };
      this._actions.push(act);
      return act;
    }
    registerEvent(ref) {
      this._events.push(ref);
    }
  }

  class PluginSettingTab {
    constructor(app, plugin) {
      this.app = app;
      this.plugin = plugin;
      this.containerEl = global.document.createElement('div');
    }
  }

  class Setting {
    constructor() {}
    setName() { return this; }
    setDesc() { return this; }
    setHeading() { return this; }
    addToggle(fn) { fn({ setValue: () => ({ onChange: () => {} }) }); return this; }
    addText(fn) { fn({ setPlaceholder: () => ({ setValue: () => ({ onChange: () => {} }) }) }); return this; }
    addDropdown(fn) { fn({ addOption: () => ({ addOption: () => ({ addOption: () => ({ setValue: () => ({ onChange: () => {} }) }) }) }), setValue: () => ({ onChange: () => {} }) }); return this; }
    addSlider(fn) { fn({ setLimits: () => ({ setValue: () => ({ setDynamicTooltip: () => ({ onChange: () => {} }) }) }) }); return this; }
  }

  class Notice {
    constructor(msg) {
      this.message = msg;
      Notice.history.push(msg);
    }
  }
  Notice.history = [];

  class Component {
    constructor() {
      this._loaded = false;
      this._unloaded = false;
    }
    load() {
      if (this._loaded) return;
      this._loaded = true;
      Component.stats.loadedCount++;
      Component.stats.activeCount++;
    }
    unload() {
      if (this._unloaded) return;
      this._unloaded = true;
      if (this._loaded) {
        Component.stats.unloadedCount++;
        Component.stats.activeCount = Math.max(0, Component.stats.activeCount - 1);
      }
    }
  }
  Component.stats = { loadedCount: 0, unloadedCount: 0, activeCount: 0 };

  const MarkdownRenderer = {
    calls: [],
    async render(_app, markdown, container, sourcePath, component) {
      MarkdownRenderer.calls.push({ markdown, sourcePath, component });
      const p = global.document.createElement('p');
      const text = String(markdown || '');
      const re = /(\*\*([^*]+)\*\*|`([^`]+)`|\[\[([^\]]+)\]\]|(^|\s)(#[^\s#.,;:!?()[\]{}<>"']+))/g;
      let last = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) {
          p.appendChild(global.document.createTextNode(text.slice(last, m.index)));
        }
        if (m[2] !== undefined) {
          const strong = global.document.createElement('strong');
          strong.textContent = m[2];
          p.appendChild(strong);
        } else if (m[3] !== undefined) {
          const code = global.document.createElement('code');
          code.textContent = m[3];
          p.appendChild(code);
        } else if (m[4] !== undefined) {
          const parts = m[4].split('|');
          const target = parts[0];
          const display = parts.length > 1 ? parts[parts.length - 1] : target.split('/').pop();
          const a = global.document.createElement('a');
          a.className = 'internal-link';
          a.setAttribute('data-href', target);
          a.href = target;
          a.textContent = display;
          p.appendChild(a);
        } else if (m[6] !== undefined) {
          if (m[5]) p.appendChild(global.document.createTextNode(m[5]));
          const a = global.document.createElement('a');
          a.className = 'tag';
          a.href = m[6];
          a.textContent = m[6];
          p.appendChild(a);
        }
        last = re.lastIndex;
      }
      if (last < text.length) {
        p.appendChild(global.document.createTextNode(text.slice(last)));
      }
      container.appendChild(p);
    },
  };

  const Keymap = {
    isModEvent: (e) => Boolean(e && (e.metaKey || e.ctrlKey)),
  };

  return {
    Plugin,
    ItemView,
    PluginSettingTab,
    Setting,
    Notice,
    Component,
    MarkdownRenderer,
    Keymap,
    setIcon: (el, name) => {
      const span = global.document.createElement('span');
      span.setAttribute('data-icon', name);
      el.appendChild(span);
    },
  };
}

function createMockApp(initialFiles) {
  const filesMap = new Map();
  const foldersMap = new Map();
  let cachedReadCount = 0;
  const emitters = {
    vault: new Map(),
    workspace: new Map(),
    metadataCache: new Map(),
    bookmarks: new Map(),
  };

  function makeEventTarget(bucket) {
    return {
      on(evt, fn) {
        if (!bucket.has(evt)) bucket.set(evt, new Set());
        bucket.get(evt).add(fn);
        return { bucket, evt, fn };
      },
      offref(ref) {
        if (ref && ref.bucket && ref.bucket.get(ref.evt)) {
          ref.bucket.get(ref.evt).delete(ref.fn);
        }
      },
      trigger(evt, ...args) {
        const set = bucket.get(evt);
        if (!set) return;
        for (const fn of Array.from(set)) fn(...args);
      },
    };
  }

  const vaultEvents = makeEventTarget(emitters.vault);
  const wsEvents = makeEventTarget(emitters.workspace);
  const mcEvents = makeEventTarget(emitters.metadataCache);
  const bmEvents = makeEventTarget(emitters.bookmarks);

  function addOrUpdateFolder(folderPath) {
    const cleaned = String(folderPath || '').replace(/\/+$/, '');
    if (!cleaned || cleaned === '/') return null;
    const parts = cleaned.split('/');
    let cur = '';
    let last = null;
    for (const seg of parts) {
      if (!seg) continue;
      cur = cur ? `${cur}/${seg}` : seg;
      if (!foldersMap.has(cur)) {
        foldersMap.set(cur, { path: cur, name: seg, children: [] });
      }
      last = foldersMap.get(cur);
    }
    return last;
  }

  function addOrUpdateFile(filePath, content, mtime = 1000) {
    const basename = path.basename(filePath, path.extname(filePath));
    const name = path.basename(filePath);
    const dir = path.posix.dirname(filePath);
    if (dir && dir !== '.') addOrUpdateFolder(dir);
    const existing = filesMap.get(filePath);
    if (existing) {
      existing._content = content;
      existing.stat.mtime = mtime;
      return existing;
    }
    const f = {
      path: filePath,
      name,
      basename,
      stat: { mtime },
      _content: content,
    };
    filesMap.set(filePath, f);
    return f;
  }

  for (const [p, c] of Object.entries(initialFiles || {})) {
    addOrUpdateFile(p, c, 1000);
  }

  const rootSplit = { id: 'root' };
  const leaves = [];
  const openLinkTextCalls = [];
  const openFileCalls = [];
  const openBookmarkCalls = [];
  const hoverLinkEvents = [];
  const globalSearchQueries = [];

  function removeBookmarkFromList(list, target) {
    if (!Array.isArray(list)) return false;
    const idx = list.indexOf(target);
    if (idx !== -1) {
      list.splice(idx, 1);
      return true;
    }
    for (const item of list) {
      if (item && item.type === 'group' && removeBookmarkFromList(item.items, target)) {
        return true;
      }
    }
    return false;
  }

  const bookmarksInstance = {
    items: [],
    on: bmEvents.on,
    offref: bmEvents.offref,
    trigger: bmEvents.trigger,
    getItemTitle(item) {
      if (item.title) return item.title;
      if (item.type === 'file') {
        const base = String(item.path || '').replace(/^.*\//, '').replace(/\.md$/i, '');
        return base + (item.subpath || '');
      }
      if (item.type === 'folder') {
        return String(item.path || '').replace(/^.*\//, '');
      }
      if (item.type === 'search') return item.query || '';
      return '';
    },
    addItem(item, parentGroup) {
      if (parentGroup && Array.isArray(parentGroup.items)) {
        parentGroup.items.push(item);
      } else {
        bookmarksInstance.items.push(item);
      }
      bmEvents.trigger('changed');
    },
    removeItem(item) {
      if (removeBookmarkFromList(bookmarksInstance.items, item)) {
        bmEvents.trigger('changed');
      }
    },
    openBookmark(item, newLeaf) {
      openBookmarkCalls.push({ item, newLeaf });
    },
  };

  const bookmarksEntry = {
    enabled: true,
    instance: bookmarksInstance,
  };

  const app = {
    _viewCreators: new Map(),
    _pluginData: {},
    _filesMap: filesMap,
    _foldersMap: foldersMap,
    _addOrUpdateFile: addOrUpdateFile,
    _addOrUpdateFolder: addOrUpdateFolder,
    _getCachedReadCount: () => cachedReadCount,
    _resetCachedReadCount: () => { cachedReadCount = 0; },
    _openLinkTextCalls: openLinkTextCalls,
    _openFileCalls: openFileCalls,
    _openBookmarkCalls: openBookmarkCalls,
    _hoverLinkEvents: hoverLinkEvents,
    _globalSearchQueries: globalSearchQueries,
    _getBookmarkListenerCount: () => (emitters.bookmarks.get('changed')?.size || 0),
    vault: {
      getName: () => 'TestVault',
      getMarkdownFiles: () => Array.from(filesMap.values()).filter((f) => f.path.endsWith('.md')),
      getFiles: () => Array.from(filesMap.values()),
      getAllLoadedFiles: () => [...foldersMap.values(), ...filesMap.values()],
      getAbstractFileByPath: (p) => filesMap.get(p) || foldersMap.get(p) || null,
      cachedRead: async (file) => {
        cachedReadCount++;
        return file._content;
      },
      read: async (file) => file._content,
      modify: async (file, content) => {
        file._content = content;
        file.stat.mtime += 1;
        vaultEvents.trigger('modify', file);
      },
      create: async (p, content) => {
        const f = addOrUpdateFile(p, content, Date.now());
        vaultEvents.trigger('create', f);
        return f;
      },
      delete: async (f) => {
        if (!f || !f.path) return;
        filesMap.delete(f.path);
        foldersMap.delete(f.path);
        vaultEvents.trigger('delete', f);
      },
      createFolder: async (p) => addOrUpdateFolder(p),
      on: vaultEvents.on,
      offref: vaultEvents.offref,
      trigger: vaultEvents.trigger,
    },
    metadataCache: {
      getFileCache: (file) => {
        const m = String(file._content || '').match(/aliases:\s*\[?([^\n\]]+)/);
        return m ? { frontmatter: { aliases: [m[1].trim().replace(/^["']|["']$/g, '')] } } : {};
      },
      getFirstLinkpathDest: (linkpath) => {
        const clean = String(linkpath || '').replace(/^\/+|\/+$/g, '');
        return filesMap.get(clean) || filesMap.get(`${clean}.md`) || null;
      },
      on: mcEvents.on,
      offref: mcEvents.offref,
      trigger: mcEvents.trigger,
    },
    workspace: {
      rootSplit,
      getLeavesOfType: (type) => leaves.filter((l) => l.view && l.view.getViewType && l.view.getViewType() === type),
      iterateRootLeaves: (cb) => { for (const l of leaves) cb(l); },
      getLeaf: (newTab) => {
        const leaf = {
          app,
          view: null,
          getRoot: () => rootSplit,
          openFile: async (file, state) => {
            openFileCalls.push({ path: file?.path, state, newTab: Boolean(newTab) });
          },
          updateHeader: () => {},
          setViewState: async ({ type }) => {
            const creator = app._viewCreators.get(type);
            if (creator) {
              leaf.view = creator(leaf);
              if (leaf.view.onOpen) await leaf.view.onOpen();
            }
          },
        };
        leaves.push(leaf);
        return leaf;
      },
      revealLeaf: () => {},
      openLinkText: (linktext, sourcePath, newLeaf) => {
        openLinkTextCalls.push({ linktext, sourcePath, newLeaf });
      },
      onLayoutReady: (cb) => cb(),
      on: wsEvents.on,
      offref: wsEvents.offref,
      trigger: (evt, payload) => {
        if (evt === 'hover-link') hoverLinkEvents.push(payload);
        wsEvents.trigger(evt, payload);
      },
    },
    plugins: {
      plugins: {},
      enabledPlugins: new Set(),
      getPlugin: (id) => {
        const enabled = app.plugins.enabledPlugins;
        if (enabled && enabled.size > 0 && !enabled.has(id)) return null;
        return app.plugins.plugins[id] || null;
      },
    },
    internalPlugins: {
      getEnabledPluginById: (id) => {
        if (id === 'bookmarks') return bookmarksEntry.enabled ? bookmarksEntry.instance : null;
        return app.internalPlugins.plugins[id]?.instance || null;
      },
      plugins: {
        bookmarks: bookmarksEntry,
        'global-search': {
          instance: {
            openGlobalSearch: (q) => globalSearchQueries.push(q),
          },
        },
      },
    },
    commands: {
      listCommands: () => [],
      executeCommandById: () => true,
    },
  };

  return app;
}

// ======================== 1. 纯函数与解析器回归测试 ========================

function testParsersAndUtils() {
  const { formatDateYMD, parseYMD, addDaysYMD, diffDaysYMD, getIsoWeekInfo, renderTemplateText } = require('../src/utils/date');
  const { normalizeSettings } = require('../src/utils/settings');
  const { splitFrontmatter, buildLineFlags, scanMarkdownTasks, collectDoingProjectLabels } = require('../src/parsers/markdown');
  const {
    planDailyEntryInsertion,
    buildFlashEntryLine,
    buildImportantEntryLine,
    parseDailyActiveStatus,
    parseDailyJournalTimeline,
  } = require('../src/parsers/journal');
  const {
    classifyAgentDeckKeyword,
    parseExecutionTasksFromDaily,
    patchAgentDeckTaskKeyword,
    planExecutionTaskInsertion,
    planRemoveTaskBlock,
  } = require('../src/parsers/execution');
  const {
    parseProjectNote,
    patchTaskLine,
    buildOrthogonalDepPath,
    planAddTaskDependency,
    planRemoveTaskDependency,
  } = require('../src/parsers/project');
  const { computeSpiralOffset } = require('../src/services/spiral-embed');

  // 日期与 ISO 周（周日起始 vs 周一起始校验：2026-09-06 是周日，仍属 W36；跨年周以周四定年）
  assert.strictEqual(getIsoWeekInfo('2026-09-06').weekTitle, '2026W36');
  assert.strictEqual(getIsoWeekInfo('2026-09-07').weekTitle, '2026W37');
  const ny1 = getIsoWeekInfo('2025-12-29');
  assert.strictEqual(ny1.weekTitle, '2026W01');
  assert.strictEqual(ny1.weekLabel, 'W01');
  assert.strictEqual(ny1.isoWeekYear, 2026);
  assert.strictEqual(ny1.weekNumber, 1);
  assert.strictEqual(getIsoWeekInfo('2026-01-04').weekTitle, '2026W01');
  const ny53 = getIsoWeekInfo('2026-12-28');
  assert.strictEqual(ny53.weekTitle, '2026W53');
  assert.strictEqual(ny53.weekLabel, 'W53');
  assert.strictEqual(getIsoWeekInfo('invalid').weekNumber, 0);
  assert.strictEqual(addDaysYMD('2026-11-26', 2), '2026-11-28');
  assert.strictEqual(diffDaysYMD('2026-11-24', '2026-11-26'), 2);
  assert.strictEqual(formatDateYMD(parseYMD('2026-11-26')), '2026-11-26');
  assert.ok(renderTemplateText('{{title}} {{weekStart}}..{{weekEnd}}', 'weekly', '2026-09-06').startsWith('2026W36'));

  // Periodic Notes 周志预设与模板混合渲染
  const {
    DEFAULT_WEEKLY_PRESET,
    getWeeklyNotePreset,
    resolveWeeklyNoteTarget,
    renderWeeklyTemplate,
  } = require('../src/services/periodic-notes-adapter');
  const pnApp = createMockApp({});
  assert.deepStrictEqual(getWeeklyNotePreset(pnApp), { ...DEFAULT_WEEKLY_PRESET, source: 'default' });
  pnApp.plugins.plugins['periodic-notes'] = {
    settings: {
      weekly: { enabled: true, folder: '/08_周志/', format: '', template: '02_模版/周志-xdb.md' },
    },
  };
  assert.deepStrictEqual(getWeeklyNotePreset(pnApp), {
    folder: '08_周志',
    format: 'gggg[W]ww',
    template: '02_模版/周志-xdb.md',
    source: 'periodic-notes',
  });
  pnApp.plugins.plugins['periodic-notes'].settings.weekly.format = 'GGGG-[W]WW';
  const wkTarget1 = resolveWeeklyNoteTarget(pnApp, '2026-11-26');
  assert.strictEqual(wkTarget1.filePath, '08_周志/2026-W48.md');
  assert.strictEqual(wkTarget1.title, '2026-W48');
  pnApp.plugins.plugins['periodic-notes'].settings.weekly.folder = '06_日志';
  pnApp.plugins.plugins['periodic-notes'].settings.weekly.format = 'gggg/gggg[W]ww';
  const wkTargetCross = resolveWeeklyNoteTarget(pnApp, '2025-12-29');
  assert.strictEqual(wkTargetCross.filePath, '06_日志/2026/2026W01.md');
  assert.strictEqual(wkTargetCross.title, '2026W01');
  pnApp.plugins.plugins['periodic-notes'].settings.weekly.enabled = false;
  assert.strictEqual(getWeeklyNotePreset(pnApp).source, 'default');
  pnApp.plugins.plugins['periodic-notes'].settings.weekly.enabled = true;
  pnApp.plugins.enabledPlugins.add('other-plugin');
  assert.strictEqual(getWeeklyNotePreset(pnApp).source, 'default', '未启用 periodic-notes 时应回退默认预设');

  const tplOut = renderWeeklyTemplate(
    '# {{title}}\nrange: {{weekStart}}..{{weekEnd}}\nmon: {{monday:YYYY-MM-DD}} sun: {{sunday:YYYY-MM-DD}}\nd2: {{date+2d:YYYY-MM-DD}} d0: {{date}} t: {{time}}',
    {
      title: '2026W48',
      weekStart: '2026-11-23',
      weekEnd: '2026-11-29',
      preset: { format: 'gggg[W]ww' },
    },
    new Date(2026, 10, 26, 9, 5, 0)
  );
  assert.ok(tplOut.includes('# 2026W48'));
  assert.ok(tplOut.includes('range: 2026-11-23..2026-11-29'));
  assert.ok(tplOut.includes('mon: 2026-11-23 sun: 2026-11-29'));
  assert.ok(tplOut.includes('d2: 2026-11-25 d0: 2026W48 t: 09:05'));

  // 设置规范化（并静默忽略遗留 pinnedEntries / ganttStatusFilter）
  const norm = normalizeSettings({
    cardBlur: 10,
    ganttZoom: 'invalid',
    ganttStatusFilter: 'all',
    openOnStartup: false,
    pinnedEntries: [{ id: 'old' }],
  });
  assert.strictEqual(norm.cardBlur, 10);
  assert.strictEqual(norm.ganttZoom, 'month');
  assert.strictEqual(norm.openOnStartup, false);
  assert.strictEqual('pinnedEntries' in norm, false, '应忽略遗留 pinnedEntries 字段');
  assert.strictEqual('ganttStatusFilter' in norm, false, '应忽略遗留 ganttStatusFilter 字段');

  // 书签适配层单元测试
  const {
    getBookmarksPlugin,
    buildBookmarkTree,
    addVaultBookmark,
    listVaultBookmarkTargets,
  } = require('../src/services/bookmarks-adapter');
  const bmApp = createMockApp({
    '07_Resource/doc.md': '# 文档',
    '01_附件/spec.pdf': 'pdf',
    '.trash/ignored.md': 'ignored',
    '.obsidian/workspace.json': '{}',
  });
  bmApp._addOrUpdateFolder('05_Study/空目录');

  const bmTargets = listVaultBookmarkTargets(bmApp);
  assert.ok(bmTargets.some((t) => t.type === 'file' && t.path === '01_附件/spec.pdf'), '应支持任意类型文件');
  assert.ok(bmTargets.some((t) => t.type === 'folder' && t.path === '05_Study/空目录'), '应包含非根空目录');
  assert.ok(!bmTargets.some((t) => t.path.startsWith('.trash/') || t.path.startsWith('.obsidian/')), '应排除 .trash 与 .obsidian');

  const bmPlugin = getBookmarksPlugin(bmApp);
  const subGroup = { type: 'group', title: '子组', items: [{ type: 'file', path: '07_Resource/doc.md', subpath: '#小节' }] };
  bmPlugin.items.push(
    { type: 'group', title: '工作', items: [subGroup, { type: 'url', title: '官网', url: 'https://example.com' }] },
    { type: 'folder', path: '05_Study/空目录' },
    { type: 'search', query: 'tag:#重点' },
    { type: 'graph', title: '全局图谱', options: {} },
    { type: 'file', path: 'missing/deleted.md' }
  );
  for (let k = 0; k < 14; k++) {
    bmPlugin.items.push({ type: 'file', path: `07_Resource/note-${k}.md`, title: `条目${k}` });
  }
  bmPlugin.items.push({ type: 'file', path: '07_Resource/doc.md', subpath: '#top' });
  const tree = buildBookmarkTree(bmApp, bmPlugin);
  assert.strictEqual(tree.enabled, true);
  assert.strictEqual(tree.items.length, 20, '不得截断超过 12 条书签');
  assert.strictEqual(tree.groups.length, 2);
  assert.strictEqual(tree.groups[1].label, '工作 / 子组');
  assert.strictEqual(tree.items[0].leafCount, 2);
  assert.strictEqual(tree.items[0].groupCount, 1);
  assert.strictEqual(tree.items[4].broken, true, '缺失文件应标为 broken');

  const addRes1 = addVaultBookmark(bmApp, null, { type: 'file', path: '07_Resource/doc.md', title: '' });
  assert.strictEqual(addRes1.ok, true);
  assert.strictEqual('title' in addRes1.item, false, '留空标题不应写入 title 字段');
  const dupRes = addVaultBookmark(bmApp, null, { type: 'file', path: '07_Resource/doc.md' });
  assert.strictEqual(dupRes.ok, false);
  assert.strictEqual(dupRes.reason, 'duplicate', '同组重复路径应被阻止');
  const crossGroupRes = addVaultBookmark(bmApp, null, { type: 'file', path: '07_Resource/doc.md', parentGroupRaw: subGroup });
  assert.strictEqual(crossGroupRes.ok, true, '不同分组（且原条目带 subpath）允许共存');

  bmApp.internalPlugins.plugins.bookmarks.enabled = false;
  assert.strictEqual(getBookmarksPlugin(bmApp), null, '禁用书签核心插件应返回 null');
  assert.strictEqual(buildBookmarkTree(bmApp, null).enabled, false);

  // Frontmatter & LineFlags (Agent Deck 隔离)
  const sampleDaily = [
    '---',
    'tags: [daily]',
    '---',
    '## 效率看板',
    '```tasks',
    '- [I] 代码块内忽略',
    '```',
    '',
    '## 清晨',
    '- **08:00** 早起',
    '- [I] **08:15** 闪念 [[S26Q4_001|课题A]]',
    '- [i] **08:20** #要事 重要事项',
    '',
    '## 今日执行',
    '- DOING 🤖 **08:30** 开发插件 45m',
    '\t- 🎯 目标：拆分独立插件',
    '\t- 💬 第1轮：完成构建器',
    '- TODO [#A] 写单测 30m',
    '',
    '<!-- agent-deck:layout:start -->',
    '## 正在做 ^ad-a-1',
    '- DOING 🤖 08:30-09:00 **开发插件**',
    '\t- ⏱ 共 30m',
    '<!-- agent-deck:layout:end -->',
  ].join('\n');

  const parsedFm = splitFrontmatter(sampleDaily);
  assert.deepStrictEqual(parsedFm.tags, ['daily']);
  const flags = buildLineFlags(parsedFm.lines, parsedFm.bodyStartLine);
  assert.strictEqual(flags[5].inCode, true);
  assert.strictEqual(flags[20].inAgentDeck, true);

  // cleanTaskTitle rawMarkdown 校验：保留双链、粗体、业务标签，仅去重 #要事 / #闪念
  const { cleanTaskTitle, extractStickyMetaTags, stripDomainProjectTags } = require('../src/parsers/markdown');
  const cleanedImp = cleanTaskTitle('**08:20** #要事 推进 **重点** [[S26Q4_001|课题A]] #Project/测试 #Area/工程 #普通标签 📅 2026-11-30 ^abc123');
  assert.strictEqual(cleanedImp.rawMarkdown, '推进 **重点** [[S26Q4_001|课题A]] #Project/测试 #Area/工程 #普通标签');
  assert.strictEqual(cleanedImp.title, '推进 **重点** 课题A #普通标签');
  const cleanedIdea = cleanTaskTitle('**09:10** #闪念 使用 `code` #进度 #想法');
  assert.strictEqual(cleanedIdea.rawMarkdown, '使用 `code` #进度 #想法');

  // extractStickyMetaTags 与 stripDomainProjectTags 校验
  assert.strictEqual(
    stripDomainProjectTags('推进 **重点** [[P1|项目1]] #Project/核心 #Area/工程 #普通标签'),
    '推进 **重点** [[P1|项目1]] #普通标签'
  );
  const metaSample = extractStickyMetaTags({
    tags: ['#Project/PMP考试', '#Area/未雨绸缪', '#普通标签'],
    projectName: 'PMP 考试',
    area: '未雨绸缪',
  });
  assert.deepStrictEqual(metaSample.areas.map((a) => a.label), ['未雨绸缪']);
  assert.deepStrictEqual(metaSample.projects.map((p) => p.label), ['PMP考试']);
  assert.deepStrictEqual(metaSample.filterAreas, ['未雨绸缪']);
  assert.deepStrictEqual(metaSample.filterProjects, ['PMP考试']);

  // 扫描闪念与要事（不扫描代码块与 Agent Deck 内）
  const scanned = scanMarkdownTasks(sampleDaily, { filePath: '06_日志/2026-11-26.md', basename: '2026-11-26', sourceKind: 'log', implicitDate: '2026-11-26' });
  assert.strictEqual(scanned.ideas.length, 1);
  assert.strictEqual(scanned.importants.length, 1);

  // 日注插入保护 Agent Deck
  const inserted = planDailyEntryInsertion(sampleDaily, {
    hhmm: '14:20',
    hour: 14,
    entryText: buildFlashEntryLine('下午灵感\n第二行', '14:20'),
  });
  const adIdx = inserted.indexOf('<!-- agent-deck:layout:start -->');
  const afternoonIdx = inserted.indexOf('## 下午');
  assert.ok(afternoonIdx !== -1 && afternoonIdx < adIdx, '新时段应插在 agent-deck 之前');
  assert.ok(inserted.includes('- [I] **14:20** 下午灵感<br>第二行'));
  assert.strictEqual(buildImportantEntryLine('#要事 处理问题', '09:05'), '- [i] **09:05** #要事 处理问题');

  // 日注时间轴（仅识别粗体时间戳）
  const tl = parseDailyJournalTimeline(sampleDaily, '06_日志/2026-11-26.md');
  assert.strictEqual(tl.periods['清晨'].length, 3);
  assert.strictEqual(tl.periods['清晨'][0].timeLabel, '08:00');
  const active = parseDailyActiveStatus(sampleDaily);
  assert.strictEqual(active.counts.aiDoing, 1);

  // Agent Deck 今日执行解析与写回
  assert.strictEqual(classifyAgentDeckKeyword('TODOFORAI'), 'todo');
  assert.strictEqual(classifyAgentDeckKeyword('TOREVIEW'), 'doing');
  const execTasks = parseExecutionTasksFromDaily(sampleDaily, '06_日志/2026-11-26.md', '2026-11-26', 100);
  assert.strictEqual(execTasks.length, 2);
  assert.strictEqual(execTasks[0].hasRobot, true);
  assert.strictEqual(execTasks[0].children.length, 2);
  assert.strictEqual(patchAgentDeckTaskKeyword('- TODO [#A] 写单测', 'DONE'), '- DONE [#A] 写单测');
  const removed = planRemoveTaskBlock(sampleDaily, execTasks[0]);
  assert.strictEqual(removed.removedLines.length, 3);
  const reInserted = planExecutionTaskInsertion(removed.nextContent, ['- TODO 新执行']);
  assert.ok(reInserted.includes('- TODO 新执行'));

  // 项目解析、任务 patch 与甘特依赖
  const projMd = [
    '---',
    'tags: [doing, Area/工程]',
    'aliases: ["#Project/测试项目"]',
    '---',
    '(name:: 测试项目)',
    '# 规划',
    '- [/] 需求分析 🛫 2026-11-20 📅 2026-11-24 🆔 t1a',
    '- [ ] 编码实现 ⏳ 2026-11-22 📅 2026-11-25',
    '- [ ] 联调发布 ⏳ 2026-11-23 📅 2026-11-26 🆔 t3c ⛔ t2b',
    '- [x] 环境准备 📅 2026-11-19',
  ].join('\n');

  const proj = parseProjectNote(projMd, '04_Project/P99_1.md', null, 100);
  assert.strictEqual(proj.name, '测试项目');
  assert.strictEqual(proj.doneCount, 1);
  assert.strictEqual(proj.totalCount, 4);
  assert.strictEqual(proj.progressPct, 25);

  const t1 = proj.ganttTasks[0];
  const t2 = proj.ganttTasks[1];
  const t3 = proj.ganttTasks[2];

  // 自连 & 环检测 & 顺延
  assert.strictEqual(planAddTaskDependency(proj.ganttTasks, t1, t1).reason, 'self');
  const depPlan = planAddTaskDependency(proj.ganttTasks, t1, t2, () => 't2new');
  assert.strictEqual(depPlan.ok, true);
  assert.strictEqual(depPlan.shiftedCount, 1, 't2 原 2026-11-22 早于 t1 结束 2026-11-24，应顺延');
  const patchedT2 = patchTaskLine(t2.rawLine, depPlan.patches.find((p) => p.task === t2).patch);
  assert.ok(patchedT2.includes('⏳ 2026-11-24') && patchedT2.includes('📅 2026-11-27') && patchedT2.includes('⛔ t1a'));

  const rmPlan = planRemoveTaskDependency(t3, 't2b');
  assert.strictEqual(rmPlan.ok, true);
  assert.strictEqual(patchTaskLine(t3.rawLine, rmPlan.patches[0].patch).includes('⛔'), false);
  assert.ok(buildOrthogonalDepPath(10, 20, 60, 50).startsWith('M 10 20'));

  // 螺旋图 offset
  assert.strictEqual(computeSpiralOffset({ today: () => ({ format: () => '2026-11-26' }) }, '2026-11-24'), -2);

  // 闪念项目筛选仅保留进行中的项目标签与名称
  const doingLabels = collectDoingProjectLabels([
    { status: 'doing', name: 'PMP 考试', aliases: ['#Project/PMP考试'] },
    { status: 'done', name: '25 年春季求职', aliases: ['#Project/求职'] },
    { status: 'cancel', name: '考研', aliases: ['#Project/考研'] },
  ]);
  assert.deepStrictEqual(Array.from(doingLabels).sort(), ['PMP 考试', 'PMP考试']);
}

// ======================== 2. 增量缓存 VaultDataStore 测试 ========================

async function testIncrementalStore() {
  const { VaultDataStore } = require('../src/services/data-store');
  const app = createMockApp({
    '04_Project/P25_2.md': '---\ntags: [doing]\n---\n(name:: 项目P25)\n# 规划\n- [/] 任务A ⏳ 2026-11-24 📅 2026-11-28\n',
    '06_日志/2026-11-26.md': '## 今日执行\n- TODO 初始任务\n## 上午\n- [I] **09:00** 初始闪念\n',
    '06_日志/2026-11-25.md': '## 上午\n- [I] **10:00** 昨日闪念\n',
    '07_Resource/foo.md': '# 普通笔记\n内容',
  });

  const store = new VaultDataStore(app);
  await store.loadAll();
  assert.strictEqual(app._getCachedReadCount(), 3);

  // Case A: 修改单个项目文件 -> 只读 1 次，且只标记 gantt + recent
  app._resetCachedReadCount();
  app._addOrUpdateFile('04_Project/P25_2.md', '---\ntags: [doing]\n---\n(name:: 项目P25)\n# 规划\n- [x] 任务A ⏳ 2026-11-24 📅 2026-11-28 ✅ 2026-11-26\n', 1002);
  const dProj = await store.handleBatchChanges([{ type: 'modify', path: '04_Project/P25_2.md' }]);
  assert.strictEqual(app._getCachedReadCount(), 1, '改单个项目只应读取该文件 1 次');
  assert.strictEqual(dProj.gantt, true);
  assert.strictEqual(dProj.recent, true);
  assert.strictEqual(dProj.tasks, false);
  assert.strictEqual(dProj.journal, false);
  assert.strictEqual(dProj.sticky, false);
  assert.strictEqual(store.state.projects[0].doneCount, 1);

  // Case A2: 项目状态从 doing 变为 done -> 应标记 gantt + sticky
  app._addOrUpdateFile('04_Project/P25_2.md', '---\ntags: [done]\n---\n(name:: 项目P25)\n# 规划\n- [x] 任务A ⏳ 2026-11-24 📅 2026-11-28 ✅ 2026-11-26\n', 1003);
  const dProjDone = await store.handleBatchChanges([{ type: 'modify', path: '04_Project/P25_2.md' }]);
  assert.strictEqual(dProjDone.gantt, true);
  assert.strictEqual(dProjDone.sticky, true, '项目完成应触发随手晾晾项目筛选列表刷新');

  // Case B: 修改单个日志文件 -> 只读 1 次，且不标记 gantt
  app._resetCachedReadCount();
  const todayPath = `06_日志/${store.state.journalDate}.md`;
  app._addOrUpdateFile(todayPath, '## 今日执行\n- DOING 新执行任务\n## 上午\n- [I] **09:00** 更新闪念\n', 1003);
  const dLog = await store.handleBatchChanges([{ type: 'modify', path: todayPath }]);
  assert.strictEqual(app._getCachedReadCount(), 1, '改单个日志只应读取该文件 1 次');
  assert.strictEqual(dLog.gantt, false, '日志改动不应触发甘特图重绘');
  assert.strictEqual(dLog.tasks, true);
  assert.strictEqual(dLog.sticky, true);
  assert.strictEqual(dLog.journal, true);
  assert.strictEqual(dLog.spiral, true);

  // Case C: 修改普通笔记 -> 0 次文件读取，仅 recent
  app._resetCachedReadCount();
  app._addOrUpdateFile('07_Resource/foo.md', '# 普通笔记\n新内容', 1004);
  const dRes = await store.handleBatchChanges([{ type: 'modify', path: '07_Resource/foo.md' }]);
  assert.strictEqual(app._getCachedReadCount(), 0, '普通笔记改动不应触发 cachedRead');
  assert.strictEqual(dRes.recent, true);
  assert.strictEqual(dRes.gantt, false);
  assert.strictEqual(dRes.tasks, false);
  assert.strictEqual(dRes.journal, false);

  // Case D: 自定义 Periodic Notes 周志目录文件变更应触发 calendar 刷新
  app.plugins.plugins['periodic-notes'] = {
    settings: { weekly: { enabled: true, folder: '08_周志', format: 'gggg[W]ww', template: '' } },
  };
  app._addOrUpdateFile('08_周志/2026W48.md', '# 2026W48', 1005);
  const dWeekly = await store.handleBatchChanges([{ type: 'create', path: '08_周志/2026W48.md' }]);
  assert.strictEqual(dWeekly.calendar, true, '自定义周志目录变更应触发 calendar dirty');
}

// ======================== 3. 打包产物加载与滚动位置保持测试 ========================

async function testBundledPluginAndScrollPreservation() {
  const { document: mockDoc } = createMockDOM();
  global.document = mockDoc;
  let mockSelectionText = '';
  global.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    open: () => {},
    getSelection: () => ({ toString: () => mockSelectionText }),
  };
  global.requestAnimationFrame = (cb) => cb();

  const mockObsidian = createMockObsidianClasses();
  const forbiddenModules = [];
  const origLoad = Module._load;
  let CarrotHomePlugin;

  Module._load = function (request, parent, isMain) {
    if (request === 'obsidian') return mockObsidian;
    if (['fs', 'path', 'os', 'http', 'https', 'crypto', 'child_process'].includes(request)) {
      forbiddenModules.push(request);
    }
    return origLoad.call(this, request, parent, isMain);
  };

  try {
    const mainPath = path.join(PLUGIN_ROOT, 'main.js');
    delete require.cache[require.resolve(mainPath)];
    CarrotHomePlugin = require(mainPath);
  } finally {
    Module._load = origLoad;
  }

  assert.deepStrictEqual(forbiddenModules, [], `移动端兼容插件不应 require Node 内置模块，实际: ${forbiddenModules.join(',')}`);
  assert.strictEqual(typeof CarrotHomePlugin, 'function');

  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const todayYmd = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

  const app = createMockApp({
    '04_Project/P1.md': [
      '---',
      'tags: [doing]',
      'aliases: ["#Project/核心"]',
      '---',
      '(name:: 核心项目)',
      '# 规划',
      `- [/] 前置任务 ⏳ ${todayYmd} 📅 ${todayYmd}`,
      `- [ ] 后续任务 ⏳ ${todayYmd} 📅 ${todayYmd}`,
    ].join('\n'),
    '04_Project/P2_done.md': [
      '---',
      'tags: [done]',
      'aliases: ["#Project/已完结"]',
      '---',
      '(name:: 已完结项目)',
      '# 规划',
      '- [x] 收尾归档',
    ].join('\n'),
    '04_Project/P3_cancel.md': [
      '---',
      'tags: [cancel]',
      'aliases: ["#Project/已取消"]',
      '---',
      '(name:: 已取消项目)',
      '# 规划',
      '- [-] 已作废任务',
    ].join('\n'),
    [`06_日志/${todayYmd}.md`]: [
      '## 今日执行',
      '- DOING **重点** 人工任务 `cli` #执行 30m',
      '\t- 🎯 目标：验证 **子块** #子标签 [[P1|项目1]]',
      '- TODO 🤖 AI任务 15m',
      '## 清晨',
      '- [i] **08:15** #要事 推进 **要事渲染** [[P1|项目1]] #Project/核心',
      '- **08:30** 完成 **粗体** 与 `行内代码` #工作流 [[S26Q4_001|课题A]]',
      '\t- **结论**：子记录也支持 #子块标签',
      '## 上午',
      '- [I] **09:00** 测试 **闪念粗体**<br>第二行 #闪念标签 [[P1|项目1]]',
      '- [I] **09:05** 测试闪念2',
      '- [I] **09:06** 已完结项目闪念 #Project/已完结',
      '- [I] **09:07** 已取消项目闪念 #Project/已取消',
      '## 下午',
      '- **14:00** 下午测试条目',
      '## 晚上',
      '- **19:00** 晚上测试条目',
    ].join('\n'),
    '02_模版/周志-xdb.md': [
      '# 周志 {{title}}',
      'range: {{weekStart}}..{{weekEnd}}',
      'mon: {{monday:YYYY-MM-DD}} sun: {{sunday:YYYY-MM-DD}}',
    ].join('\n'),
    '07_Resource/手册.pdf': 'pdf-binary',
  });
  app.plugins.plugins['periodic-notes'] = {
    settings: {
      weekly: {
        enabled: true,
        folder: '06_日志',
        format: 'gggg[W]ww',
        template: '02_模版/周志-xdb.md',
      },
    },
  };
  app._addOrUpdateFolder('05_Study/专题');

  const subProjGroup = {
    type: 'group',
    title: '项目子组',
    items: [{ type: 'file', path: '04_Project/P1.md', title: '核心项目笔记' }],
  };
  const workGroup = {
    type: 'group',
    title: '工作区',
    items: [subProjGroup, { type: 'url', title: '外部参考', url: 'https://obsidian.md' }],
  };
  const emptyGroup = { type: 'group', title: '空分组', items: [] };
  const bmInst = app.internalPlugins.plugins.bookmarks.instance;
  bmInst.items.push(
    workGroup,
    emptyGroup,
    { type: 'folder', path: '05_Study/专题' },
    { type: 'search', query: 'tag:#工作流' },
    { type: 'graph', title: '图谱视图', options: {} },
    { type: 'file', path: 'missing/gone.md' }
  );
  for (let i = 0; i < 10; i++) {
    bmInst.items.push({ type: 'file', path: '04_Project/P1.md', subpath: `#H${i}`, title: `锚点${i}` });
  }

  const plugin = new CarrotHomePlugin(app, { id: 'carrot-home' });
  plugin.loadData = async () => ({ ganttStatusFilter: 'all' });
  await plugin.onload();

  assert.ok(plugin._views.has('carrot-home-view'), '应注册 carrot-home-view');
  assert.ok(plugin._commands.some((c) => c.id === 'open'), '应注册 open 命令');
  assert.strictEqual(plugin._ribbons.length, 1, '应注册 Ribbon 图标');
  assert.strictEqual(plugin._settingTabs.length, 1, '应注册设置页');

  const leaf = await plugin.activateView();
  assert.ok(leaf && leaf.view, 'activateView 应成功打开 CarrotHomeView');
  const view = leaf.view;

  // 等待首次数据加载与渲染完成
  await new Promise((r) => setTimeout(r, 20));

  const scrollRef = view.scrollEl;
  assert.ok(scrollRef && scrollRef.classList.contains('ch-scroll'), '应存在 .ch-scroll 滚动容器');
  scrollRef.scrollTop = 640;

  function assertScrollIntact(label) {
    assert.strictEqual(view.scrollEl, scrollRef, `${label}: .ch-scroll DOM 引用不得被重建`);
    assert.strictEqual(view.contentEl.querySelector('.ch-scroll'), scrollRef, `${label}: contentEl 内应保持同一 .ch-scroll`);
    assert.strictEqual(scrollRef.scrollTop, 640, `${label}: 垂直滚动条 scrollTop 不得跳回页首`);
  }

  // 1) 甘特图缩放（日 / 周 / 月 / − / +）与默认状态筛选（「进行中」）
  const ganttSlot = view.contentEl.querySelector('.ch-slot-gantt');
  assert.strictEqual(view.store.state.ganttStatusFilter, 'doing', '甘特图默认筛选状态应为 doing');
  assert.strictEqual('ganttStatusFilter' in plugin.settings, false, 'plugin.settings 不应保留 ganttStatusFilter');
  const getGanttPill = (prefix) => ganttSlot.querySelectorAll('.ch-pill').find((b) => b.textContent.startsWith(prefix));
  const getGanttProjNames = () => ganttSlot.querySelectorAll('.ch-gantt-proj-name').map((el) => el.textContent);
  assert.strictEqual(getGanttPill('进行中')?.textContent, '进行中 1');
  assert.strictEqual(getGanttPill('进行中')?.classList.contains('is-active'), true, '默认应高亮进行中筛选按钮');
  assert.strictEqual(getGanttPill('全部')?.textContent, '全部 2');
  assert.strictEqual(getGanttPill('全部')?.classList.contains('is-active'), false, '即使旧 data.json 为 all，默认也不得高亮全部');
  assert.deepStrictEqual(getGanttProjNames(), ['核心项目'], '甘特图默认应仅展示进行中的项目');

  const ganttRight0 = ganttSlot.querySelector('.ch-gantt-right');
  ganttRight0.scrollLeft = 320;
  view.store.state.ganttScrollLeft = 320;

  for (const label of ['日', '周', '月', '−', '+']) {
    const btn = ganttSlot.querySelectorAll('button').find((b) => b.textContent === label);
    assert.ok(btn, `应找到甘特图缩放按钮 ${label}`);
    btn.click();
    assertScrollIntact(`甘特图缩放[${label}]`);
    assert.strictEqual(ganttSlot.querySelector('.ch-gantt-right').scrollLeft, 320, `缩放[${label}]应保持横向 scrollLeft`);
  }

  // 2) 甘特图状态筛选（全部 / 进行中 / 逾期 / 已完成）
  for (const prefix of ['全部', '进行中', '逾期', '已完成']) {
    const pill = getGanttPill(prefix);
    assert.ok(pill, `应找到甘特图状态筛选 ${prefix}`);
    pill.click();
    assertScrollIntact(`甘特图状态筛选[${prefix}]`);
  }
  getGanttPill('全部').click();
  assert.deepStrictEqual(getGanttProjNames(), ['核心项目', '已完结项目'], '切换全部后应展示所有非取消项目');
  assert.strictEqual('ganttStatusFilter' in plugin.settings, false, '切换筛选不应写入 plugin.settings');
  getGanttPill('已完成').click();
  assert.deepStrictEqual(getGanttProjNames(), ['已完结项目'], '切换已完成后应仅展示已完成项目');
  // 切回进行中以便测试展开
  getGanttPill('进行中').click();
  assert.deepStrictEqual(getGanttProjNames(), ['核心项目'], '切回进行中后应仅展示进行中项目');

  // 3) 甘特图展开项目 + 建立/断开依赖
  const expBtn = ganttSlot.querySelector('.ch-gantt-row-left .ch-tiny-icon-btn');
  assert.ok(expBtn, '应找到项目展开按钮');
  expBtn.click();
  assertScrollIntact('甘特图展开项目');
  assert.ok(ganttSlot.querySelectorAll('.ch-gantt-row-left.is-task').length === 2, '展开后应展示 2 个子任务');

  const gTasks = view.store.state.projects[0].ganttTasks;
  await view.store.actions.handleAddGanttDependency(gTasks[0], gTasks[1]);
  assertScrollIntact('甘特图建立依赖');
  assert.strictEqual(ganttSlot.querySelector('.ch-gantt-right').scrollLeft, 320, '建立依赖后横向 scrollLeft 应保持');

  const gTasksAfter = view.store.state.projects[0].ganttTasks;
  await view.store.actions.handleRemoveGanttDependency(gTasksAfter[0], gTasksAfter[1]);
  assertScrollIntact('甘特图断开依赖');

  // 4) 任务工作区筛选（仅人工 / 仅 🤖 AI / 全部 / 清单 / 看板 / 密度 大中小 / 显示已完成）
  const tasksSlot = view.contentEl.querySelector('.ch-slot-tasks');
  for (const lbl of ['仅人工', '仅 🤖 AI', '全部', '清单', '看板', '大', '小', '中']) {
    const btn = tasksSlot.querySelectorAll('.ch-seg-tab').find((b) => b.textContent === lbl);
    assert.ok(btn, `应找到任务工作区按钮 ${lbl}`);
    btn.click();
    assertScrollIntact(`任务工作区[${lbl}]`);
  }
  const scopeOpen = tasksSlot.querySelectorAll('.ch-pill').find((b) => b.textContent.startsWith('全部待办'));
  scopeOpen.click();
  assertScrollIntact('任务工作区[全部待办]');

  // 5) 随手晾晾「换一批」与折叠
  const stickySlot = view.contentEl.querySelector('.ch-slot-sticky');
  const shuffleBtn = stickySlot.querySelectorAll('button').find((b) => b.textContent === '换一批');
  assert.ok(shuffleBtn, '应找到随手晾晾换一批按钮');
  shuffleBtn.click();
  assertScrollIntact('随手晾晾[换一批]');

  // 5.5) 原生 MarkdownRenderer 渲染、交互接管、防误触与 Component 生命周期断言
  // A) 随手晾晾便签：要事 + 闪念应原生渲染粗体、普通标签、双链，#Project/核心 移到右上角，正文去掉 #要事 与领域/项目标签
  const impCard = stickySlot.querySelector('.ch-sticky-card.is-important');
  assert.ok(impCard, '应渲染要事便签');
  const impHeadProjChip = impCard.querySelector('.ch-sticky-card-head .ch-sticky-meta-tag.is-project');
  assert.strictEqual(impHeadProjChip?.textContent, '核心', '便签右上角应展示项目标签「核心」');
  const impBody = impCard.querySelector('.ch-sticky-card-body');
  assert.ok(impBody.querySelector('strong')?.textContent === '要事渲染', '便签应渲染粗体 <strong>');
  assert.ok(!impBody.querySelectorAll('a.tag').some((a) => a.textContent === '#Project/核心'), '便签正文不应保留 #Project/核心');
  assert.ok(!impBody.querySelectorAll('a.tag').some((a) => a.textContent === '#要事'), '便签应去重 #要事 标签');
  const ideaCardWithTag = stickySlot.querySelectorAll('.ch-sticky-card').find((c) => !c.classList.contains('is-important') && c.querySelector('.ch-sticky-card-body a.tag'));
  assert.ok(ideaCardWithTag, '普通标签 #闪念标签 应仍保留在闪念正文内');

  // 点击右上角项目标签进行筛选，再点「清除筛选」恢复
  impHeadProjChip.click();
  assertScrollIntact('随手晾晾[按项目筛选]');
  assert.strictEqual(stickySlot.querySelectorAll('.ch-sticky-card').length, 1, '按项目「核心」筛选后应仅显示 1 张匹配卡片');
  const resetFilterBtn = stickySlot.querySelector('.ch-sticky-filter-reset');
  assert.ok(resetFilterBtn, '筛选激活时应显示清除筛选按钮');
  resetFilterBtn.click();
  assertScrollIntact('随手晾晾[清除筛选]');
  assert.ok(stickySlot.querySelectorAll('.ch-sticky-card').length >= 3, '清除筛选后应恢复显示所有便签');

  // 随手晾晾项目筛选下拉框仅包含进行中的项目（排除已完成 / 已取消项目）
  const projSelect = stickySlot.querySelector('select[data-filter="project"]');
  assert.ok(projSelect, '应渲染项目筛选下拉框');
  assert.deepStrictEqual(
    projSelect.children.map((o) => o.value),
    ['', '核心'],
    '闪念项目筛选下拉框应仅包含进行中项目「核心」，不包含已完成或已取消项目'
  );
  const doneIdeaCard = stickySlot
    .querySelectorAll('.ch-sticky-card')
    .find((c) => c.querySelector('.ch-sticky-card-body')?.textContent.includes('已完结项目闪念'));
  assert.ok(doneIdeaCard, '应渲染带已完成项目标签的闪念卡片');
  const staticProjChip = doneIdeaCard.querySelector('.ch-sticky-meta-tag.is-project.is-static');
  assert.ok(staticProjChip, '已完成项目的卡片标签应渲染为不可筛选的静态标签 .is-static');
  assert.strictEqual(staticProjChip.tagName, 'SPAN', '非进行中项目标签应为 span 而非 button');
  staticProjChip.click();
  assert.strictEqual(view.store.state.stickyProjectFilter, '', '点击非进行中项目标签不得激活筛选');

  // 若选中的项目不再处于进行中，刷新时应自动清空 stickyProjectFilter
  view.store.state.stickyProjectFilter = '已完结';
  view.stickyHeader.updateSticky();
  assert.strictEqual(view.store.state.stickyProjectFilter, '', '非进行中项目的筛选条件应自动清空');

  // 点击便签内部双链 -> 打开链接，不触发整张便签打开文件
  const stickyLink = impBody.querySelector('a.internal-link');
  assert.ok(stickyLink, '便签应渲染双链 a.internal-link');
  const beforeOpenFileCount = app._openFileCalls.length;
  stickyLink.click({ metaKey: true });
  assert.strictEqual(app._openLinkTextCalls.length, 1, '点击便签双链应调用 openLinkText');
  assert.strictEqual(app._openLinkTextCalls[0].linktext, 'P1');
  assert.strictEqual(app._openLinkTextCalls[0].newLeaf, true, 'Cmd/Ctrl 点击应新标签打开');
  assert.strictEqual(app._openFileCalls.length, beforeOpenFileCount, '点击便签双链不应触发便签本身 openFile');

  // 划词选中时点击便签不应跳转
  mockSelectionText = '要事渲染';
  impCard.click();
  assert.strictEqual(app._openFileCalls.length, beforeOpenFileCount, '划词选中时点击便签不应误触跳转');
  mockSelectionText = '';

  // B) 日注卡片：切到「清晨」并校验主条目 + 折叠子记录原生渲染与交互
  const journalSlot = view.contentEl.querySelector('.ch-slot-journal');
  const morningBtn = journalSlot.querySelectorAll('.ch-period-btn').find((b) => b.textContent.includes('清晨'));
  assert.ok(morningBtn, '应找到清晨时段按钮');
  morningBtn.click();
  assertScrollIntact('日注切换时段[清晨]');

  const journalStrongs = journalSlot.querySelectorAll('.ch-tl-body strong').map((s) => s.textContent);
  assert.ok(journalStrongs.includes('粗体') && journalStrongs.includes('要事渲染'), '日注主条目应渲染粗体');
  assert.ok(journalSlot.querySelector('.ch-tl-body code')?.textContent === '行内代码', '日注主条目应渲染行内代码');
  const journalTag = journalSlot.querySelectorAll('.ch-tl-body a.tag').find((a) => a.textContent === '#工作流');
  assert.ok(journalTag, '日注主条目应渲染 #工作流 标签');

  // 日注时间轴条目徽标头部标记 .has-badge
  const tlHeadRows = journalSlot.querySelectorAll('.ch-tl-head-row');
  const tlBadgeRows = journalSlot.querySelectorAll('.ch-tl-head-row.has-badge');
  assert.strictEqual(tlHeadRows.length, 2, '清晨应渲染 2 条日注时间轴头部');
  assert.strictEqual(tlBadgeRows.length, 1, '仅含条目徽标的日注条目应标记 .has-badge');
  assert.strictEqual(tlBadgeRows[0].querySelector('.ch-tl-badge')?.textContent, '要事');

  // 点击日注 #标签 -> 触发 global-search
  journalTag.click();
  assert.strictEqual(app._globalSearchQueries[0], 'tag:#工作流', '点击标签应触发 tag:#工作流 全局搜索');

  // 悬停双链 -> 触发 hover-link
  const journalLink = journalSlot.querySelector('.ch-tl-body a.internal-link');
  assert.ok(journalLink, '日注主条目应渲染双链');
  journalLink.dispatchEvent({ type: 'mouseover', target: journalLink });
  assert.strictEqual(app._hoverLinkEvents.length, 1, '悬停双链应触发 hover-link 预览');
  assert.strictEqual(app._hoverLinkEvents[0].linktext, 'P1');

  // 点击双链在有折叠子记录的日注卡片上不应触发折叠展开
  const tlCardWithChild = journalSlot.querySelector('.ch-tl-card.has-children');
  assert.ok(tlCardWithChild, '应存在带子记录的日注卡片');
  const tlLink = tlCardWithChild.querySelector('.ch-tl-body a.internal-link');
  tlLink.click();
  assert.strictEqual(tlCardWithChild.querySelector('.ch-tl-children'), null, '点击双链不应误触展开折叠子记录');

  // 展开日注子记录，校验子记录也原生渲染粗体与标签
  tlCardWithChild.querySelector('.ch-tl-fold-bar').click();
  assertScrollIntact('日注展开子记录');
  const expandedTlCard = journalSlot.querySelector('.ch-tl-card.has-children');
  const childStrong = expandedTlCard.querySelector('.ch-tl-children strong');
  const childTag = expandedTlCard.querySelector('.ch-tl-children a.tag');
  assert.strictEqual(childStrong?.textContent, '结论', '日注折叠子记录应渲染粗体');
  assert.strictEqual(childTag?.textContent, '#子块标签', '日注折叠子记录应渲染标签');

  // C) 任务工作区：标题与折叠子记录原生渲染
  const taskBadgeTops = tasksSlot.querySelectorAll('.ch-task-top.has-badge');
  assert.ok(taskBadgeTops.length >= 1, '含条目徽标的任务卡片头部应标记 .has-badge');
  for (const top of taskBadgeTops) {
    assert.ok(top.querySelector('.ch-tl-badge'), '.ch-task-top.has-badge 应包含 .ch-tl-badge');
    assert.ok(top.querySelector('.ch-checkbox'), '.ch-task-top.has-badge 应包含 .ch-checkbox');
    assert.ok(top.querySelector('.ch-task-title'), '.ch-task-top.has-badge 应包含 .ch-task-title');
  }
  const bundledCss = fs.readFileSync(path.join(PLUGIN_ROOT, 'styles.css'), 'utf8');
  assert.ok(bundledCss.includes('container-name: ch-tl-card;'), 'styles.css 应声明 ch-tl-card 容器查询');
  assert.ok(bundledCss.includes('@container ch-tl-card (max-width: 440px)'), 'styles.css 应包含日注卡片 440px 容器查询');
  assert.ok(bundledCss.includes('.ch-root.ch-narrow .ch-tl-item'), 'styles.css 应包含窄屏日注时间轴单列布局');
  assert.ok(bundledCss.includes('.ch-root.ch-compact .ch-tl-item'), 'styles.css 应包含紧凑屏日注时间轴单列布局');
  assert.ok(bundledCss.includes('grid-template-columns: minmax(0, 1fr);'), 'styles.css 窄屏日注条目应使用 minmax(0, 1fr)');
  assert.ok(bundledCss.includes('.ch-root.ch-narrow .ch-tl-time-col::before'), 'styles.css 窄屏下应隐藏时间轴竖线');
  assert.ok(bundledCss.includes('position: static;'), 'styles.css 窄屏下时间圆点应复位为 static');
  assert.strictEqual(bundledCss.includes('grid-template-columns: 62px minmax(0, 1fr);'), false, 'styles.css 不应保留旧的 62px 左侧时间列样式');
  assert.ok(bundledCss.includes('container-name: ch-task-card;'), 'styles.css 应声明 ch-task-card 容器查询');
  assert.ok(bundledCss.includes('@container ch-task-card (max-width: 360px)'), 'styles.css 应包含任务卡片 360px 容器查询');
  assert.ok(bundledCss.includes('.ch-root.ch-narrow .ch-right-col'), 'styles.css 应包含窄屏展平右栏规则');
  assert.ok(bundledCss.includes('display: contents;'), 'styles.css 应包含 display: contents 规则');
  assert.ok(bundledCss.includes('.ch-root.ch-narrow .ch-slot-journal'), 'styles.css 应包含窄屏日注排序规则');
  assert.ok(bundledCss.includes('order: 2;'), 'styles.css 窄屏日注应排在 order: 2');
  assert.ok(bundledCss.includes('.ch-root.ch-narrow .ch-slot-calendar'), 'styles.css 应包含窄屏日历排序规则');
  assert.ok(bundledCss.includes('order: 3;'), 'styles.css 窄屏日历应排在 order: 3');
  const headerEl = view.contentEl.querySelector('.ch-header');
  assert.ok(headerEl && headerEl.children.length === 2, '顶部 .ch-header 应包含 2 个子槽位');
  assert.ok(headerEl.children[0].classList.contains('ch-focus-slot'), '顶部左栏应为螺旋日程槽位 .ch-focus-slot');
  assert.ok(headerEl.children[1].classList.contains('ch-hero-slot'), '顶部右栏应为工作台标题搜索槽位 .ch-hero-slot');
  assert.ok(bundledCss.includes('grid-template-columns: auto minmax(0, 1fr);'), 'styles.css 顶部两栏应为 auto minmax(0, 1fr)');
  assert.strictEqual(bundledCss.includes('grid-template-columns: minmax(0, 1fr) auto;'), false, 'styles.css 不应保留旧的 minmax(0, 1fr) auto 顺序');
  assert.ok(bundledCss.includes('.ch-root.ch-medium .ch-header.no-spiral'), 'styles.css 应包含中屏隐藏螺旋图时的单栏覆盖');
  assert.ok(bundledCss.includes('left: 0;\n  right: auto;'), 'styles.css 螺旋图 AI 悬停卡片应向右展开');

  const execTitle = tasksSlot.querySelector('.ch-task-title');
  assert.ok(execTitle.querySelector('strong')?.textContent === '重点', '任务标题应渲染粗体');
  assert.ok(execTitle.querySelector('code')?.textContent === 'cli', '任务标题应渲染代码');
  assert.ok(execTitle.querySelector('a.tag')?.textContent === '#执行', '任务标题应渲染标签');
  const execFold = tasksSlot.querySelector('.ch-task-card .ch-tl-fold-bar');
  assert.ok(execFold, '任务应有折叠子记录');
  execFold.click();
  assertScrollIntact('任务展开子记录');
  assert.strictEqual(tasksSlot.querySelector('.ch-task-card .ch-tl-children strong')?.textContent, '子块');
  assert.strictEqual(tasksSlot.querySelector('.ch-task-card .ch-tl-children a.tag')?.textContent, '#子标签');
  assert.strictEqual(tasksSlot.querySelector('.ch-task-card .ch-tl-children a.internal-link')?.getAttribute('data-href'), 'P1');

  // 6) 后台文件变动（项目 + 日志）
  await view.refreshPaths(['04_Project/P1.md']);
  assertScrollIntact('后台刷新项目文件');
  await view.refreshPaths([`06_日志/${todayYmd}.md`]);
  assertScrollIntact('后台刷新日志文件');

  // 6.2) 左栏日历周数列、月视图固定化与 Periodic Notes 周志联动
  const leftColEl = view.contentEl.querySelector('.ch-left-col');
  assert.ok(leftColEl.querySelector('.ch-slot-clock'), '左栏应包含 .ch-slot-clock');
  assert.ok(leftColEl.querySelector('.ch-slot-calendar'), '左栏应包含 .ch-slot-calendar');
  assert.ok(leftColEl.querySelector('.ch-slot-bookmarks'), '左栏应包含 .ch-slot-bookmarks');
  assert.ok(leftColEl.querySelector('.ch-slot-recent'), '左栏应包含 .ch-slot-recent');
  assert.strictEqual(leftColEl.querySelector('.ch-seg-tabs'), null, '左栏日历不得存在 月/周/日 切换标签');
  assert.strictEqual('calMode' in view.store.state, false, 'store.state 不得保留 calMode');
  const wdEls = leftColEl.querySelectorAll('.ch-cal-wd');
  assert.deepStrictEqual(
    wdEls.map((w) => w.textContent),
    ['W', '一', '二', '三', '四', '五', '六', '日'],
    '日历表头应为 8 列（W + 一..日）'
  );
  const weekCells = leftColEl.querySelectorAll('.ch-cal-week-cell');
  const dayCells = leftColEl.querySelectorAll('.ch-cal-cell');
  assert.strictEqual(weekCells.length, 6, '月视图应固定渲染 6 个周数格');
  assert.strictEqual(dayCells.length, 42, '月视图应固定渲染 42 个日期格');
  for (const wc of weekCells) {
    assert.match(wc.querySelector('.ch-cal-week-label')?.textContent || '', /^\d{1,2}$/, '周数格应仅展示纯数字周号');
  }
  assert.ok(bundledCss.includes('.ch-root .ch-cal-grid::before'), 'styles.css 应包含 .ch-root .ch-cal-grid::before 连续垂直分隔线样式');
  assert.ok(bundledCss.includes('.ch-root button.ch-cal-week-cell'), 'styles.css 应包含 .ch-root button.ch-cal-week-cell 优先级提升样式');
  assert.ok(bundledCss.includes('.ch-root button.ch-cal-cell'), 'styles.css 应包含 .ch-root button.ch-cal-cell 优先级提升样式');
  assert.ok(bundledCss.includes('box-shadow: none;'), 'styles.css 应显式清除日历格默认按钮阴影');
  const currentWeekCell = leftColEl.querySelector('.ch-cal-week-cell.is-current-week');
  assert.ok(currentWeekCell, '本周所在行应高亮 .is-current-week');

  // 选中某日期 -> 联动对应周 .is-selected-week
  const targetDayCell = dayCells[10];
  targetDayCell.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(leftColEl.querySelector('.ch-cal-week-cell.is-selected-week'), '选中日期后所在周应标记 .is-selected-week');
  targetDayCell.click();
  await new Promise((r) => setTimeout(r, 10));

  // 月末边界：3 月 31 日点上一月应来到 2 月而非跳过
  view.store.state.calCursorYMD = '2026-03-31';
  view.leftCol.updateCalendar();
  leftColEl.querySelector('.ch-cal-nav-left button').click();
  assert.ok(leftColEl.querySelector('.ch-cal-nav').textContent.includes('2026年 2月'), '3月31日点上一月应显示2026年 2月');
  leftColEl.querySelectorAll('.ch-cal-nav-left button')[1].click();

  // 点击不存在的周志 -> 按 Periodic Notes 预设和模板创建并打开
  const freshWeekCell = leftColEl.querySelectorAll('.ch-cal-week-cell').find((c) => !c.classList.contains('has-note'));
  assert.ok(freshWeekCell, '应存在尚未创建周志的周数格');
  const freshWeekPath = freshWeekCell.dataset.weekPath;
  const freshWeekTitle = freshWeekCell.dataset.weekTitle;
  freshWeekCell.click();
  await new Promise((r) => setTimeout(r, 10));
  assertScrollIntact('点击周数创建周志');
  const createdWeeklyFile = app.vault.getAbstractFileByPath(freshWeekPath);
  assert.ok(createdWeeklyFile, `应按预设路径创建周志 ${freshWeekPath}`);
  assert.ok(createdWeeklyFile._content.includes(`# 周志 ${freshWeekTitle}`), '周志模板应替换 {{title}}');
  assert.ok(!createdWeeklyFile._content.includes('{{'), '周志模板不应残留未替换占位符');
  assert.strictEqual(app._openFileCalls[app._openFileCalls.length - 1].path, freshWeekPath);
  assert.strictEqual(app._openFileCalls[app._openFileCalls.length - 1].newTab, false);

  const refreshedWeekCell = leftColEl
    .querySelectorAll('.ch-cal-week-cell')
    .find((c) => c.dataset.weekPath === freshWeekPath);
  assert.ok(refreshedWeekCell.classList.contains('has-note'), '创建周志后对应周数格应标为 .has-note');
  assert.ok(refreshedWeekCell.querySelector('.ch-cal-dot.is-weekly'), '创建周志后应显示周志存在圆点');

  // 再次点击已存在周志不覆盖原内容，且支持 Cmd/Ctrl + 单击与中键新标签打开
  createdWeeklyFile._content += '\n保留手写内容';
  refreshedWeekCell.click({ metaKey: true });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(createdWeeklyFile._content.includes('保留手写内容'), '点击已存在周志不得覆盖原内容');
  assert.strictEqual(app._openFileCalls[app._openFileCalls.length - 1].newTab, true, 'Cmd/Ctrl+单击应新标签页打开');
  refreshedWeekCell.dispatchEvent({ type: 'auxclick', button: 1, target: refreshedWeekCell });
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(app._openFileCalls[app._openFileCalls.length - 1].newTab, true, '中键单击应新标签页打开');

  // 模板缺失时应创建空白周志并弹 Notice 提醒
  app.plugins.plugins['periodic-notes'].settings.weekly.template = '02_模版/不存在.md';
  mockObsidian.Notice.history.length = 0;
  const anotherFreshWeek = leftColEl.querySelectorAll('.ch-cal-week-cell').find((c) => !c.classList.contains('has-note'));
  assert.ok(anotherFreshWeek);
  const missingTplTargetPath = anotherFreshWeek.dataset.weekPath;
  anotherFreshWeek.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(app.vault.getAbstractFileByPath(missingTplTargetPath)?._content, '', '模板缺失时应创建空白周志');
  assert.ok(mockObsidian.Notice.history.some((m) => m.includes('未找到周志模板')), '模板缺失时应弹出 Notice 提醒');

  // 顶部快捷栏「打开/创建本周周志」同样遵循 Periodic Notes 自定义预设
  app.plugins.plugins['periodic-notes'].settings.weekly = {
    enabled: true,
    folder: '08_周志',
    format: 'gggg-[W]ww',
    template: '02_模版/周志-xdb.md',
  };
  const weeklyQuickBtn = view.contentEl
    .querySelectorAll('.ch-quick-tile')
    .find((b) => b.title === '打开/创建本周周志');
  assert.ok(weeklyQuickBtn, '应找到顶部本周周志快捷按钮');
  weeklyQuickBtn.click();
  await new Promise((r) => setTimeout(r, 10));
  const lastOpenedQuick = app._openFileCalls[app._openFileCalls.length - 1].path;
  assert.ok(lastOpenedQuick.startsWith('08_周志/'), `顶部快捷按钮应遵循 Periodic Notes 预设目录，实际: ${lastOpenedQuick}`);
  // 恢复默认设置
  app.plugins.plugins['periodic-notes'].settings.weekly = {
    enabled: true,
    folder: '06_日志',
    format: 'gggg[W]ww',
    template: '02_模版/周志-xdb.md',
  };

  // 6.5) 书签完整树形同步、增删、打开与降级恢复验证
  const bmList = view.contentEl.querySelector('.ch-bm-list');
  assert.ok(bmList, '应渲染 .ch-bm-list 书签列表');
  const allGroupRows = view.contentEl.querySelectorAll('.ch-bm-group-row');
  const allItemRows = view.contentEl.querySelectorAll('.ch-bm-item-row');
  assert.strictEqual(allGroupRows.length, 3, '应渲染所有 3 个分组（含嵌套子分组）');
  assert.strictEqual(allItemRows.length, 16, '应完整渲染全部 16 条叶子书签，不得截断为 12 条');

  // 折叠与展开分组，保持外层 scrollTop
  const workGroupRow = allGroupRows.find((r) => r.textContent.includes('工作区'));
  assert.ok(workGroupRow);
  workGroupRow.click();
  assertScrollIntact('书签分组折叠');
  assert.strictEqual(view.contentEl.querySelectorAll('.ch-bm-group-row').length, 2, '折叠工作区后应隐藏子分组');
  assert.strictEqual(view.contentEl.querySelectorAll('.ch-bm-item-row').length, 14, '折叠工作区后应隐藏其下 2 条叶子书签');
  view.contentEl.querySelectorAll('.ch-bm-group-row').find((r) => r.textContent.includes('工作区')).click();
  assertScrollIntact('书签分组展开');
  assert.strictEqual(view.contentEl.querySelectorAll('.ch-bm-item-row').length, 16, '展开工作区后应恢复展示');

  // 单击、Cmd/Ctrl+单击、中键打开书签
  const searchRow = view.contentEl.querySelectorAll('.ch-bm-item-row').find((r) => r.textContent.includes('tag:#工作流'));
  assert.ok(searchRow, '应渲染搜索书签');
  searchRow.click();
  searchRow.click({ metaKey: true });
  searchRow.dispatchEvent({ type: 'auxclick', button: 1, target: searchRow });
  assert.strictEqual(app._openBookmarkCalls.length, 3, '应记录 3 次 openBookmark 调用');
  assert.strictEqual(app._openBookmarkCalls[0].newLeaf, false);
  assert.strictEqual(app._openBookmarkCalls[1].newLeaf, 'tab');
  assert.strictEqual(app._openBookmarkCalls[2].newLeaf, 'tab');

  // 失效书签检测与创建恢复、以及直接删除
  const brokenRow = view.contentEl.querySelector('.ch-bm-item-row.is-broken');
  assert.ok(brokenRow, '缺失文件应渲染 .is-broken');
  assert.ok(brokenRow.title.includes('missing/gone.md'));
  await app.vault.create('missing/gone.md', '# 已恢复');
  assert.strictEqual(view.contentEl.querySelector('.ch-bm-item-row.is-broken'), null, '补建目标文件后应自动解除失效状态');
  // 再次删除该文件使之失效，并测试点 × 直接移除
  await app.vault.delete(app.vault.getAbstractFileByPath('missing/gone.md'));
  const brokenRow2 = view.contentEl.querySelector('.ch-bm-item-row.is-broken');
  assert.ok(brokenRow2, '删除目标文件后应恢复为失效状态');
  brokenRow2.querySelector('.ch-list-row-del').click();
  assert.strictEqual(bmInst.items.some((x) => x.path === 'missing/gone.md'), false, '点 × 应直接移除失效书签');

  // 删除空分组直接移除；删除非空分组弹二次确认
  const emptyGroupRow = view.contentEl.querySelectorAll('.ch-bm-group-row').find((r) => r.textContent.includes('空分组'));
  emptyGroupRow.querySelector('.ch-list-row-del').click();
  assert.strictEqual(mockDoc.body.querySelector('.ch-modal'), null, '空分组删除不应弹出二次确认');
  assert.strictEqual(bmInst.items.includes(emptyGroup), false, '空分组应直接移除');

  const workRowForDel = view.contentEl.querySelectorAll('.ch-bm-group-row').find((r) => r.textContent.includes('工作区'));
  workRowForDel.querySelector('.ch-list-row-del').click();
  const confirmModal = mockDoc.body.querySelector('.ch-modal');
  assert.ok(confirmModal, '非空分组删除应弹出二次确认框');
  assert.ok(confirmModal.textContent.includes('工作区') && confirmModal.textContent.includes('2 条书签'));
  confirmModal.querySelector('.ch-btn.is-danger').click();
  assert.strictEqual(mockDoc.body.querySelector('.ch-modal'), null, '确认删除后弹窗应关闭');
  assert.strictEqual(bmInst.items.includes(workGroup), false, '确认后应从 Obsidian 书签移除该分组');

  // + 添加弹窗：筛选、选分组、自定义/留空标题、同组防重
  bmInst.addItem({ type: 'group', title: '新分组', items: [] });
  const addBmBtn = view.contentEl.querySelector('.ch-card-head .ch-mini-pill-btn[title=""]') ||
    view.contentEl.querySelectorAll('.ch-card').find((c) => c.querySelector('.ch-card-title')?.textContent === '书签').querySelector('.ch-mini-pill-btn');
  assert.ok(addBmBtn && addBmBtn.textContent === '+ 添加');
  addBmBtn.click();
  const addModal = mockDoc.body.querySelector('.ch-modal');
  assert.ok(addModal, '点击 + 添加应打开添加书签弹窗');
  const filterInp = addModal.querySelector('.ch-input');
  const selectEls = addModal.querySelectorAll('select.ch-select');
  assert.strictEqual(selectEls.length, 2, '存在分组时应展示目标列表与所属分组两个下拉框');
  const targetSel = selectEls[0];
  const groupSel = selectEls[1];

  // 切换到「文件」并筛选 pdf
  addModal.querySelectorAll('.ch-seg-tab').find((b) => b.textContent === '文件').click();
  filterInp.value = '手册';
  filterInp.dispatchEvent({ type: 'input', target: filterInp });
  assert.strictEqual(targetSel.value, 'file::07_Resource/手册.pdf');
  groupSel.value = '0';
  addModal.querySelector('.ch-btn.is-primary').click();
  assert.strictEqual(mockDoc.body.querySelector('.ch-modal'), null, '添加成功后应关闭弹窗');
  const newGroupRaw = bmInst.items.find((x) => x.type === 'group' && x.title === '新分组');
  assert.strictEqual(newGroupRaw.items.length, 1);
  assert.strictEqual(newGroupRaw.items[0].path, '07_Resource/手册.pdf');
  assert.strictEqual('title' in newGroupRaw.items[0], false, '留空标题应沿用默认标题');

  // 重复添加到同一分组应拦截且弹窗保持打开
  addBmBtn.click();
  const addModal2 = mockDoc.body.querySelector('.ch-modal');
  const filterInp2 = addModal2.querySelector('.ch-input');
  filterInp2.value = '手册';
  filterInp2.dispatchEvent({ type: 'input', target: filterInp2 });
  addModal2.querySelectorAll('select.ch-select')[1].value = '0';
  addModal2.querySelector('.ch-btn.is-primary').click();
  assert.ok(mockDoc.body.querySelector('.ch-modal'), '同组重复添加时弹窗不应关闭');
  assert.ok(addModal2.querySelector('.ch-bm-modal-error')?.textContent.includes('已存在'), '应展示重复提示');
  addModal2.querySelector('.ch-icon-btn').click();

  // 外部变更实时同步 & 核心插件禁用/恢复降级
  bmInst.addItem({ type: 'url', title: '外部新增URL', url: 'https://example.org' });
  assert.ok(view.contentEl.querySelector('.ch-bm-list').textContent.includes('外部新增URL'), '外部触发 changed 应实时同步');

  app.internalPlugins.plugins.bookmarks.enabled = false;
  app.workspace.trigger('layout-change');
  assert.ok(view.contentEl.querySelector('.ch-bm-disabled'), '核心插件禁用后应显示引导提示');
  const disabledAddBtn = view.contentEl.querySelectorAll('.ch-card').find((c) => c.querySelector('.ch-card-title')?.textContent === '书签').querySelector('.ch-mini-pill-btn');
  assert.strictEqual(disabledAddBtn.disabled, true, '核心插件禁用后 + 添加按钮应禁用');

  app.internalPlugins.plugins.bookmarks.enabled = true;
  app.workspace.trigger('layout-change');
  assert.strictEqual(view.contentEl.querySelector('.ch-bm-disabled'), null, '重新启用后应自动恢复书签列表');

  // 7) 清理与卸载：确认所有 Component 实例均已 unload 且 bookmarks 监听已解绑
  assert.ok(app._getBookmarkListenerCount() > 0, '关闭前应绑定 bookmarks changed 监听');
  assert.ok(mockObsidian.Component.stats.loadedCount > 0, '应创建并加载过 Component 实例');
  assert.ok(mockObsidian.Component.stats.activeCount > 0, '关闭前应存在活跃 Component');
  await view.onClose();
  plugin.onunload();
  assert.strictEqual(view.isClosed, true);
  assert.strictEqual(app._getBookmarkListenerCount(), 0, '关闭视图后必须解绑 bookmarks changed 监听');
  assert.strictEqual(mockObsidian.Component.stats.activeCount, 0, '关闭视图后所有 MarkdownRenderer Component 必须全部 unload');
}

async function main() {
  testParsersAndUtils();
  console.log('✓ 1/3 解析与纯函数回归测试全部通过');
  await testIncrementalStore();
  console.log('✓ 2/3 增量缓存 VaultDataStore 测试全部通过');
  await testBundledPluginAndScrollPreservation();
  console.log('✓ 3/3 打包产物加载、零禁用依赖与滚动保持测试全部通过');
}

main().catch((err) => {
  console.error('✗ 测试失败:', err);
  process.exit(1);
});
