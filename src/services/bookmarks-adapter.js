'use strict';

const BOOKMARK_ICONS = {
  group: { icon: 'folder', fallback: '📁' },
  file: { icon: 'file-text', fallback: '📄' },
  folder: { icon: 'folder', fallback: '📁' },
  search: { icon: 'search', fallback: '🔍' },
  graph: { icon: 'git-fork', fallback: '🕸' },
  url: { icon: 'globe', fallback: '🌐' },
};

function getBookmarkIcon(type) {
  return BOOKMARK_ICONS[type] || { icon: 'bookmark', fallback: '🔖' };
}

function getBookmarksPlugin(app) {
  const ip = app && app.internalPlugins;
  if (!ip) return null;
  if (typeof ip.getEnabledPluginById === 'function') {
    const enabledInst = ip.getEnabledPluginById('bookmarks');
    if (enabledInst) return enabledInst;
  }
  const entry = ip.plugins && ip.plugins.bookmarks;
  if (!entry) return null;
  if ('enabled' in entry && !entry.enabled) return null;
  return entry.instance || null;
}

function isExcludedVaultPath(p) {
  if (!p || typeof p !== 'string') return true;
  return (
    p === '.trash' ||
    p.startsWith('.trash/') ||
    p === '.obsidian' ||
    p.startsWith('.obsidian/')
  );
}

function resolveBookmarkTitle(plugin, item) {
  if (!item || typeof item !== 'object') return '未命名书签';
  if (typeof item.title === 'string' && item.title.trim()) {
    return item.title;
  }
  if (plugin && typeof plugin.getItemTitle === 'function') {
    try {
      const resolved = plugin.getItemTitle(item);
      if (typeof resolved === 'string' && resolved.trim()) {
        return resolved;
      }
    } catch (_e) {}
  }
  const type = item.type || (item.path ? 'file' : '');
  if (type === 'group') return '未命名分组';
  if (type === 'file') {
    const base = String(item.path || '').replace(/^.*\//, '').replace(/\.md$/i, '');
    return (base || item.path || '未命名文件') + (item.subpath || '');
  }
  if (type === 'folder') {
    const cleaned = String(item.path || '').replace(/\/+$/, '');
    return cleaned.replace(/^.*\//, '') || cleaned || '未命名文件夹';
  }
  if (type === 'search') return item.query || '搜索';
  if (type === 'graph') return '关系图谱';
  if (type === 'url') return item.url || '网页链接';
  return item.path || item.query || item.url || '未命名书签';
}

function isBookmarkBroken(app, item) {
  if (!item || typeof item !== 'object') return false;
  if (item.type !== 'file' && item.type !== 'folder') return false;
  if (!item.path) return true;
  const target = app && app.vault && typeof app.vault.getAbstractFileByPath === 'function'
    ? app.vault.getAbstractFileByPath(item.path)
    : null;
  return !target;
}

function buildBookmarkTree(app, plugin) {
  if (!plugin) {
    return { enabled: false, items: [], groups: [] };
  }
  const rawItems = Array.isArray(plugin.items) ? plugin.items : [];
  const groups = [];

  function walk(items, parentRaw, parentKey, depth, parentLabels) {
    const out = [];
    const occMap = new Map();
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const type = item.type || (item.path ? 'file' : item.query ? 'search' : item.url ? 'url' : 'file');
      const title = resolveBookmarkTitle(plugin, item);
      const sig = `${type}:${title}`;
      const occ = occMap.get(sig) || 0;
      occMap.set(sig, occ + 1);
      const key = `${parentKey}/${sig}#${occ}`;

      if (type === 'group') {
        const subItems = Array.isArray(item.items) ? item.items : [];
        const groupLabels = parentLabels.concat([title]);
        groups.push({
          raw: item,
          label: groupLabels.join(' / '),
          depth,
        });
        const children = walk(subItems, item, key, depth + 1, groupLabels);
        let leafCount = 0;
        let groupCount = 0;
        for (const ch of children) {
          if (ch.type === 'group') {
            groupCount += 1 + ch.groupCount;
            leafCount += ch.leafCount;
          } else {
            leafCount += 1;
          }
        }
        out.push({
          key,
          type: 'group',
          title,
          raw: item,
          parentRaw,
          path: '',
          subpath: '',
          query: '',
          url: '',
          broken: false,
          depth,
          children,
          leafCount,
          groupCount,
          directCount: children.length,
        });
      } else {
        out.push({
          key,
          type,
          title,
          raw: item,
          parentRaw,
          path: item.path || '',
          subpath: item.subpath || '',
          query: item.query || '',
          url: item.url || '',
          broken: isBookmarkBroken(app, item),
          depth,
          children: [],
          leafCount: 0,
          groupCount: 0,
          directCount: 0,
        });
      }
    }
    return out;
  }

  const items = walk(rawItems, null, 'root', 0, []);
  return { enabled: true, items, groups };
}

function hasDuplicateInGroup(plugin, targetGroupRaw, type, targetPath) {
  if (!plugin) return false;
  const list = targetGroupRaw
    ? (Array.isArray(targetGroupRaw.items) ? targetGroupRaw.items : [])
    : (Array.isArray(plugin.items) ? plugin.items : []);
  return list.some(
    (x) => x && x.type === type && x.path === targetPath && !x.subpath
  );
}

function addVaultBookmark(app, obsidian, { type, path, title = '', parentGroupRaw = null } = {}) {
  const plugin = getBookmarksPlugin(app);
  if (!plugin || typeof plugin.addItem !== 'function') {
    const message = '请先启用 Obsidian 核心插件「书签」';
    if (obsidian && obsidian.Notice) new obsidian.Notice(message);
    return { ok: false, reason: 'disabled', message };
  }
  if ((type !== 'file' && type !== 'folder') || !path) {
    const message = '请选择有效的文件或文件夹';
    if (obsidian && obsidian.Notice) new obsidian.Notice(message);
    return { ok: false, reason: 'invalid', message };
  }
  if (hasDuplicateInGroup(plugin, parentGroupRaw || null, type, path)) {
    const message = '目标分组中已存在该书签';
    if (obsidian && obsidian.Notice) new obsidian.Notice(message);
    return { ok: false, reason: 'duplicate', message };
  }
  const item = {
    type,
    ctime: Date.now(),
    path,
  };
  const customTitle = typeof title === 'string' ? title.trim() : '';
  if (customTitle) {
    item.title = customTitle;
  }
  plugin.addItem(item, parentGroupRaw || null);
  const shown = customTitle || resolveBookmarkTitle(plugin, item);
  if (obsidian && obsidian.Notice) {
    new obsidian.Notice(`已添加到书签：${shown}`);
  }
  return { ok: true, item };
}

function removeVaultBookmark(app, obsidian, rawItem, displayTitle = '') {
  const plugin = getBookmarksPlugin(app);
  if (!plugin || typeof plugin.removeItem !== 'function' || !rawItem) {
    if (obsidian && obsidian.Notice && !plugin) {
      new obsidian.Notice('请先启用 Obsidian 核心插件「书签」');
    }
    return false;
  }
  const title = displayTitle || resolveBookmarkTitle(plugin, rawItem);
  plugin.removeItem(rawItem);
  if (obsidian && obsidian.Notice) {
    new obsidian.Notice(`已移除书签：${title}`);
  }
  return true;
}

async function openVaultBookmark(app, obsidian, node, newLeaf = false) {
  if (!node || !node.raw) return false;
  const plugin = getBookmarksPlugin(app);
  if (node.broken) {
    if (obsidian && obsidian.Notice) {
      new obsidian.Notice(`目标文件或文件夹不存在：${node.path}`);
    }
    return false;
  }
  if (plugin && typeof plugin.openBookmark === 'function') {
    await plugin.openBookmark(node.raw, newLeaf ? 'tab' : false);
    return true;
  }
  if (node.type === 'file' && node.path) {
    const target = node.subpath ? `${node.path}${node.subpath}` : node.path;
    app && app.workspace && app.workspace.openLinkText && app.workspace.openLinkText(target, '', Boolean(newLeaf));
    return true;
  }
  if (node.type === 'folder' && node.path) {
    const f = app && app.vault && app.vault.getAbstractFileByPath && app.vault.getAbstractFileByPath(node.path);
    const explorer = app && app.internalPlugins && app.internalPlugins.getEnabledPluginById
      ? app.internalPlugins.getEnabledPluginById('file-explorer')
      : app && app.internalPlugins && app.internalPlugins.plugins && app.internalPlugins.plugins['file-explorer'] && app.internalPlugins.plugins['file-explorer'].instance;
    if (f && explorer && typeof explorer.revealInFolder === 'function') {
      explorer.revealInFolder(f);
      return true;
    }
  }
  if (node.type === 'search' && node.query) {
    const gs = app && app.internalPlugins && app.internalPlugins.plugins && app.internalPlugins.plugins['global-search'] && app.internalPlugins.plugins['global-search'].instance;
    if (gs && typeof gs.openGlobalSearch === 'function') {
      gs.openGlobalSearch(node.query);
      return true;
    }
  }
  if (node.type === 'url' && node.url && typeof window !== 'undefined' && typeof window.open === 'function') {
    window.open(node.url, '_blank');
    return true;
  }
  return false;
}

function listVaultBookmarkTargets(app) {
  const vault = app && app.vault;
  if (!vault) return [];

  const seen = new Set();
  const targets = [];

  function pushTarget(type, p, name) {
    if (!p || p === '/' || isExcludedVaultPath(p)) return;
    const id = `${type}:${p}`;
    if (seen.has(id)) return;
    seen.add(id);
    targets.push({
      type,
      path: p,
      name: name || p.replace(/^.*\//, ''),
    });
  }

  const allLoaded = typeof vault.getAllLoadedFiles === 'function' ? vault.getAllLoadedFiles() : null;
  if (Array.isArray(allLoaded) && allLoaded.length > 0) {
    for (const item of allLoaded) {
      if (!item || !item.path || item.path === '/') continue;
      if (Array.isArray(item.children)) {
        pushTarget('folder', item.path, item.name);
      } else {
        pushTarget('file', item.path, item.name || item.basename);
      }
    }
  }

  const files = typeof vault.getFiles === 'function' ? vault.getFiles() : [];
  for (const f of files) {
    if (!f || !f.path) continue;
    pushTarget('file', f.path, f.name || f.basename);
    if (!allLoaded) {
      const parts = f.path.split('/');
      parts.pop();
      let cur = '';
      for (const seg of parts) {
        if (!seg) continue;
        cur = cur ? `${cur}/${seg}` : seg;
        pushTarget('folder', cur, seg);
      }
    }
  }

  targets.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  return targets;
}

module.exports = {
  getBookmarkIcon,
  getBookmarksPlugin,
  resolveBookmarkTitle,
  isBookmarkBroken,
  buildBookmarkTree,
  hasDuplicateInGroup,
  addVaultBookmark,
  removeVaultBookmark,
  openVaultBookmark,
  listVaultBookmarkTargets,
};
