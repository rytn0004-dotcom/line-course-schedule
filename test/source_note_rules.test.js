'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  addMinutesToTime,
  normalizeTimeRange,
  extractReminderStudentNames,
  parseDurationTargetDates,
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
