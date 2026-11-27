'use strict';

const VIEW_TYPE = 'carrot-home-view';
const PLUGIN_ID = 'carrot-home';

const DEFAULT_SETTINGS = {
  title: '我的工作台',
  showTitle: true,
  showStickyNotes: true,
  showFocusDial: true,
  showClock: true,
  showCalendar: true,
  showBookmarks: true,
  showRecent: true,
  showJournal: true,
  showTasks: true,
  showGantt: true,
  backgroundKind: 'default',
  backgroundValue: '',
  backgroundOpacity: 0.32,
  backgroundBlur: 2,
  cardOpacity: 0.78,
  cardBlur: 0,
  cardRadius: 14,
  recentCount: 10,
  taskDensity: 'medium',
  taskLayout: 'kanban',
  showCompletedTasks: true,
  ganttZoom: 'month',
  stickyFolded: false,
  focusFolded: false,
  // 主页生命周期接管（替代 Components homepage 设置）
  openOnStartup: true,
  openOnEmpty: true,
  openOnNewEmptyTab: false,
};

const DAY_PERIODS = [
  { title: '清晨', start: 0, end: 9 },
  { title: '上午', start: 9, end: 12 },
  { title: '下午', start: 12, end: 18 },
  { title: '晚上', start: 18, end: 24 },
];

const CN_WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

module.exports = {
  VIEW_TYPE,
  PLUGIN_ID,
  DEFAULT_SETTINGS,
  DAY_PERIODS,
  CN_WEEKDAYS,
};
