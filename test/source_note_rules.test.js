'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  addMinutesToTime,
  normalizeTimeRange,
  hasDateScopedTargetOverride,
  mergeExplicitMoveDestinationOverrides,
  isSourceImportedFixedNote,
  extractReminderStudentNames,
  parseDurationTargetDates,
  parseCourseStartDateNote,
  parseSameDayTimeChangeNote,
  parseTeacherAbsenceNote,
  parseSingleDateOnlyNote,
  parseTeacherConfirmUntil,
  splitWrappedCourseLines,
  sourceTeacherCourseOverride
} = require('../source_note_rules');

test('parses same-day time changes with the source timetable notation', () => {
  assert.deepEqual(parseSameDayTimeChangeNote('10/9改1030~1230', 2026), {
    date: '2026-10-09', start: '10:30', end: '12:30'
  });
});

test('source-imported fixed-row notes are not reparsed as a second adjustment source', () => {
  assert.equal(isSourceImportedFixedNote('來源：開學課表自動同步；來源註記：10/15調10/12b'), true);
  assert.equal(isSourceImportedFixedNote('人工備註：10/15調10/12b'), false);
  assert.equal(isSourceImportedFixedNote(''), false);
});

test('reads effective start dates from the source timetable notes', () => {
  assert.equal(parseCourseStartDateNote('10/6開始，週三改週二', 2026), '2026-10-06');
  assert.equal(parseCourseStartDateNote('10/6開始，週五改週四', 2026), '2026-10-06');
  assert.equal(parseCourseStartDateNote('週三改週二', 2026), '');
  assert.equal(parseCourseStartDateNote('13/40開始', 2026), '');
});

test('recognizes one-date-only course annotations without treating moves as one-date classes', () => {
  assert.equal(parseSingleDateOnlyNote(['僅10/9'], 2026), '2026-10-09');
  assert.equal(parseSingleDateOnlyNote(['10/3而已'], 2026), '2026-10-03');
  assert.equal(parseSingleDateOnlyNote(['10/10p調10/9b'], 2026), '');
});

test('extracts only the explicit dates for the +30 minute schedule variant', () => {
  assert.deepEqual(
    parseDurationTargetDates('9/28p調9/21、10/5、10/12各+30min，除了9/14、9/21、10/5、10/12外都看上面', 2026),
    {
      sourceDate: '2026-09-28',
      targetDates: ['2026-09-21', '2026-10-05', '2026-10-12']
    }
  );
});

test('preserves start and end in course time ranges', () => {
  assert.equal(normalizeTimeRange('0900-1030'), '09:00-10:30');
  assert.equal(normalizeTimeRange('09:00~10:30'), '09:00-10:30');
  assert.equal(normalizeTimeRange('13:00'), '13:00');
});

test('calculates extension end times safely', () => {
  assert.equal(addMinutesToTime('12:30', 30), '13:00');
  assert.equal(addMinutesToTime('23:45', 30), '');
});

test('uses the explicit destination-cell time when it differs from the source move time', () => {
  const sourceMove = {
    id: 'ADJ-SOURCE',
    fixedId: 'FS010',
    originalDate: '2026-10-15',
    originalTime: '18:00',
    action: '調課',
    newDate: '2026-10-12',
    newTime: '18:00-19:30',
    student: '測試學生A',
    course: '',
    teacher: '測試老師A',
    site: '',
    note: '來源：開學課表；10/15調10/12b',
    source: '開學課表'
  };
  const destination = {
    id: 'ADJ-TARGET',
    fixedId: '',
    originalDate: '2026-10-15',
    originalTime: '17:30',
    action: '調課',
    newDate: '2026-10-12',
    newTime: '17:30-19:00',
    student: '測試學生A',
    course: '',
    teacher: '測試老師A',
    site: '',
    note: '[單次課程] 目的日課程；10/15調10/12b',
    source: '開學課表'
  };

  const merged = mergeExplicitMoveDestinationOverrides([sourceMove, destination]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].originalDate, '2026-10-15');
  assert.equal(merged[0].originalTime, '18:00');
  assert.equal(merged[0].newDate, '2026-10-12');
  assert.equal(merged[0].newTime, '17:30-19:00');
  assert.equal(merged[0].student, '測試學生A');
  assert.equal(merged[0].action, '調課');
  assert.match(merged[0].note, /原始調課/);
});

test('uses the longer date-specific slot from the uploaded timetable for each listed target date', () => {
  const sourceMoves = ['2026-10-08', '2026-10-15', '2026-10-22'].map((newDate, index) => ({
    id: 'ADJ-SOURCE-' + index,
    fixedId: 'FS-測試學生B',
    originalDate: '2026-10-01',
    originalTime: '18:00',
    action: '調課',
    newDate,
    newTime: '18:00-19:30',
    student: '測試學生B',
    course: '',
    teacher: '測試老師B',
    site: '',
    note: '來源：開學課表；10/1p調10/8b、10/15b、10/22b',
    source: '開學課表'
  }));
  const destinationSlots = ['2026-10-08', '2026-10-15', '2026-10-22'].map((newDate, index) => ({
    id: 'ADJ-TARGET-' + index,
    fixedId: '',
    originalDate: '',
    originalTime: '',
    action: '補課',
    newDate,
    newTime: '18:00-20:00',
    student: '測試學生B',
    course: '',
    teacher: '測試老師B',
    site: '',
    note: '[單次課程] 10/8、10/15、10/22；原始時段 18:00-20:00',
    source: '開學課表'
  }));

  const merged = mergeExplicitMoveDestinationOverrides([...sourceMoves, ...destinationSlots]);
  assert.equal(merged.length, 3);
  for (const item of merged) {
    assert.equal(item.originalDate, '2026-10-01');
    assert.equal(item.action, '調課');
    assert.equal(item.newTime, '18:00-20:00');
    assert.equal(item.student, '測試學生B');
    assert.match(item.note, /原始調課/);
  }
  assert.deepEqual(merged.map(item => item.newDate).sort(), ['2026-10-08', '2026-10-15', '2026-10-22']);
});

test('does not merge ambiguous move destinations', () => {
  const move = {
    originalDate: '2026-10-15', originalTime: '18:00', action: '調課',
    newDate: '2026-10-12', newTime: '18:00-19:30',
    student: '測試學生A', teacher: '測試老師A', site: '', note: '來源：開學課表'
  };
  const duplicateMove = { ...move, originalDate: '2026-10-08', originalTime: '18:30' };
  const destination = {
    originalDate: '', originalTime: '', action: '補課',
    newDate: '2026-10-12', newTime: '17:30-19:00',
    student: '測試學生A', teacher: '測試老師A', site: '', note: '[單次課程] 10/12；原始時段 17:30-19:00'
  };
  const result = mergeExplicitMoveDestinationOverrides([move, duplicateMove, destination]);
  assert.equal(result.length, 3);
});

test('suppresses weekly slot when an explicit move target replaces it on the same start time', () => {
  const adjustments = [{
    originalDate: '2026-10-01',
    newDate: '2026-10-22',
    action: '調課',
    student: '測試學生B',
    newTime: '18:00-20:00',
    note: '[單次課程] 目的日課程；原始調課：10/1p調10/8b、10/15b、10/22b'
  }];
  assert.equal(hasDateScopedTargetOverride(adjustments, '2026-10-22', '測試學生B', '18:00'), true);
  assert.equal(hasDateScopedTargetOverride(adjustments, '2026-10-23', '測試學生B', '18:00'), false);
  assert.equal(hasDateScopedTargetOverride(adjustments, '2026-10-22', '另一位學生', '18:00'), false);
  assert.equal(hasDateScopedTargetOverride(adjustments, '2026-10-22', '測試學生B', '19:00'), false);
  assert.equal(hasDateScopedTargetOverride([{
    originalDate: '',
    newDate: '2026-10-22',
    action: '補課',
    student: '測試學生B',
    newTime: '18:00-20:00',
    note: '[單次課程] 單次額外課程'
  }], '2026-10-22', '測試學生B', '18:00'), false);
});

test('extracts group members without confusing the group label or date note for a student', () => {
  assert.deepEqual(
    extractReminderStudentNames('國二理化團班(嘉恆、大濬、柏諭)'),
    ['嘉恆', '大濬', '柏諭']
  );
  assert.deepEqual(
    extractReminderStudentNames('生物團班(葉依柔、陳翊森)、繹桓、慕萱'),
    ['葉依柔', '陳翊森', '繹桓', '慕萱']
  );
  assert.deepEqual(extractReminderStudentNames('生物團班(10/9 0900-1100)'), []);
});

test('joins wrapped note lines only when parentheses are still open', () => {
  const result = splitWrappedCourseLines(
    '1900-2030繹桓(9/25p調10/5b，\n10/9 1230-1400)\n2030-2200慕萱'
  );
  assert.deepEqual(result.map(x => x.text), [
    '1900-2030繹桓(9/25p調10/5b， 10/9 1230-1400)',
    '2030-2200慕萱'
  ]);
});

test('attaches standalone adjustment lines to the preceding course', () => {
  const result = splitWrappedCourseLines(
    '1830-2000苡安(10/9p)\n(10/16p調10/17b)'
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].text, '1830-2000苡安(10/9p) (10/16p調10/17b)');
});

test('recognizes teacher leave but not teacher-leave moves as cancellations', () => {
  assert.equal(parseTeacherAbsenceNote('10/17師p', 2026), '2026-10-17');
  assert.equal(parseTeacherAbsenceNote('10/5師p', 2026), '2026-10-05');
  assert.equal(parseTeacherAbsenceNote('(9/26老\n師p)', 2026), '2026-09-26');
  assert.equal(parseTeacherAbsenceNote('10/5師p調10/14b', 2026), '');
});

test('resolves explicit substitute teacher and course labels', () => {
  assert.deepEqual(sourceTeacherCourseOverride('10/9 1030-1200詔鈞代'), {
    teacher: '楊詔鈞', course: ''
  });
  assert.deepEqual(sourceTeacherCourseOverride('10/10p調10/9b佳盈代'), {
    teacher: '吳佳盈', course: ''
  });
  assert.deepEqual(sourceTeacherCourseOverride('10/10p調10/9b維軒數學'), {
    teacher: '林維軒', course: '數學'
  });
  assert.deepEqual(sourceTeacherCourseOverride('9/28p調10/9b政銓代'), {
    teacher: '黃政銓', course: ''
  });
  assert.deepEqual(sourceTeacherCourseOverride('10/9改1030~1230'), {
    teacher: '', course: ''
  });
});

test('applies teacher row confirmation windows to the stated month', () => {
  assert.equal(parseTeacherConfirmUntil('11月後的課程還要再做確認', 2026), '2026-11-30');
  assert.equal(parseTeacherConfirmUntil('平日1530後可排課', 2026), '');
});
