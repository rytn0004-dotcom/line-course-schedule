'use strict';

function isValidDateKey(value) {
  const m = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const y = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  const d = new Date(Date.UTC(y, month - 1, day));
  return d.getUTCFullYear() === y && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function parseMonthDay(monthValue, dayValue, year = new Date().getFullYear()) {
  const month = Number(monthValue), day = Number(dayValue), yr = Number(year);
  if (!Number.isInteger(yr) || !Number.isInteger(month) || !Number.isInteger(day) ||
      month < 1 || month > 12 || day < 1 || day > 31) return '';
  const key = String(yr).padStart(4, '0') + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
  return isValidDateKey(key) ? key : '';
}

function timeKey(value) {
  const source = String(value ?? '').trim().replace(/\s+/g, '');
  const m = source.match(/^(\d{1,2}):([0-5]\d)$/) || source.match(/^(\d{3,4})$/);
  if (!m) return '';
  let hour, minute;
  if (m[2] !== undefined) {
    hour = Number(m[1]);
    minute = Number(m[2]);
  } else {
    const four = m[1].padStart(4, '0');
    hour = Number(four.slice(0, 2));
    minute = Number(four.slice(2));
  }
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return '';
  return String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
}

function addMinutesToTime(value, minutes) {
  const key = timeKey(value);
  const amount = Number(minutes);
  if (!key || !Number.isFinite(amount)) return '';
  const parts = key.split(':').map(Number);
  const total = parts[0] * 60 + parts[1] + amount;
  if (total < 0 || total >= 24 * 60) return '';
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
}

// Example: "10/9改1030~1230" -> the class remains on the same date but changes time.
function parseSameDayTimeChangeNote(value, year = new Date().getFullYear()) {
  const source = String(value ?? '').trim();
  const m = source.match(/^\s*(\d{1,2})\/(\d{1,2})\s*改\s*(\d{1,2}:?\d{2})\s*[-~～至]\s*(\d{1,2}:?\d{2})\s*$/);
  if (!m) return null;
  const date = parseMonthDay(m[1], m[2], year);
  const start = timeKey(m[3]), end = timeKey(m[4]);
  if (!date || !start || !end) return null;
  return { date, start, end };
}

// Only match explicit one-date wording. Ordinary p/調課 annotations must not be treated as single-date classes.
function parseSingleDateOnlyNote(annotations, year = new Date().getFullYear()) {
  const sources = Array.isArray(annotations) ? annotations : [annotations];
  const patterns = [
    /(?:^|[^0-9])僅\s*(\d{1,2})\/(\d{1,2})(?=$|[^0-9])/,
    /(?:^|[^0-9])(\d{1,2})\/(\d{1,2})\s*而已(?=$|[^0-9])/,
    /(?:^|[^0-9])(\d{1,2})\/(\d{1,2})\s*僅一次(?=$|[^0-9])/
  ];
  for (const note of sources) {
    const source = String(note ?? '').trim();
    for (const pattern of patterns) {
      const m = source.match(pattern);
      if (!m) continue;
      const date = parseMonthDay(m[1], m[2], year);
      if (date) return date;
    }
  }
  return '';
}

// For a variant row such as "9/28p調9/21、10/5、10/12各+30min",
// return only explicit target dates, not dates in the later exception clause.
function parseDurationTargetDates(value, year = new Date().getFullYear()) {
  const source = String(value ?? '').trim();
  if (!source) return { sourceDate: '', targetDates: [] };
  const origin = source.match(/(\d{1,2})\/(\d{1,2})\s*p\s*調/i);
  const repeated = source.match(/調\s*(.*?)\s*各\s*[+＋]?\s*\d+\s*min(?:ute)?s?/i);
  const dateText = repeated ? repeated[1] : source.split(/(?:，|,)\s*除了/)[0];
  const targetDates = [];
  const seen = new Set();
  const re = /(\d{1,2})\/(\d{1,2})/g;
  let m;
  while ((m = re.exec(dateText))) {
    const date = parseMonthDay(m[1], m[2], year);
    if (date && !seen.has(date)) {
      seen.add(date);
      targetDates.push(date);
    }
  }
  const sourceDate = origin ? parseMonthDay(origin[1], origin[2], year) : '';
  return { sourceDate, targetDates };
}

// A teacher cell can include "11月後的課程還要再做確認" below the name.
function parseTeacherConfirmUntil(value, year = new Date().getFullYear()) {
  const source = String(value ?? '').trim();
  if (!/確認|待確認|再做確認/.test(source)) return '';
  const m = source.match(/(\d{1,2})\s*月後/);
  if (!m) return '';
  const month = Number(m[1]);
  if (!Number.isInteger(month) || month < 1 || month > 12) return '';
  const lastDay = new Date(Date.UTC(Number(year), month, 0)).getUTCDate();
  return String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0') + '-' + String(lastDay).padStart(2, '0');
}

function normalizeStudentNameForContact(value) {
  return String(value ?? '').trim()
    .replace(/(?:國文|數學|理化|物理|化學|英文|生物|自然|社會)$/, '')
    .replace(/\s+/g, '');
}

// Parent matching uses actual student names, not group/course labels.
function extractReminderStudentNames(value) {
  const source = String(value ?? '').trim();
  if (!source) return [];
  const names = [];
  const seen = new Set();
  const add = raw => {
    const name = normalizeStudentNameForContact(raw);
    if (!name || /團班/.test(name)) return;
    const key = name.replace(/[()（）[\]【】]/g, '');
    if (!key || seen.has(key)) return;
    seen.add(key);
    names.push(name);
  };

  const groupPattern = /([^、,，\/()（）]*團班)\s*[（(]([^（）()]*)[）)]/g;
  let match;
  const consumed = [];
  while ((match = groupPattern.exec(source))) {
    consumed.push(match[0]);
    const roster = match[2].trim();
    if (!/\d{1,2}\/\d{1,2}|調課|請假|加時|加課|補課|改課|代課/i.test(roster)) {
      for (const name of roster.split(/[、,，\/]/)) add(name);
    }
  }

  let remainder = source;
  for (const block of consumed) remainder = remainder.replace(block, '');
  for (const name of remainder.split(/[、,，\/]+/)) add(name);
  return names;
}

module.exports = {
  addMinutesToTime,
  extractReminderStudentNames,
  isValidDateKey,
  parseDurationTargetDates,
  parseMonthDay,
  parseSameDayTimeChangeNote,
  parseSingleDateOnlyNote,
  parseTeacherConfirmUntil,
  timeKey
};
