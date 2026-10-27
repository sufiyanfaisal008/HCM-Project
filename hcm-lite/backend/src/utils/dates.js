// Date helpers. Dates inside the app are handled as local 'YYYY-MM-DD' strings
// so that attendance days never shift because of timezone conversion.

const pad2 = (n) => String(n).padStart(2, '0');

function toDateStr(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// Parse 'YYYY-MM-DD' into a local Date at noon (avoids DST / timezone edge cases).
function parseDateStr(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}

function isValidDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = parseDateStr(s);
  return toDateStr(d) === s;
}

function isValidTimeStr(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

function minutesOf(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function dateMinutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function listDateStrs(startStr, endStr) {
  const out = [];
  let d = parseDateStr(startStr);
  const end = parseDateStr(endStr);
  while (toDateStr(d) <= toDateStr(end)) {
    out.push(toDateStr(d));
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 12);
  }
  return out;
}

function isWeekendStr(dateStr, weekendDays) {
  return weekendDays.includes(parseDateStr(dateStr).getDay());
}

function workingDaysBetween(startStr, endStr, weekendDays, holidaySet) {
  return listDateStrs(startStr, endStr).filter(
    (s) => !weekendDays.includes(parseDateStr(s).getDay()) && !holidaySet.has(s)
  );
}

function monthRange(year, month) {
  const start = `${year}-${pad2(month)}-01`;
  const endDate = new Date(year, month, 0, 12); // day 0 of next month = last day
  return { start, end: toDateStr(endDate) };
}

function workingDaysInMonth(year, month, weekendDays, holidaySet) {
  const { start, end } = monthRange(year, month);
  return workingDaysBetween(start, end, weekendDays, holidaySet);
}

function todayStr() {
  return toDateStr(new Date());
}

function monthLabel(year, month) {
  return new Date(year, month - 1, 1).toLocaleString('en', { month: 'long', year: 'numeric' });
}

module.exports = {
  pad2,
  toDateStr,
  parseDateStr,
  isValidDateStr,
  isValidTimeStr,
  minutesOf,
  dateMinutesSinceMidnight,
  listDateStrs,
  isWeekendStr,
  workingDaysBetween,
  workingDaysInMonth,
  monthRange,
  todayStr,
  monthLabel,
};
