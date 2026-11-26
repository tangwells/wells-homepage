'use strict';

const { pad2, parseYMD, addDaysYMD, getIsoWeekInfo } = require('../utils/date');

const DEFAULT_WEEKLY_PRESET = {
  folder: '06_日志',
  format: 'gggg[W]ww',
  template: '02_模版/周志-xdb.md',
};

const WEEKDAY_OFFSETS = {
  monday: 0,
  tuesday: 1,
  wednesday: 2,
  thursday: 3,
  friday: 4,
  saturday: 5,
  sunday: 6,
};

const CN_WEEKDAYS_FULL = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const CN_WEEKDAYS_SHORT = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 规范化 Vault 相对路径（纯 JS 实现，不依赖 Node path 模块）。
 */
function normalizeVaultPath(raw) {
  return String(raw || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

/**
 * 获取已启用的 Periodic Notes 插件实例；未安装或未启用时返回 null。
 */
function getPeriodicNotesPlugin(app) {
  const plugins = app?.plugins;
  if (!plugins) return null;
  if (typeof plugins.getPlugin === 'function') {
    return plugins.getPlugin('periodic-notes') || null;
  }
  const enabled = plugins.enabledPlugins;
  if (enabled && typeof enabled.has === 'function' && enabled.size > 0 && !enabled.has('periodic-notes')) {
    return null;
  }
  return plugins.plugins?.['periodic-notes'] || null;
}

/**
 * 读取周志预设（Periodic Notes 优先，缺省或未启用时按字段回退至默认预设）。
 */
function getWeeklyNotePreset(app) {
  const plugin = getPeriodicNotesPlugin(app);
  const weekly = plugin?.settings?.weekly;
  if (weekly && weekly.enabled !== false) {
    const folderRaw = typeof weekly.folder === 'string' ? weekly.folder.trim() : '';
    const formatRaw = typeof weekly.format === 'string' ? weekly.format.trim() : '';
    const templateRaw = typeof weekly.template === 'string' ? weekly.template.trim() : '';
    return {
      folder: folderRaw ? normalizeVaultPath(folderRaw) : DEFAULT_WEEKLY_PRESET.folder,
      format: formatRaw || DEFAULT_WEEKLY_PRESET.format,
      template: templateRaw ? normalizeVaultPath(templateRaw) : DEFAULT_WEEKLY_PRESET.template,
      source: 'periodic-notes',
    };
  }
  return {
    ...DEFAULT_WEEKLY_PRESET,
    source: 'default',
  };
}

function formatFallbackMoment(dateObj, pattern) {
  const d = dateObj;
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const dow = d.getDay();
  const hour24 = d.getHours();
  const hour12 = hour24 % 12 || 12;
  const minute = d.getMinutes();
  const second = d.getSeconds();

  const tokenRe = /(\[[^\]]*\])|(YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|hh|h|mm|m|ss|s|A|a)/g;
  return String(pattern || '').replace(tokenRe, (_full, literal, token) => {
    if (literal !== undefined) return literal.slice(1, -1);
    switch (token) {
      case 'YYYY': return String(year);
      case 'YY': return String(year).slice(-2);
      case 'MMMM': return `${month}月`;
      case 'MMM': return `${month}月`;
      case 'MM': return pad2(month);
      case 'M': return String(month);
      case 'DD': return pad2(day);
      case 'D': return String(day);
      case 'dddd': return CN_WEEKDAYS_FULL[dow];
      case 'ddd': return CN_WEEKDAYS_SHORT[dow];
      case 'HH': return pad2(hour24);
      case 'H': return String(hour24);
      case 'hh': return pad2(hour12);
      case 'h': return String(hour12);
      case 'mm': return pad2(minute);
      case 'm': return String(minute);
      case 'ss': return pad2(second);
      case 's': return String(second);
      case 'A': return hour24 < 12 ? 'AM' : 'PM';
      case 'a': return hour24 < 12 ? 'am' : 'pm';
      default: return token;
    }
  });
}

/**
 * 以 ISO 周口径（周一为首、周四定年）改写格式串中的 gggg/GGGG/ww/WW 后再格式化。
 */
function formatIsoAlignedMomentToken(dateInput, formatStr) {
  const dt =
    dateInput instanceof Date
      ? new Date(dateInput.getTime())
      : parseYMD(dateInput) || new Date(dateInput);
  if (!dt || Number.isNaN(dt.getTime())) return '';

  const info = getIsoWeekInfo(dt);
  const rewritten = String(formatStr || '').replace(
    /(\[[^\]]*\])|(GGGG|gggg|GG|gg|WW|ww|W|w)/g,
    (full, literal, token) => {
      if (literal !== undefined) return literal;
      switch (token) {
        case 'GGGG':
        case 'gggg':
          return `[${info.isoWeekYear}]`;
        case 'GG':
        case 'gg':
          return `[${String(info.isoWeekYear).slice(-2)}]`;
        case 'WW':
        case 'ww':
          return `[${pad2(info.weekNumber)}]`;
        case 'W':
        case 'w':
          return `[${info.weekNumber}]`;
        default:
          return full;
      }
    }
  );

  if (typeof globalThis.moment === 'function') {
    return globalThis.moment(dt).format(rewritten);
  }
  return formatFallbackMoment(dt, rewritten);
}

/**
 * 根据周志预设与日期解析目标周志的元信息、标题与 Vault 路径。
 */
function resolveWeeklyNoteTarget(app, dateInput) {
  const info = getIsoWeekInfo(dateInput);
  const preset = getWeeklyNotePreset(app);
  if (!info.weekStart) {
    return { ...info, preset, title: '', filePath: '' };
  }
  const anchorThursday = parseYMD(addDaysYMD(info.weekStart, 3));
  const rawFormatted = formatIsoAlignedMomentToken(anchorThursday, preset.format || DEFAULT_WEEKLY_PRESET.format);
  const relNoExt = normalizeVaultPath(rawFormatted).replace(/\.md$/i, '') || info.isoWeekYearTitle;
  const title = relNoExt.split('/').pop() || info.isoWeekYearTitle;
  const folder = normalizeVaultPath(preset.folder);
  const filePath = `${folder ? `${folder}/` : ''}${relNoExt}.md`;
  return {
    ...info,
    preset,
    title,
    filePath,
  };
}

function isVaultFile(file) {
  return Boolean(file && !Array.isArray(file.children));
}

/**
 * 解析周志模板文件（支持带/不带 .md 后缀及 linkpath 回退）。
 */
function resolveTemplateFile(app, templatePath) {
  const norm = normalizeVaultPath(templatePath);
  if (!norm || !app?.vault) return null;
  const direct = app.vault.getAbstractFileByPath?.(norm);
  if (isVaultFile(direct)) return direct;
  if (!/\.md$/i.test(norm)) {
    const withExt = app.vault.getAbstractFileByPath?.(`${norm}.md`);
    if (isVaultFile(withExt)) return withExt;
  }
  const dest = app.metadataCache?.getFirstLinkpathDest?.(norm.replace(/\.md$/i, ''), '');
  return isVaultFile(dest) ? dest : null;
}

function applyDateDelta(baseDate, delta, unit) {
  const d = new Date(baseDate.getTime());
  const n = Number(delta);
  if (!Number.isFinite(n) || n === 0) return d;
  if (unit === 'M') {
    d.setMonth(d.getMonth() + n);
    return d;
  }
  switch (String(unit || '').toLowerCase()) {
    case 'y':
      d.setFullYear(d.getFullYear() + n);
      break;
    case 'q':
      d.setMonth(d.getMonth() + n * 3);
      break;
    case 'm':
      d.setMinutes(d.getMinutes() + n);
      break;
    case 'w':
      d.setDate(d.getDate() + n * 7);
      break;
    case 'd':
      d.setDate(d.getDate() + n);
      break;
    case 'h':
      d.setHours(d.getHours() + n);
      break;
    case 's':
      d.setSeconds(d.getSeconds() + n);
      break;
    default:
      break;
  }
  return d;
}

/**
 * 混合渲染周志模板：同时支持 {{weekStart}}/{{weekEnd}}/{{title}} 与 Periodic Notes 原生变量。
 */
function renderWeeklyTemplate(templateText, targetInfo, nowDate = new Date()) {
  const raw = String(templateText || '');
  const now = nowDate instanceof Date ? nowDate : new Date(nowDate);
  const mondayBase = parseYMD(targetInfo?.weekStart) || new Date(now.getFullYear(), now.getMonth(), now.getDate());
  mondayBase.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), 0);

  const defaultWeekFormat = targetInfo?.preset?.format || DEFAULT_WEEKLY_PRESET.format;
  const title = targetInfo?.title || targetInfo?.weekTitle || '';
  const weekStart = targetInfo?.weekStart || '';
  const weekEnd = targetInfo?.weekEnd || '';

  return raw
    .replace(/\{\{\s*weekStart\s*\}\}/g, weekStart)
    .replace(/\{\{\s*weekEnd\s*\}\}/g, weekEnd)
    .replace(/\{\{\s*title\s*\}\}/gi, title)
    .replace(/\{\{\s*time\s*\}\}/gi, `${pad2(now.getHours())}:${pad2(now.getMinutes())}`)
    .replace(
      /\{\{\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s*:(.*?)\}\}/gi,
      (_m, dayName, fmt) => {
        const offset = WEEKDAY_OFFSETS[String(dayName).toLowerCase()] ?? 0;
        const targetYmd = addDaysYMD(weekStart, offset);
        const targetDt = parseYMD(targetYmd) || mondayBase;
        return formatIsoAlignedMomentToken(targetDt, String(fmt || '').trim() || 'YYYY-MM-DD');
      }
    )
    .replace(
      /\{\{\s*(date|time)\s*(([+-]\d+)([yqmwdhs]))?\s*(:.+?)?\}\}/gi,
      (_m, kind, _calc, delta, unit, fmtWithColon) => {
        const isTime = String(kind).toLowerCase() === 'time';
        let base = isTime ? new Date(now.getTime()) : new Date(mondayBase.getTime());
        if (delta && unit) {
          base = applyDateDelta(base, delta, unit);
        }
        const customFmt = fmtWithColon ? fmtWithColon.slice(1).trim() : '';
        if (customFmt) {
          return formatIsoAlignedMomentToken(base, customFmt);
        }
        if (isTime) {
          return `${pad2(base.getHours())}:${pad2(base.getMinutes())}`;
        }
        if (!delta) {
          return title || formatIsoAlignedMomentToken(base, defaultWeekFormat);
        }
        return formatIsoAlignedMomentToken(base, defaultWeekFormat);
      }
    );
}

module.exports = {
  DEFAULT_WEEKLY_PRESET,
  normalizeVaultPath,
  getPeriodicNotesPlugin,
  getWeeklyNotePreset,
  formatIsoAlignedMomentToken,
  resolveWeeklyNoteTarget,
  resolveTemplateFile,
  renderWeeklyTemplate,
};
