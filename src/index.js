'use strict';

const { Plugin } = require('obsidian');
const { VIEW_TYPE, DEFAULT_SETTINGS } = require('./constants');
const { normalizeSettings } = require('./utils/settings');
const { CarrotHomeView } = require('./view/carrot-home-view');
const { CarrotHomeSettingTab } = require('./ui/settings-tab');

class CarrotHomePlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.saveTimer = null;
    this.emptyCheckTimer = null;
    this.isOpeningHome = false;
    this.openingPromise = null;
    this.unloading = false;

    this.registerView(VIEW_TYPE, (leaf) => new CarrotHomeView(leaf, this));

    this.addRibbonIcon('home', '打开 Carrot Home 工作台', () => {
      void this.activateView();
    });

    this.addCommand({
      id: 'open',
      name: '打开工作台主页',
      callback: () => {
        void this.activateView();
      },
    });

    this.addCommand({
      id: 'open-settings',
      name: '打开工作台设置',
      callback: () => {
        const activeLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
        if (activeLeaf && activeLeaf.view instanceof CarrotHomeView) {
          activeLeaf.view.openSettings();
        } else {
          this.app.setting?.open?.();
          this.app.setting?.openTabById?.(this.manifest.id);
        }
      },
    });

    this.addSettingTab(new CarrotHomeSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      if (this.unloading) return;
      if (this.settings.openOnStartup) {
        void this.openStartupHomepage();
      }
      this.registerHomepageLifecycleEvents();
    });
  }

  async loadSettings() {
    const raw = await this.loadData();
    this.settings = normalizeSettings(DEFAULT_SETTINGS, raw || {});
  }

  scheduleSaveSettings() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveData(this.settings);
    }, 200);
  }

  updateSettings(patch, opts = {}) {
    if (!patch || typeof patch !== 'object') return;
    const changedKeys = Object.keys(patch);
    this.settings = normalizeSettings(this.settings, patch);
    this.scheduleSaveSettings();

    const leaves = this.app.workspace.getLeavesOfType ? this.app.workspace.getLeavesOfType(VIEW_TYPE) : [];
    for (const leaf of leaves) {
      if (leaf?.view && typeof leaf.view.applySettingsChange === 'function') {
        leaf.view.applySettingsChange(changedKeys, opts);
      }
    }
  }

  isRootEmptyLeaf(leaf) {
    if (!leaf) return false;
    const root = this.app.workspace.rootSplit;
    if (root && typeof leaf.getRoot === 'function' && leaf.getRoot() !== root) {
      return false;
    }
    const viewType = leaf.view && typeof leaf.view.getViewType === 'function' ? leaf.view.getViewType() : '';
    return viewType === 'empty';
  }

  getRootLeaves() {
    const root = this.app.workspace.rootSplit;
    const leaves = [];
    if (typeof this.app.workspace.iterateRootLeaves === 'function') {
      this.app.workspace.iterateRootLeaves((leaf) => leaves.push(leaf));
    } else if (typeof this.app.workspace.iterateAllLeaves === 'function') {
      this.app.workspace.iterateAllLeaves((leaf) => {
        if (!root || (typeof leaf.getRoot === 'function' && leaf.getRoot() === root)) {
          leaves.push(leaf);
        }
      });
    }
    return leaves;
  }

  async activateView(targetLeaf) {
    if (this.unloading) return null;
    if (this.openingPromise) return this.openingPromise;
    this.isOpeningHome = true;
    this.openingPromise = (async () => {
      try {
        const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
        if (existing && existing.length > 0) {
          this.app.workspace.revealLeaf?.(existing[0]);
          return existing[0];
        }

        const leaf = targetLeaf || this.app.workspace.getLeaf('tab');
        if (!leaf) return null;
        await leaf.setViewState({ type: VIEW_TYPE, active: true });
        this.app.workspace.revealLeaf?.(leaf);
        return leaf;
      } finally {
        this.isOpeningHome = false;
        this.openingPromise = null;
      }
    })();
    return this.openingPromise;
  }

  async openStartupHomepage() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (existing && existing.length > 0) return;

    const rootLeaves = this.getRootLeaves();
    const emptyLeaf = rootLeaves.find((l) => this.isRootEmptyLeaf(l));
    await this.activateView(emptyLeaf || undefined);
  }

  registerHomepageLifecycleEvents() {
    this.registerEvent(
      this.app.workspace.on('layout-change', () => {
        if (this.unloading || !this.settings.openOnEmpty) return;
        if (this.emptyCheckTimer) clearTimeout(this.emptyCheckTimer);
        this.emptyCheckTimer = setTimeout(() => {
          this.emptyCheckTimer = null;
          if (this.unloading || this.isOpeningHome) return;
          const rootLeaves = this.getRootLeaves();
          if (rootLeaves.length === 1 && this.isRootEmptyLeaf(rootLeaves[0])) {
            void this.activateView(rootLeaves[0]);
          }
        }, 120);
      })
    );

    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        if (this.unloading || this.isOpeningHome || !this.settings.openOnNewEmptyTab) return;
        if (this.isRootEmptyLeaf(leaf)) {
          void this.activateView(leaf);
        }
      })
    );
  }

  onunload() {
    this.unloading = true;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      void this.saveData(this.settings);
    }
    if (this.emptyCheckTimer) {
      clearTimeout(this.emptyCheckTimer);
      this.emptyCheckTimer = null;
    }
  }
}

module.exports = CarrotHomePlugin;
