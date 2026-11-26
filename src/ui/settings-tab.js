'use strict';

const { PluginSettingTab, Setting } = require('obsidian');
const { DEFAULT_SETTINGS } = require('../constants');

class CarrotHomeSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Carrot Home 工作台设置' });

    new Setting(containerEl).setName('主页启动与空标签接管').setHeading();

    new Setting(containerEl)
      .setName('启动时打开工作台')
      .setDesc('Obsidian 启动完成且工作区尚未打开工作台时自动打开主页')
      .addToggle((toggle) =>
        toggle.setValue(Boolean(this.plugin.settings.openOnStartup)).onChange((value) => {
          this.plugin.updateSettings({ openOnStartup: value });
        })
      );

    new Setting(containerEl)
      .setName('关闭最后一个标签页时打开工作台')
      .setDesc('主编辑区仅剩空白标签页时自动展示工作台（已关闭 Components 原生 homepage 避免重复弹出）')
      .addToggle((toggle) =>
        toggle.setValue(Boolean(this.plugin.settings.openOnEmpty)).onChange((value) => {
          this.plugin.updateSettings({ openOnEmpty: value });
        })
      );

    new Setting(containerEl)
      .setName('新建空标签页时打开工作台')
      .setDesc('手动新建空白标签页（Cmd/Ctrl+T）时自动切换为工作台')
      .addToggle((toggle) =>
        toggle.setValue(Boolean(this.plugin.settings.openOnNewEmptyTab)).onChange((value) => {
          this.plugin.updateSettings({ openOnNewEmptyTab: value });
        })
      );

    new Setting(containerEl).setName('外观与默认视图').setHeading();

    new Setting(containerEl)
      .setName('主页大标题')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.title)
          .setValue(this.plugin.settings.title)
          .onChange((value) => {
            this.plugin.updateSettings({ title: value.trim() || DEFAULT_SETTINGS.title });
          })
      );

    new Setting(containerEl)
      .setName('背景模式')
      .addDropdown((dd) =>
        dd
          .addOption('default', '柔和氛围渐变')
          .addOption('image', '自定义图片')
          .addOption('color', '纯色')
          .setValue(this.plugin.settings.backgroundKind)
          .onChange((value) => {
            this.plugin.updateSettings({ backgroundKind: value });
          })
      );

    new Setting(containerEl)
      .setName('背景值（图片路径 / URL / 颜色）')
      .addText((text) =>
        text
          .setPlaceholder('01_附件/image/bg.png 或 #hex')
          .setValue(this.plugin.settings.backgroundValue)
          .onChange((value) => {
            this.plugin.updateSettings({ backgroundValue: value.trim() });
          })
      );

    new Setting(containerEl)
      .setName('默认任务视图')
      .addDropdown((dd) =>
        dd
          .addOption('kanban', '看板')
          .addOption('list', '清单')
          .setValue(this.plugin.settings.taskLayout)
          .onChange((value) => {
            this.plugin.updateSettings({ taskLayout: value });
          })
      );

    new Setting(containerEl)
      .setName('甘特图默认粒度')
      .addDropdown((dd) =>
        dd
          .addOption('day', '日')
          .addOption('week', '周')
          .addOption('month', '月')
          .setValue(this.plugin.settings.ganttZoom)
          .onChange((value) => {
            this.plugin.updateSettings({ ganttZoom: value });
          })
      );

    new Setting(containerEl)
      .setName('最近笔记显示条数')
      .addSlider((slider) =>
        slider
          .setLimits(3, 30, 1)
          .setValue(this.plugin.settings.recentCount)
          .setDynamicTooltip()
          .onChange((value) => {
            this.plugin.updateSettings({ recentCount: value });
          })
      );

    new Setting(containerEl).setName('模块显示开关').setHeading();

    const toggles = [
      ['显示大标题', 'showTitle'],
      ['显示顶部「随手晾晾」', 'showStickyNotes'],
      ['显示右上「螺旋日程」螺旋图', 'showFocusDial'],
      ['显示时钟卡片', 'showClock'],
      ['显示日历卡片', 'showCalendar'],
      ['显示书签卡片', 'showBookmarks'],
      ['显示最近笔记卡片', 'showRecent'],
      ['显示日注卡片', 'showJournal'],
      ['显示任务工作区卡片', 'showTasks'],
      ['显示项目甘特图', 'showGantt'],
    ];

    for (const [label, key] of toggles) {
      new Setting(containerEl).setName(label).addToggle((toggle) =>
        toggle.setValue(Boolean(this.plugin.settings[key])).onChange((value) => {
          this.plugin.updateSettings({ [key]: value });
        })
      );
    }
  }
}

module.exports = {
  CarrotHomeSettingTab,
};
