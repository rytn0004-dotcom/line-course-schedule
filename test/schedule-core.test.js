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
  isYes, isObsoleteImportedRow, parseDateFlexible, splitClassRoster, buildRows, mergeActualRows,
  parseRawSchedule, dedupeSourceAdjustments, assignPreviewAdjustmentIds, parseAdjust, parseInlineAdjustments, parseFixed, parseSettings, actualObjects, makeReminderRows, adjustmentConflictWarnings, actualIntegrityWarnings, missingActualEndTimeWarnings
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

test('yes/no setting values normalize consistently', () => {
  for (const value of ['是', 'yes', 'TRUE', '1', '啟用', 'y']) assert.equal(isYes(value), true);
  for (const value of ['否', 'no', 'false', '0', '停用', '']) assert.equal(isYes(value), false);
});

test('short date rolls to the nearest year in both directions', () => {
  assert.equal(parseDateFlexible('1/5', '2026-12-20'), '2027-01-05');
  assert.equal(parseDateFlexible('10/9', '2026-10-17'), '2026-10-09');
  assert.equal(parseDateFlexible('12/30', '2027-01-03'), '2026-12-30');
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


test('legacy purple adjustment reuses its imported ID when the fixed-course link differs', () => {
  const existingRows = [
    ['調課ID', '原固定課表ID', '原日期', '原時間', '動作', '新日期', '新時間', '學生', '新課程', '新老師', '新校區', '確認', '備註'],
    ['ADJ094', '', '', '', '補課', '2026-10-17', '11:00', '苡安', '', '鄭雅方', '', '是', '[紫色調課] 來源日期 2026-10-16；單次課程：1100-1230苡安(10/16p調10/17b)；備註：10/16p調10/17b；字色 #9900FF'],
    ['ADJ105', 'FS900', '', '', '補課', '2026-10-17', '11:00', '苡安', '', '鄭雅方', '', '是', '來源：開學課表自動解析；[紫色調課] 重複匯入列']
  ];
  const parsed = [{
    id: '', fixedId: 'FS900', originalDate: '', originalTime: '', action: '補課',
    newDate: '2026-10-17', newTime: '11:00', newEndTime: '12:30',
    student: '苡安', teacher: '鄭雅方', colorStatus: 'purple',
    note: '[紫色調課] 來源日期 2026-10-16；單次課程：1100-1230苡安'
  }];
  const assigned = assignPreviewAdjustmentIds(parsed, existingRows);
  assert.equal(assigned.length, 1);
  assert.equal(assigned[0].id, 'ADJ094');
  assert.equal(assigned[0].newEndTime, '12:30');
});


test('purple single-course adjustment keeps its end time and does not raise a false warning', () => {
  const cell = {
    value: '1100-1230苡安(10/16p調10/17b)',
    textFormatRuns: [{
      startIndex: 9,
      format: { foregroundColor: { red: 0.6, green: 0, blue: 1 } }
    }]
  };
  const parsed = parseRawSchedule([
    ['老師', '星期六'],
    ['王老師', cell]
  ], 2026);

  assert.equal(parsed.adjustments.length, 1);
  const adjustment = parsed.adjustments[0];
  assert.equal(adjustment.newDate, '2026-10-17');
  assert.equal(adjustment.newTime, '11:00');
  assert.equal(adjustment.newEndTime, '12:30');

  const rows = buildRows([], [adjustment], '2026-10-17', 30);
  const oneTime = rows.find(row => row[4] === '苡安');
  assert.ok(oneTime);
  assert.equal(oneTime[1], '2026-10-17');
  assert.equal(oneTime[3], '11:00-12:30');
  assert.equal(missingActualEndTimeWarnings(rows).length, 0);
});



test('source schedule time adjustments preserve the adjusted end time, including mixed notes', () => {
  const parsed = parseRawSchedule([
    ['老師', '星期二', '星期五'],
    ['林囿錡', { value: '1700-1830以宸(10/13 1930-2100)' }, { value: '1900-2030繹桓(9/25p調10/5b，10/9 1230-1400)' }]
  ], 2026, {}, '2026-10-17');

  const yiChen = parsed.adjustments.find(x => x.student === '以宸' && x.newDate === '2026-10-13');
  assert.ok(yiChen);
  assert.equal(yiChen.newTime, '19:30');
  assert.equal(yiChen.newEndTime, '21:00');
  const yiChenActual = buildRows(parsed.fixed.filter(x => x.student === '以宸'), [yiChen], '2026-10-13', 1);
  assert.equal(yiChenActual.find(x => x[4] === '以宸')[3], '19:30-21:00');

  const yiHuan = parsed.adjustments.find(x => x.student === '繹桓' && x.newDate === '2026-10-09' && x.action === '改時間');
  assert.ok(yiHuan);
  assert.equal(yiHuan.newTime, '12:30');
  assert.equal(yiHuan.newEndTime, '14:00');
  const yiHuanActual = buildRows(parsed.fixed.filter(x => x.student === '繹桓'), [yiHuan], '2026-10-09', 1);
  assert.equal(yiHuanActual.find(x => x[4] === '繹桓')[3], '12:30-14:00');
});

test('correction-note and fixed-note time moves retain the new end time', () => {
  const correctionRows = [
    ['日期', '學生', '原時間', '校正動作', '新時間', '新課程', '新老師', '備註'],
    ['', '', '', '', '', '', '', '1830-2000昀瑄(10/9 0900-1030)']
  ];
  const correction = parseAdjust([], correctionRows, '2026-10-17')
    .find(x => x.student === '昀瑄' && x.action === '改時間');
  assert.ok(correction);
  assert.equal(correction.newTime, '09:00');
  assert.equal(correction.newEndTime, '10:30');
  const moved = buildRows([fixed({ weekday: '五', student: '昀瑄' })], [correction], '2026-10-09', 1);
  assert.equal(moved.find(x => x[4] === '昀瑄')[3], '09:00-10:30');

  const inline = parseInlineAdjustments([fixed({
    id: 'FS-TIME',
    weekday: '六',
    time: '10:30',
    endTime: '12:00',
    rawTime: '1030-1200承蓁',
    student: '承蓁',
    note: '(9/26改1000-1200)'
  })], '2026-09-26').find(x => x.action === '改時間');
  assert.ok(inline);
  assert.equal(inline.newTime, '10:00');
  assert.equal(inline.newEndTime, '12:00');
});

test('teacher-cell side notes are surfaced for manual review instead of being silently discarded', () => {
  const parsed = parseRawSchedule([
    ['老師', '星期二'],
    ['陳少禹\n11月後的課程還要再做確認', { value: '1900-2030彥銘' }]
  ], 2026, {}, '2026-10-17');
  assert.deepEqual(parsed.teacherNotes, [{
    teacher: '陳少禹',
    note: '11月後的課程還要再做確認',
    sourceRow: 2
  }]);
});

test('invalid hours are not accepted as valid course start times', () => {
  const rows = [
    ['固定課表ID', '星期', '上課時間', '學生', '課程', '老師', '校區', '有效迄日', '啟用', '備註', '通知模板'],
    ['FS-BAD', '一', '25:00-26:00', '學生甲', '數學', '老師甲', '校區甲', '', '是', '', '']
  ];
  assert.deepEqual(parseFixed(rows, '2026-10-17'), []);
});

test('mergeActualRows respects the actual header row instead of always assuming row 2', () => {
  const headers = ['Course ID', '課程日期', '星期', '上課時間', '學生', '課程', '老師', '校區', '來源', '固定課表ID', '調課ID', '調課結果', '備註', '開始時間（出勤用）', '下課時間（出勤用）'];
  const oldCourse = ['FS001-2026-12-01', '2026-12-01', '二', '18:30-20:00', '尚哲', '理化', '王老師', '愛學館信義光復校', '固定課表', 'FS001', '', '無', '', '18:30', '20:00'];
  const previous = [['標題列'], [''], [''], headers, oldCourse];
  const merged = mergeActualRows([], previous, '2026-10-17', '2026-11-15', 3);
  assert.equal(merged.previousDataCount, 1);
  assert.equal(merged.merged.length, 1);
  assert.equal(merged.merged[0][1], '2026-12-01');
});



test('source adjustment dedupe removes only fully identical normalized rules', () => {
  const base = {
    fixedId: 'FS101', originalDate: '', originalTime: '', action: '補課',
    newDate: '2026-10-17', newTime: '11:00', newEndTime: '12:30',
    student: '苡安', course: '', teacher: '鄭雅方', site: '愛學館信義光復校'
  };
  const result = dedupeSourceAdjustments([
    { ...base, note: '第一來源' },
    { ...base, note: '重複來源但文字不同' },
    { ...base, newEndTime: '13:00' }
  ]);
  assert.equal(result.rows.length, 2);
  assert.equal(result.suppressed, 1);
  assert.deepEqual(result.rows.map(x => x.newEndTime), ['12:30', '13:00']);
});

test('two same-start legacy adjustments with different end times never share an ID', () => {
  const existing = [
    ['調課ID', '原固定課表ID', '原日期', '原時間', '動作', '新日期', '新時間', '學生', '新課程', '新老師', '新校區', '確認', '備註'],
    ['ADJ094', '', '', '', '補課', '2026-10-17', '11:00', '苡安', '', '鄭雅方', '', '是', '[紫色調課] 單次課程 1100-1230苡安'],
    ['ADJ105', 'FS900', '', '', '補課', '2026-10-17', '11:00', '苡安', '', '鄭雅方', '', '是', '來源：開學課表自動解析；[紫色調課] 重複匯入']
  ];
  const assigned = assignPreviewAdjustmentIds([
    { action: '補課', newDate: '2026-10-17', newTime: '11:00', newEndTime: '12:30', student: '苡安', teacher: '鄭雅方', colorStatus: 'purple', note: '[紫色調課] 1100-1230' },
    { action: '補課', newDate: '2026-10-17', newTime: '11:00', newEndTime: '13:00', student: '苡安', teacher: '鄭雅方', colorStatus: 'purple', note: '[紫色調課] 1100-1300' }
  ], existing);
  assert.equal(assigned.length, 2);
  assert.equal(assigned[0].id, 'ADJ094');
  assert.notEqual(assigned[0].id, assigned[1].id);
});

test('actual course integrity warns about duplicates and attendance-time mismatches', () => {
  const row = [
    'COURSE-A', '2026-10-17', '六', '11:00-12:30', '苡安', '', '鄭雅方',
    '愛學館信義光復校', '調課', '', 'ADJ094', '新增調課', '', '11:00', '12:30'
  ];
  const duplicate = row.slice();
  duplicate[0] = 'COURSE-B';
  const mismatched = row.slice();
  mismatched[0] = 'COURSE-C';
  mismatched[14] = '12:00';
  const warnings = actualIntegrityWarnings([row, duplicate, mismatched]);
  assert.ok(warnings.some(w => /疑似存在重複列/.test(w)));
  assert.ok(warnings.some(w => /N\/O 出勤時間欄/.test(w)));
});

test('conflicting adjustments appear in the build warning helper', () => {
  const warnings = adjustmentConflictWarnings([
    { id: 'ADJ-A', originalDate: '2026-10-09', originalTime: '18:30', student: '昀瑄', action: '改時間', newDate: '2026-10-09', newTime: '09:00', newEndTime: '10:30', source: '課程校正' },
    { id: 'ADJ-B', originalDate: '2026-10-09', originalTime: '18:30', student: '昀瑄', action: '改時間', newDate: '2026-10-09', newTime: '10:00', newEndTime: '11:30', source: '固定課表備註' }
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /昀瑄 2026-10-09 18:30/);
  assert.match(warnings[0], /ADJ-A.*ADJ-B/);
});

test('actual course rows sort chronologically by numeric start time', () => {
  const late = ['LATE', '2026-10-17', '六', '11:00-12:30', '晚班學生', '', '老師', '校區', '固定課表', '', '', '無', '', '11:00', '12:30'];
  const early = ['EARLY', '2026-10-17', '六', '09:00-10:30', '早班學生', '', '老師', '校區', '固定課表', '', '', '無', '', '09:00', '10:30'];
  const result = mergeActualRows([late, early], [], '2026-10-17', '2026-10-17');
  assert.deepEqual(result.merged.map(row => row[0]), ['EARLY', 'LATE']);
});

test('missing course end time is reported rather than silently treated as complete', () => {
  const rows = buildRows([fixed({ endTime: '' })], [], '2026-10-19', 1);
  const warnings = missingActualEndTimeWarnings(rows);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /缺少下課時間/);
});


test('single-course adjustment can override course and teacher without changing unrelated fixed courses', () => {
  const courseRows = [
    fixed({ id: 'FS001', student: '尚哲' }),
    fixed({ id: 'FS002', student: '芯瑜', course: '數學', teacher: '李老師' })
  ];
  const adjustment = {
    id: 'ADJ020', fixedId: 'FS001',
    originalDate: '2026-10-12', originalTime: '18:30',
    action: '調課', newDate: '2026-10-12', newTime: '18:30', newEndTime: '20:00',
    student: '尚哲', course: '英文', teacher: '張老師', site: '愛學館信義光復校',
    source: '調課課程'
  };
  const rows = buildRows(courseRows, [adjustment], '2026-10-12', 1);
  const moved = rows.find(row => row[4] === '尚哲');
  const unrelated = rows.find(row => row[4] === '芯瑜');
  assert.equal(moved[5], '英文');
  assert.equal(moved[6], '張老師');
  assert.equal(moved[11], '已調課');
  assert.equal(unrelated[5], '數學');
  assert.equal(unrelated[6], '李老師');
});


test('fixed-course note leave range supports the abbreviated end day form', () => {
  const adjustments = parseInlineAdjustments([fixed({
    id: 'FS-LEAVE',
    student: '芯瑜',
    rawTime: '18:30-20:00',
    note: '(9/25~27p)'
  })], '2026-09-01');
  const dates = adjustments.filter(x => x.action === '請假').map(x => x.originalDate).sort();
  assert.deepEqual(dates, ['2026-09-25', '2026-09-26', '2026-09-27']);
});


test('source reconciliation disables only obsolete rows owned by the source importer', () => {
  const activeIds = new Set(['FS100', 'ADJ100']);
  assert.equal(isObsoleteImportedRow('FS101', '來源：開學課表自動同步', activeIds, '來源：開學課表自動同步'), true);
  assert.equal(isObsoleteImportedRow('FS100', '來源：開學課表自動同步', activeIds, '來源：開學課表自動同步'), false);
  assert.equal(isObsoleteImportedRow('FS101', '人工建立的固定課程', activeIds, '來源：開學課表自動同步'), false);
  assert.equal(isObsoleteImportedRow('ADJ101', '來源：開學課表自動解析', activeIds, '來源：開學課表'), true);
  assert.equal(isObsoleteImportedRow('ADJ101', '人工調課', activeIds, '來源：開學課表'), false);
});
