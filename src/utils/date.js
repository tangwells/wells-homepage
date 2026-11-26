'use strict';

const { DAY_PERIODS } = require('../constants');

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatDateYMD(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseYMD(str) {
  if (!str || typeof str !== 'string') return null;
  const m = str.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mo - 1, d, 0, 0, 0, 0);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

function addDaysYMD(ymd, delta) {
  const dt = parseYMD(ymd);
  if (!dt) return ymd;
  dt.setDate(dt.getDate() + delta);
  return formatDateYMD(dt);
}

function diffDaysYMD(startYmd, endYmd) {
  const a = parseYMD(startYmd);
  const b = parseYMD(endYmd);
  if (!a || !b) return 0;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function getIsoWeekInfo(dateInput) {
  const d =
    typeof dateInput === 'string'
      ? parseYMD(dateInput)
      : dateInput instanceof Date
      ? new Date(dateInput.getFullYear(), dateInput.getMonth(), dateInput.getDate())
      : null;
  if (!d) {
    return {
      weekStart: '',
      weekEnd: '',
      weekTitle: '',
      isoWeekYearTitle: '',
      isoWeekYear: 0,
      weekNumber: 0,
      weekLabel: '',
    };
  }
  const day = d.getDay() || 7; // Monday=1 .. Sunday=7
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (day - 1));
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);

  // ISO week number & year (Thursday determines the ISO week-numbering year)
  const thursday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + (4 - day));
  const isoWeekYear = thursday.getFullYear();
  const yearStart = new Date(isoWeekYear, 0, 1);
  const weekNo = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  const weekLabel = `W${pad2(weekNo)}`;
  const isoWeekYearTitle = `${isoWeekYear}${weekLabel}`;
  return {
    weekStart: formatDateYMD(monday),
    weekEnd: formatDateYMD(sunday),
    weekTitle: isoWeekYearTitle,
    isoWeekYearTitle,
    isoWeekYear,
    weekNumber: weekNo,
    weekLabel,
  };
}

function getGreeting(hour) {
  if (hour < 6) return '夜深了';
  if (hour < 9) return '早上好';
  if (hour < 12) return '上午好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

function getPeriodIndexByHour(hour) {
  const idx = DAY_PERIODS.findIndex((p) => hour >= p.start && hour < p.end);
  return idx === -1 ? DAY_PERIODS.length - 1 : idx;
}

function getPeriodTitleByHour(hour) {
  return DAY_PERIODS[getPeriodIndexByHour(hour)].title;
}

function pickDefaultJournalPeriod(journalData, dateStr, todayStr, currentHour) {
  if (dateStr === todayStr) {
    return getPeriodTitleByHour(Number.isFinite(currentHour) ? currentHour : new Date().getHours());
  }
  const periods = journalData && journalData.periods ? journalData.periods : {};
  for (let i = DAY_PERIODS.length - 1; i >= 0; i--) {
    const title = DAY_PERIODS[i].title;
    if (Array.isArray(periods[title]) && periods[title].length > 0) {
      return title;
    }
  }
  return DAY_PERIODS[0].title;
}

function formatRelativeTime(mtimeMs, nowMs) {
  const diffSec = Math.max(0, Math.floor((nowMs - mtimeMs) / 1000));
  if (diffSec < 60) return '刚刚';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const dt = new Date(mtimeMs);
  return `${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

function extractLabelFromPath(filePath) {
  const basename = String(filePath || '').replace(/^.*[\\/]/, '').replace(/\.md$/, '');
  const weekMatch = basename.match(/^(\d{4})W(\d{2})$/);
  if (weekMatch) return `${weekMatch[1]} 第${parseInt(weekMatch[2], 10)}周`;
  const dayMatch = basename.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dayMatch) return `${parseInt(dayMatch[2], 10)}/${parseInt(dayMatch[3], 10)}`;
  return basename;
}

function renderTemplateText(templateText, kind, dateStr) {
  let out = String(templateText || '');
  if (kind === 'weekly') {
    const info = getIsoWeekInfo(dateStr);
    out = out
      .replace(/\{\{title\}\}/g, info.weekTitle)
      .replace(/\{\{weekStart\}\}/g, info.weekStart)
      .replace(/\{\{weekEnd\}\}/g, info.weekEnd);
  } else {
    out = out
      .replace(/<%(=)?\s*tp\.file\.title\s*%>/g, dateStr)
      .replace(/<%[\s\S]*?%>/g, '');
  }
  return out;
}

function normalizeTime(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  return m ? `${pad2(Number(m[1]))}:${m[2]}` : String(hhmm || '');
}

function normalizeTimeRangeLabel(raw) {
  const s = String(raw || '').trim();
  const rm = s.match(/^(\d{1,2})\s*:\s*(\d{2})\s*[-–]\s*(\d{1,2})\s*:\s*(\d{2})$/);
  if (rm) return `${pad2(Number(rm[1]))}:${rm[2]}–${pad2(Number(rm[3]))}:${rm[4]}`;
  const sm = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
  if (sm) return `${pad2(Number(sm[1]))}:${sm[2]}`;
  return s;
}

module.exports = {
  pad2,
  formatDateYMD,
  parseYMD,
  addDaysYMD,
  diffDaysYMD,
  getIsoWeekInfo,
  getGreeting,
  getPeriodIndexByHour,
  getPeriodTitleByHour,
  pickDefaultJournalPeriod,
  formatRelativeTime,
  extractLabelFromPath,
  renderTemplateText,
  normalizeTime,
  normalizeTimeRangeLabel,
};
