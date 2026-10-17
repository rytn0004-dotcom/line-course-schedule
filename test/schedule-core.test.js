const test = require('node:test');
const assert = require('node:assert/strict');

process.env.GOOGLE_SHEET_ID = 'unit-test-sheet-id';
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
  type: 'service_account',
  client_email: 'unit-test@example.invalid',
  private_key: 'not-used-by-pure-function-tests'
});
process.env.SCHEDULE_ADMIN_TOKEN = 'test-token';

const {
  isYes, parseDateFlexible, splitClassRoster, buildRows, mergeActualRows,
  parseAdjust, actualObjects, makeReminderRows, missingActualEndTimeWarnings
} = require('../server');

const weekday = '一';
const fixed = (overrides = {}) => ({
  id: 'FS001',
  weekday,
  time: '18:30',
  endTime: '20:00',
  student: '尚哲',
  course: '理化',
  teacher: '王老師',
  site: '愛學館信義光復校',
  until: '',
  template: '',
  note: '',
  ...overrides
});

test('yes/no setting values normalize consistently', () => {
  for (const value of ['是', 'yes', 'TRUE', '1', '啟用', 'y']) assert.equal(isYes(value), true);
  for (const value of ['否', 'no', 'false', '0', '停用', '']) assert.equal(isYes(value), false);
});

test('short date rolls into next year when the requested window is late December', () => {
  assert.equal(parseDateFlexible('1/5', '2026-12-20'), '2027-01-05');
  assert.equal(parseDateFlexible('10/9', '2026-10-17'), '2026-10-09');
});

test('group roster is split into a class name and exact student names', () => {
  assert.deepEqual(splitClassRoster('生物團班(葉依柔、陳翊森)'), {
    course: '生物團班',
    students: '葉依柔、陳翊森'
  });
  assert.deepEqual(splitClassRoster('英文'), { course: '', students: '英文' });
});

test('a moved course is included when its original date is outside the build window', () => {
  const adjusted = {
    id: 'ADJ008',
    fixedId: 'FS001',
    originalDate: '2026-10-12',
    originalTime: '18:30',
    action: '調課',
    newDate: '2026-10-21',
    newTime: '12:30',
    newEndTime: '14:00',
    student: '尚哲',
    course: '理化',
    teacher: '王老師',
    site: '愛學館信義光復校',
    source: '調課課程'
  };
  const rows = buildRows([fixed()], [adjusted], '2026-10-21', 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0][1], '2026-10-21');
  assert.equal(rows[0][3], '12:30-14:00');
  assert.equal(rows[0][4], '尚哲');
  assert.equal(rows[0][11], '已調課');
});

test('whole-day move out of a one-day window suppresses old courses without turning them into one student', () => {
  const mondayCourses = [
    fixed({ id: 'FS001', student: '尚哲' }),
    fixed({ id: 'FS002', student: '芯瑜', course: '數學', teacher: '李老師' })
  ];
  const wholeDay = {
    id: 'ADJ-WIDE',
    originalDate: '2026-10-12',
    originalTime: '',
    action: '整日調課到2026-10-20',
    newDate: '2026-10-20',
    newTime: '',
    student: '',
    source: '調課課程'
  };
  const rows = buildRows(mondayCourses, [wholeDay], '2026-10-12', 1);
  assert.deepEqual(rows, []);
});

test('one-day rebuild preserves actual courses outside the window', () => {
  const previousRows = [
    ['系統標題'],
    ['Course ID', '課程日期', '星期', '上課時間', '學生', '課程', '老師', '校區', '來源', '固定課表ID', '調課ID', '調課結果', '備註', '開始時間（出勤用）', '下課時間（出勤用）'],
    ['FS001-2026-10-21', '2026-10-21', '三', '18:30-20:00', '尚哲', '理化', '王老師', '愛學館信義光復校', '固定課表', 'FS001', '', '無', '', '', '']
  ];
  const result = mergeActualRows([], previousRows, '2026-10-20', '2026-10-20');
  assert.equal(result.merged.length, 1);
  assert.equal(result.merged[0][1], '2026-10-21');
  assert.equal(result.merged[0][13], '18:30');
  assert.equal(result.merged[0][14], '20:00');
});

test('zero-result protection only rejects when the window already has courses', () => {
  const previousRows = [
    ['title'],
    ['Course ID', '課程日期', '星期', '上課時間'],
    ['FS001-2026-10-20', '2026-10-20', '二', '18:30-20:00']
  ];
  assert.throws(
    () => mergeActualRows([], previousRows, '2026-10-20', '2026-10-20'),
    /區間內仍有/
  );
});

test('leave range 9/25~27p produces all three dates', () => {
  const headers = ['日期', '學生', '原時間', '校正動作', '新時間', '新課程', '新老師', '備註'];
  const correctionRows = [headers, ['', '', '', '', '', '', '', '1830-2000芯瑜(9/25~27p)']];
  const adjustments = parseAdjust([], correctionRows, '2026-09-01');
  const leaveDates = adjustments.filter(x => x.action === '請假').map(x => x.originalDate).sort();
  assert.deepEqual(leaveDates, ['2026-09-25', '2026-09-26', '2026-09-27']);
});

test('formal add course with an original date adds a course and keeps the fixed lesson', () => {
  const base = fixed({ weekday: '一', student: '尚哲' });
  const add = {
    id: 'ADJ015',
    fixedId: '',
    originalDate: '2026-10-12',
    originalTime: '19:00',
    action: '加課',
    newDate: '',
    newTime: '19:00',
    newEndTime: '20:00',
    student: '新生',
    course: '英文',
    teacher: '王老師',
    site: '愛學館信義光復校',
    source: '課程校正'
  };
  const rows = buildRows([base], [add], '2026-10-12', 1);
  assert.ok(rows.some(row => row[4] === '尚哲' && row[11] === '無'));
  assert.ok(rows.some(row => row[4] === '新生' && row[5] === '英文' && row[11] === '新增調課'));
});

test('group classes create separate actual rows and parent aliases resolve exactly', () => {
  const rows = buildRows([fixed({
    id: 'FS012',
    weekday: '二',
    time: '16:30',
    endTime: '18:00',
    student: '生物團班(葉依柔、陳翊森)',
    course: '',
    teacher: '王老師'
  })], [], '2026-10-20', 1);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row[4]).sort(), ['葉依柔', '陳翊森'].sort());
  assert.ok(rows.every(row => row[5] === '生物團班' && row[13] === '16:30' && row[14] === '18:00'));

  const contacts = [
    { name: '依柔家長', role: '家長', related: '依柔', userId: 'U-P1' },
    { name: '翊森家長', role: '家長', related: '翊森', userId: 'U-P2' },
    { name: '王老師', role: '老師', related: '王老師', userId: 'U-T1' }
  ];
  const settings = {
    enabled: '是', parentNotify: '是', teacherNotify: '是', requireConfirm: '否',
    send_一: '17:00', send_二: '17:00', send_三: '17:00', send_四: '17:00',
    send_五: '17:00', send_六: '17:00', send_sunday: ''
  };
  const reminders = makeReminderRows(actualObjects(rows), contacts, [], settings, new Map());
  assert.equal(reminders.filter(row => row.role === '家長').length, 2);
  const teacher = reminders.find(row => row.role === '老師');
  assert.ok(teacher);
  assert.match(teacher.student, /生物團班\(葉依柔、陳翊森\)/);
  assert.match(teacher.content, /生物團班\(葉依柔、陳翊森\)/);
});

test('disabled reminder setting creates no reminders', () => {
  const rows = buildRows([fixed()], [], '2026-10-19', 1);
  const settings = { enabled: '否', parentNotify: '是', teacherNotify: '是', requireConfirm: '否', send_五: '17:00' };
  const reminders = makeReminderRows(actualObjects(rows), [], [], settings, new Map());
  assert.deepEqual(reminders, []);
});


test('whole-day rules with a student/course/teacher field do not affect every course', () => {
  const mondayCourses = [
    fixed({ id: 'FS001', student: '尚哲' }),
    fixed({ id: 'FS002', student: '芯瑜', course: '數學', teacher: '李老師' })
  ];
  const accidentalWide = {
    id: 'ADJ-WIDE-FILLED',
    originalDate: '2026-10-12',
    originalTime: '',
    action: '整日調課到2026-10-20',
    newDate: '2026-10-20',
    newTime: '',
    student: '新生',
    course: '英文',
    teacher: '張老師',
    source: '課程校正'
  };
  const rows = buildRows(mondayCourses, [accidentalWide], '2026-10-12', 1);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row[4]).sort(), ['尚哲', '芯瑜'].sort());
  assert.ok(rows.every(row => row[1] === '2026-10-12'));
});

test('parent matching requires exact full name or unique exact short alias', () => {
  const rows = buildRows([fixed({
    id: 'FS012',
    weekday: '二',
    student: '生物團班(葉依柔、陳翊森)',
    course: '',
    teacher: '王老師'
  })], [], '2026-10-20', 1);
  const settings = {
    enabled: '是', parentNotify: '是', teacherNotify: '否', requireConfirm: '否',
    send_一: '17:00', send_二: '17:00', send_三: '17:00', send_四: '17:00',
    send_五: '17:00', send_六: '17:00'
  };
  const contacts = [
    { name: '依柔家長', role: '家長', related: '依柔', userId: 'U-1' },
    { name: '錯誤關聯', role: '家長', related: '葉依', userId: 'U-2' }
  ];
  const reminders = makeReminderRows(actualObjects(rows), contacts, [], settings, new Map());
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].recipient, '依柔家長');
});

test('admin authorization rejects missing or wrong tokens', () => {
  const { adminAuthorized } = require('../server');
  const request = supplied => ({
    get: name => name.toLowerCase() === 'x-admin-token' ? supplied : undefined,
    query: {}
  });
  assert.equal(adminAuthorized(request('test-token')), true);
  assert.equal(adminAuthorized(request('wrong-token')), false);
  assert.equal(adminAuthorized(request('')), false);
});


test('missing course end time is reported rather than silently treated as complete', () => {
  const rows = buildRows([fixed({ endTime: '' })], [], '2026-10-19', 1);
  const warnings = missingActualEndTimeWarnings(rows);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /缺少下課時間/);
});
