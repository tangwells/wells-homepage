'use strict';

const { DEFAULT_SETTINGS } = require('../constants');

function clampNumber(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeSettings(rawOptions, localOverrides) {
  const base = rawOptions && typeof rawOptions === 'object' ? rawOptions : {};
  const local = localOverrides && typeof localOverrides === 'object' ? localOverrides : {};
  const merged = { ...DEFAULT_SETTINGS, ...base, ...local };

  return {
    title: typeof merged.title === 'string' && merged.title.trim() ? merged.title.trim() : DEFAULT_SETTINGS.title,
    showTitle: merged.showTitle !== false,
    showStickyNotes: merged.showStickyNotes !== false,
    showFocusDial: merged.showFocusDial !== false,
    showClock: merged.showClock !== false,
    showCalendar: merged.showCalendar !== false,
    showBookmarks: merged.showBookmarks !== false,
    showRecent: merged.showRecent !== false,
    showJournal: merged.showJournal !== false,
    showTasks: merged.showTasks !== false,
    showGantt: merged.showGantt !== false,
    backgroundKind: ['default', 'image', 'color'].includes(merged.backgroundKind) ? merged.backgroundKind : 'default',
    backgroundValue: typeof merged.backgroundValue === 'string' ? merged.backgroundValue : '',
    backgroundOpacity: clampNumber(merged.backgroundOpacity, 0, 1, DEFAULT_SETTINGS.backgroundOpacity),
    backgroundBlur: clampNumber(merged.backgroundBlur, 0, 32, DEFAULT_SETTINGS.backgroundBlur),
    cardOpacity: clampNumber(merged.cardOpacity, 0.25, 1, DEFAULT_SETTINGS.cardOpacity),
    cardBlur: clampNumber(merged.cardBlur, 0, 28, DEFAULT_SETTINGS.cardBlur),
    cardRadius: clampNumber(merged.cardRadius, 4, 28, DEFAULT_SETTINGS.cardRadius),
    recentCount: Math.round(clampNumber(merged.recentCount, 3, 30, DEFAULT_SETTINGS.recentCount)),
    taskDensity: ['large', 'medium', 'small'].includes(merged.taskDensity) ? merged.taskDensity : 'medium',
    taskLayout: ['kanban', 'list'].includes(merged.taskLayout) ? merged.taskLayout : 'kanban',
    showCompletedTasks: merged.showCompletedTasks !== false,
    ganttZoom: ['day', 'week', 'month'].includes(merged.ganttZoom) ? merged.ganttZoom : 'month',
    stickyFolded: Boolean(merged.stickyFolded),
    focusFolded: Boolean(merged.focusFolded),
    openOnStartup: merged.openOnStartup !== false,
    openOnEmpty: merged.openOnEmpty !== false,
    openOnNewEmptyTab: Boolean(merged.openOnNewEmptyTab),
  };
}

module.exports = {
  clampNumber,
  normalizeSettings,
};
