'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.GOOGLE_SHEET_ID = 'unit-test-sheet-id';
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
  type: 'service_account',
  client_email: 'unit-test@example.invalid',
  private_key: 'not-used-by-pure-function-tests'
});
process.env.SCHEDULE_ADMIN_TOKEN = 'unit-test-admin-token';

const {
  isYes,
  adminAuthorized,
  parseDateFlexible,
  normalizeWeekday,
  parseSettings,
  buildRows,
  mergeActualRows,
  actualIntegrityWarnings,
  fixedDataQualityWarnings,
  shouldPreserveReminderConfirmation,
  parseRawSchedule,
  unavailableSlotWarnings,
  dedupeRawFixedRows,
  actualObjects,
  makeReminderRows
} = require('../server');

const baseFixed = (overrides = {}) => ({
  id: 'FS001',
  weekday: '六',
  time: '11:00',
  endTime: '12:30',
  student: '尚哲',
  course: '理化',
  teacher: '鄭雅方',
  site: '校區甲',
  until: '',
  startsOn: '',
  template: '',
  note: '',
  ...overrides
});

const actualRow = (overrides = []) => [
  'CID-1', '2026-10-21', '三', '16:00-17:00', '學生甲', '數學', '老師甲',
  '校區甲', '固定課表', 'FS001', '', '無', ''
].map((value, i) => overrides[i] === undefined ? value : overrides[i]);

test('short dates choose the nearest year around New Year', () => {
  assert.equal(parseDateFlexible('1/5', '2026-12-20'), '2027-01-05');
  assert.equal(parseDateFlexible('12/30', '2027-01-03'), '2026-12-30');
  assert.equal(parseDateFlexible('10/9', '2026-10-17'), '2026-10-09');
});

test('weekday spellings normalize to a single Chinese weekday', () => {
  assert.equal(normalizeWeekday('星期六'), '六');
  assert.equal(normalizeWeekday('週五'), '五');
  assert.equal(normalizeWeekday('周三'), '三');
  assert.equal(normalizeWeekday('6'), '六');
  assert.equal(normalizeWeekday('7'), '日');
});

test('system settings fail closed when the reminder master switch is missing or invalid', () => {
  assert.throws(
    () => parseSettings([['設定項目', '目前值'], ['家長通知', '是']]),
    /課程提醒啟用/
  );
  assert.throws(
    () => parseSettings([['設定項目', '目前值'], ['課程提醒啟用', 'enabled']]),
    /請明確填寫/
  );
  assert.equal(parseSettings([['設定項目', '目前值'], ['課程提醒啟用', '否']]).enabled, '否');
  assert.equal(parseSettings([['設定項目', '目前值'], ['課程提醒啟用', '是']]).enabled, '是');
});

test('fixed-course quality checker flags invalid activation, time, and expiry data', () => {
  const rows = [
    ['固定課表ID', '星期', '上課時間', '學生', '課程', '老師', '校區', '有效迄日', '啟用', '備註', '通知模板'],
    ['FS-BAD-ENABLE', '一', '18:00-19:00', '甲', '理化', '老師甲', '校區甲', '', 'maybe', '', ''],
    ['FS-BAD-TIME', '三', '25:00-26:00', '乙', '數學', '老師乙', '校區甲', '', '是', '', ''],
    ['FS-BAD-UNTIL', '五', '18:00-19:00', '丙', '英文', '老師丙', '校區甲', '2026-02-31', '是', '', '']
  ];
  const warnings = fixedDataQualityWarnings(rows, '2026-10-17');
  assert.ok(warnings.some(w => /啟用.*不是明確/.test(w)));
  assert.ok(warnings.some(w => /上課時間無法判讀/.test(w)));
  assert.ok(warnings.some(w => /有效迄日無法判讀/.test(w)));
});

test('mergeActualRows preserves out-of-window rows and fills attendance start/end columns', () => {
  const headers = [
    'Course ID', '課程日期', '星期', '上課時間', '學生', '課程', '老師', '校區',
    '來源', '固定課表ID', '調課ID', '調課結果', '備註',
    '開始時間（出勤用）', '下課時間（出勤用）'
  ];
  const futureCourse = [
    'FS001-2026-12-01', '2026-12-01', '二', '18:30-20:00', '尚哲',
    '理化', '鄭雅方', '校區甲', '固定課表', 'FS001', '', '無', '', '', ''
  ];
  const previous = [['標題'], headers, futureCourse];
  const result = mergeActualRows([], previous, '2026-10-17', '2026-11-15', 1);
  assert.equal(result.merged.length, 1);
  assert.equal(result.merged[0][1], '2026-12-01');
  assert.equal(result.merged[0][13], '18:30');
  assert.equal(result.merged[0][14], '20:00');
});

test('mergeActualRows refuses to erase existing courses in an empty rebuild window', () => {
  const headers = [
    'Course ID', '課程日期', '星期', '上課時間', '學生', '課程', '老師', '校區',
    '來源', '固定課表ID', '調課ID', '調課結果', '備註'
  ];
  const old = [
    'FS001-2026-10-20', '2026-10-20', '二', '18:30-20:00', '尚哲',
    '理化', '鄭雅方', '校區甲', '固定課表', 'FS001', '', '無', ''
  ];
  assert.throws(
    () => mergeActualRows([], [['標題'], headers, old], '2026-10-20', '2026-10-20', 1),
    /區間內仍有/
  );
});

test('actual integrity checker finds duplicates, overlaps, and time column mismatches', () => {
  const one = [
    'C1', '2026-10-21', '三', '09:00-10:30', '尚哲', '理化', '老師甲',
    '校區甲', '固定課表', 'FS001', '', '無', '', '09:00', '10:30'
  ];
  const duplicate = one.slice();
  duplicate[0] = 'C1-DUP';
  const overlap = [
    'C2', '2026-10-21', '三', '10:00-11:00', '尚哲', '數學', '老師乙',
    '校區乙', '固定課表', 'FS002', '', '無', '', '10:00', '11:00'
  ];
  const mismatch = one.slice();
  mismatch[0] = 'C3';
  mismatch[14] = '10:15';
  const warnings = actualIntegrityWarnings([one, duplicate, overlap, mismatch]);
  assert.ok(warnings.some(w => /重複列/.test(w)));
  assert.ok(warnings.some(w => /學生.*時段重疊/.test(w)));
  assert.ok(warnings.some(w => /出勤時間欄/.test(w)));
});

test('reminder confirmation is preserved only when schedule and message are unchanged', () => {
  const headers = [
    '提醒ID', '課程日期', '上課時間', '發送日期', '發送時間', '身分', '收件人',
    '學生/學生成員', '課程', '老師', '校區', '訊息內容', '確認發送'
  ];
  const oldRow = [
    'MERGED-1', '2026-10-17', '11:00', '2026-10-16', '17:00', '家長', '尚哲家長',
    '尚哲', '理化', '鄭雅方', '校區甲', '提醒：11:00-12:30', '是'
  ];
  assert.equal(shouldPreserveReminderConfirmation(oldRow, oldRow.slice(), headers), true);
  const changed = oldRow.slice();
  changed[11] = '提醒：11:00-13:00';
  assert.equal(shouldPreserveReminderConfirmation(oldRow, changed, headers), false);
  changed[11] = oldRow[11];
  changed[1] = '2026-10-18';
  assert.equal(shouldPreserveReminderConfirmation(oldRow, changed, headers), false);
});

test('admin endpoint authorization requires the configured token', () => {
  const valid = { get: name => name === 'x-admin-token' ? 'unit-test-admin-token' : '', query: {} };
  const invalid = { get: name => name === 'x-admin-token' ? 'wrong-token' : '', query: {} };
  assert.equal(adminAuthorized(valid), true);
  assert.equal(adminAuthorized(invalid), false);
  assert.equal(adminAuthorized({ get: () => '', query: {} }), false);
});

test('source schedule scanner separates blocked slots from empty available slots', () => {
  const parsed = parseRawSchedule([
    ['老師', '星期三', '星期二'],
    ['老師甲', { value: '1400-1845無法排課' }, { value: '2000-2130' }]
  ], 2026, {});
  assert.equal(parsed.unavailableSlots.length, 1);
  assert.deepEqual(
    {
      teacher: parsed.unavailableSlots[0].teacher,
      weekday: parsed.unavailableSlots[0].weekday,
      start: parsed.unavailableSlots[0].start,
      end: parsed.unavailableSlots[0].end
    },
    { teacher: '老師甲', weekday: '三', start: '14:00', end: '18:45' }
  );
  assert.equal(parsed.openSlots.length, 1);
  const warnings = unavailableSlotWarnings([actualRow()], parsed.unavailableSlots);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /老師甲/);
  assert.match(warnings[0], /禁排時段 14:00-18:45/);
});

test('yellow font on line breaks does not disable adjacent black lessons', () => {
  const yellow = { red: 1, green: 1, blue: 0 };
  const black = { red: 0, green: 0, blue: 0 };
  const cell = {
    value: '1830-2000珮瑜\n2000-2130彥銘',
    // Mimic a rich-text cell whose cell-level effective color is yellow,
    // while the only explicit yellow run is the newline separator.
    effectiveFormat: { textFormat: { foregroundColor: yellow } },
    textFormatRuns: [
      // Match the uploaded workbook: course text is explicitly black,
      // while only newline separators may carry yellow formatting.
      { startIndex: 0, format: { foregroundColor: black } },
      { startIndex: 11, format: { foregroundColor: yellow } },
      { startIndex: 12, format: { foregroundColor: black } }
    ]
  };
  const parsed = parseRawSchedule([['老師', '星期一'], ['吳佳盈', cell]], 2026, {});
  assert.deepEqual(parsed.fixed.map(item => item.student), ['珮瑜', '彥銘']);
  assert.ok(parsed.fixed.every(item => item.colorStatus !== 'yellow'));

  // Actual yellow font on the course itself must still be recognized.
  const actualYellow = {
    value: '1830-2000珮瑜',
    effectiveFormat: { textFormat: { foregroundColor: black } },
    textFormatRuns: [{ startIndex: 0, format: { foregroundColor: yellow } }]
  };
  const yellowParsed = parseRawSchedule(
    [['老師', '星期一'], ['吳佳盈', actualYellow]], 2026, {}
  );
  assert.equal(yellowParsed.fixed[0].colorStatus, 'yellow');
});

test('source scanner warns on an untimed availability note without presuming all-day closure', () => {
  const parsed = parseRawSchedule([
    ['老師', '星期三'],
    ['老師甲', { value: '近期無法排課寵物回診' }]
  ], 2026, {});
  assert.equal(parsed.unavailableSlots.length, 1);
  assert.equal(parsed.unavailableSlots[0].allDayOrUnspecified, true);
  const warnings = unavailableSlotWarnings([], parsed.unavailableSlots);
  assert.ok(warnings.some(w => /不會自行推定為整日停課/.test(w)));
});

test('invalid source time strings are surfaced as unclassified instead of disappearing silently', () => {
  const parsed = parseRawSchedule([
    ['老師', '星期一'],
    ['老師甲', { value: '2500-2600學生甲' }]
  ], 2026, {});
  assert.ok(parsed.unclassifiedItems.some(x => /時間格式無效/.test(x.note)));
});

test('identical fixed source rows are deduplicated while conflicting duplicates are blocked', () => {
  const base = {
    weekday: '六', time: '11:00', endTime: '12:30', student: '尚哲',
    course: '理化', teacher: '鄭雅方', site: '校區甲', untilDate: '',
    startsOn: '', colorStatus: 'black', note: '', rawTime: '1100-1230尚哲'
  };
  const duplicates = dedupeRawFixedRows([base, {...base}]);
  assert.equal(duplicates.rows.length, 1);
  assert.equal(duplicates.suppressed, 1);
  assert.equal(duplicates.conflicts.length, 0);
  const conflicting = dedupeRawFixedRows([base, {...base, endTime: '13:00'}]);
  assert.equal(conflicting.conflicts.length, 1);
  assert.equal(conflicting.suppressed, 0);
});

test('missing parent template creates a non-empty safety fallback reminder', () => {
  const actual = buildRows([
    baseFixed({ weekday: '二', time: '18:30', endTime: '20:00' })
  ], [], '2026-10-20', 1);
  const settings = {
    enabled: '是', parentNotify: '是', teacherNotify: '否', requireConfirm: '是',
    send_sunday: '', send_一: '17:00', send_二: '17:00', send_三: '17:00',
    send_四: '17:00', send_五: '17:00', send_六: '17:00'
  };
  const reminders = makeReminderRows(
    actualObjects(actual),
    [{name: '尚哲家長', role: '家長', related: '尚哲', userId: 'U-PARENT'}],
    [],
    settings,
    new Map()
  );
  assert.equal(reminders.length, 1);
  assert.match(reminders[0].content, /尚哲/);
  assert.match(reminders[0].content, /18:30-20:00/);
});
