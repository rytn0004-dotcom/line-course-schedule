'use strict';

function splitWrappedCourseLines(value) {
  const source = String(value ?? '');
  const rawLines = [...source.matchAll(/[^\r\n]+/g)];
  const lines = [];
  const isCourseStart = line => /^\s*\d{1,2}:?\d{2}\s*[-~～至]\s*\d{1,2}:?\d{2}/.test(line);
  const unclosedParentheses = line => {
    let depth = 0;
    for (const ch of line) {
      if (ch === '(' || ch === '（') depth++;
      if (ch === ')' || ch === '）') depth--;
    }
    return depth > 0;
  };
  for (const raw of rawLines) {
    const text = raw[0].trim();
    if (!text) continue;
    const start = raw.index + raw[0].length - raw[0].trimStart().length;
    const previous = lines[lines.length - 1];
    const isStandaloneAnnotation =
      /^[（(][^（）()]*[）)]?\s*$/.test(text) &&
      /\d{1,2}\/\d{1,2}|調|請假|加時|加課|補課|改|代|僅|\bp\b|\bb\b/i.test(text);
    if (previous && !isCourseStart(text) &&
        (unclosedParentheses(previous.text) || isStandaloneAnnotation)) {
      // Some exports put a second parenthetical note on its own line even when
      // the course line above already closed its first pair of parentheses.
      previous.text += ' ' + text;
    } else {
      lines.push({ text, start });
    }
  }
  return lines;
}

function sourceTeacherCourseOverride(value){
  const source=String(value??'');
  const aliases=[
    {patterns:[/詔鈞代/,/代詔鈞/,/詔鈞(?=(?:國文|數學|理化|物理|化學|英文|生物|自然|社會))/],teacher:'楊詔鈞'},
    {patterns:[/佳盈代/,/代佳盈/,/佳盈(?=(?:國文|數學|理化|物理|化學|英文|生物|自然|社會))/],teacher:'吳佳盈'},
    {patterns:[/維軒代/,/代維軒/,/維軒(?=(?:國文|數學|理化|物理|化學|英文|生物|自然|社會))/],teacher:'林維軒'},
    {patterns:[/政銓代/,/代政銓/,/政銓(?=(?:國文|數學|理化|物理|化學|英文|生物|自然|社會))/],teacher:'黃政銓'}
  ];
  const found=aliases.find(x=>x.patterns.some(re=>re.test(source)));
  const courseMatch=source.match(/(?:詔鈞|佳盈|維軒|政銓)\s*(國文|數學|理化|物理|化學|英文|生物|自然|社會)/);
  return {teacher:found?.teacher||'',course:courseMatch?String(courseMatch[1]).trim():''};
}

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

// Capture explicit effective-start notes from the source timetable, e.g.
// "10/6開始，週三改週二". This prevents the newly moved weekly slot from
// appearing in historical build windows before its stated start date.
function parseCourseStartDateNote(value, year = new Date().getFullYear()) {
  const source = String(value ?? '').replace(/\s+/g, '');
  const match = source.match(/(?:^|[^0-9])(\d{1,2})\/(\d{1,2})開始/);
  if (!match) return '';
  return parseMonthDay(match[1], match[2], year);
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

function normalizeTimeRange(value) {
  const source = String(value ?? '').trim().replace(/\s+/g, '');
  const m = source.match(/^(\d{1,2}:?\d{2})[-~～至](\d{1,2}:?\d{2})$/);
  if (!m) return timeKey(value);
  const start = timeKey(m[1]), end = timeKey(m[2]);
  if (!start) return '';
  return end ? start + '-' + end : start;
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

// A plain "10/17師p" means the teacher is absent that date. Notes containing
// "師p調..." are handled by the move parser first and must not become an extra cancellation.
function parseTeacherAbsenceNote(value, year = new Date().getFullYear()) {
  // Normalize wrapped teacher notes such as "(9/26老\n師p)" before matching.
  const source = String(value ?? '').replace(/\s+/g, '');
  const m = source.match(/(?:^|[^0-9])(\d{1,2})\/(\d{1,2})(?:老師|師)\s*p(?!\s*調)(?=$|[^a-z0-9])/i);
  if (!m) return '';
  return parseMonthDay(m[1], m[2], year);
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

// A date-scoped destination row with the same student and start time replaces,
// rather than duplicates, that student's weekly slot on the target date.
function hasDateScopedTargetOverride(adjustments, date, student, time) {
  const targetDate = String(date ?? '').trim();
  const targetStudent = normalizeStudentNameForContact(student);
  const targetRange = normalizeTimeRange(time);
  const targetStart = targetRange ? targetRange.split('-')[0] : '';
  if (!targetDate || !targetStudent || !targetStart) return false;

  return (Array.isArray(adjustments) ? adjustments : []).some(item => {
    if (String(item?.newDate ?? '').trim() !== targetDate) return false;
    const sourceDate = String(item?.originalDate ?? '').trim();
    if (!sourceDate || sourceDate === targetDate) return false;
    if (!/調課|移課|改課|代課/.test(String(item?.action ?? ''))) return false;
    if (normalizeStudentNameForContact(item?.student) !== targetStudent) return false;
    if (!/\[單次課程\]|\[單次／紫色調課\]|\[紫色調課\]/.test(String(item?.note ?? ''))) return false;

    const range = normalizeTimeRange(item?.newTime);
    const start = range ? range.split('-')[0] : '';
    return start === targetStart;
  });
}

// Resolve an explicit destination-cell lesson against its matching source move,\n// even when the destination start time differs from the original weekly slot.\n// Only merge unambiguous one-source/one-destination pairs for the same target date,\n// student, teacher and site; ambiguous groups are left untouched.\nfunction mergeExplicitMoveDestinationOverrides(adjustments) {\n  const source = Array.isArray(adjustments) ? adjustments : [];\n  const isDestination = item => /\\[單次課程\\]/.test(String(item?.note ?? '')) &&\n    Boolean(String(item?.newDate ?? '').trim()) && Boolean(String(item?.student ?? '').trim());\n  const isOriginMove = item => {\n    const from = String(item?.originalDate ?? '').trim();\n    const to = String(item?.newDate ?? '').trim();\n    return Boolean(from && to && from !== to) &&\n      /調課|移課|改課|代課/.test(String(item?.action ?? '')) &&\n      !/\\[單次課程\\]\\s*目的日課程/.test(String(item?.note ?? ''));\n  };\n  const groupKey = item => [\n    String(item?.newDate ?? '').trim(),\n    normalizeStudentNameForContact(item?.student),\n    String(item?.teacher ?? '').trim().replace(/\\s+/g, ''),\n    String(item?.site ?? '').trim().replace(/\\s+/g, '')\n  ].join('|');\n  const groups = new Map();\n  source.forEach((item, index) => {\n    if (!item?.newDate || !item?.student) return;\n    const key = groupKey(item);\n    if (!groups.has(key)) groups.set(key, { origins: [], destinations: [] });\n    const group = groups.get(key);\n    if (isOriginMove(item)) group.origins.push({ item, index });\n    if (isDestination(item)) group.destinations.push({ item, index });\n  });\n\n  const replacements = new Map();\n  const skipped = new Set();\n  for (const group of groups.values()) {\n    if (group.origins.length !== 1 || group.destinations.length !== 1) continue;\n    const origin = group.origins[0];\n    const destination = group.destinations[0];\n    if (origin.index === destination.index) continue;\n    const destinationSourceDate = String(destination.item?.originalDate ?? '').trim();\n    if (destinationSourceDate && destinationSourceDate !== String(origin.item.originalDate ?? '').trim()) continue;\n\n    const merged = {\n      ...origin.item,\n      ...destination.item,\n      originalDate: origin.item.originalDate,\n      originalTime: origin.item.originalTime,\n      action: origin.item.action,\n      fixedId: origin.item.fixedId || destination.item.fixedId || '',\n      course: destination.item.course || origin.item.course || '',\n      teacher: destination.item.teacher || origin.item.teacher || '',\n      site: destination.item.site || origin.item.site || '',\n      note: [\n        String(destination.item.note ?? '').trim(),\n        String(origin.item.note ?? '').trim() &&\n          String(origin.item.note ?? '').trim() !== String(destination.item.note ?? '').trim()\n          ? '原始調課：' + String(origin.item.note ?? '').trim()\n          : ''\n      ].filter(Boolean).join('；')\n    };\n    replacements.set(destination.index, merged);\n    skipped.add(origin.index);\n  }\n\n  return source.filter((_, index) => !skipped.has(index)).map((item, index) => {\n    // A filtered array changes indices; locate each surviving original index instead.\n    const originalIndex = source.findIndex((candidate, i) => !skipped.has(i) && candidate === item);\n    return replacements.get(originalIndex) || item;\n  });\n}\n\nfunction normalizeStudentNameForContact(value) {
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
  sourceTeacherCourseOverride,
  splitWrappedCourseLines,
  addMinutesToTime,
  normalizeTimeRange,
  hasDateScopedTargetOverride,
  mergeExplicitMoveDestinationOverrides,
  extractReminderStudentNames,
  isValidDateKey,
  parseDurationTargetDates,
  parseMonthDay,
  parseCourseStartDateNote,
  parseSameDayTimeChangeNote,
  parseTeacherAbsenceNote,
  parseSingleDateOnlyNote,
  parseTeacherConfirmUntil,
  timeKey
};
