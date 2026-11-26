'use strict';

const VIEW_TYPE = 'carrot-home-view';
const PLUGIN_ID = 'carrot-home';

const DEFAULT_PINNED_ENTRIES = [
  { id: 'pin-today', label: '今日日注', kind: 'daily', icon: 'calendar-days' },
  { id: 'pin-week', label: '本周周志', kind: 'weekly', icon: 'calendar-range' },
  { id: 'pin-aps', label: 'APS 看板', kind: 'file', target: '01_附件/components/组件/APS.components', icon: 'layout-dashboard' },
  { id: 'pin-new-proj', label: '新建项目', kind: 'quickadd', target: '项目', icon: 'folder-plus' },
  { id: 'pin-new-study', label: '新建课题', kind: 'quickadd', target: '课题', icon: 'book-plus' },
];

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
  ganttStatusFilter: 'doing',
  stickyFolded: false,
  focusFolded: false,
  pinnedEntries: DEFAULT_PINNED_ENTRIES,
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
  DEFAULT_PINNED_ENTRIES,
  DEFAULT_SETTINGS,
  DAY_PERIODS,
  CN_WEEKDAYS,
};
