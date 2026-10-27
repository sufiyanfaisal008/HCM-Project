const Attendance = require('../models/Attendance');
const Employee = require('../models/Employee');
const LeaveRequest = require('../models/LeaveRequest');
const { getSettings, holidaySetForRange } = require('./settingsService');
const {
  todayStr, minutesOf, dateMinutesSinceMidnight, monthRange, listDateStrs, parseDateStr,
} = require('../utils/dates');

const httpError = (status, message) => Object.assign(new Error(message), { status });

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function computeStatus(checkInDate, checkOutDate, settings) {
  const start = minutesOf(settings.officeStart);
  const grace = settings.graceMinutes || 0;
  const inMin = dateMinutesSinceMidnight(checkInDate);
  if (!checkOutDate) {
    // No check-out yet: late is known immediately; final "missing_checkout" is derived per day.
    return inMin > start + grace ? 'late' : 'present';
  }
  const workedH = (checkOutDate - checkInDate) / 3600000;
  if (workedH < (settings.halfDayHours || 5)) return 'half_day';
  return inMin > start + grace ? 'late' : 'present';
}

// Effective status for a stored record on a given day (handles missing_checkout).
function effectiveStatus(rec, dateStr) {
  if (!rec) return null;
  if (!rec.checkOut) {
    if (dateStr < todayStr()) return 'missing_checkout';
    return rec.status === 'late' ? 'late' : 'present'; // still open today
  }
  return rec.status;
}

async function checkIn(employeeId, { lat, lng, source = 'web' } = {}) {
  const settings = await getSettings();
  if (!settings) throw httpError(400, 'Company setup is not completed yet');

  // Geofence check (camera attendance / any check-in that sends a location)
  if (lat != null && lng != null && settings.officeLocation && settings.officeLocation.lat != null) {
    const dist = haversineMeters(lat, lng, settings.officeLocation.lat, settings.officeLocation.lng);
    if (dist > settings.officeRadiusM) {
      throw httpError(422, `Check-in rejected: you are ${Math.round(dist)} m from the office (allowed radius ${settings.officeRadiusM} m)`);
    }
  }
  if (source === 'camera' && (lat == null || lng == null)) {
    throw httpError(422, 'Camera check-in requires your location');
  }

  const date = todayStr();
  const existing = await Attendance.findOne({ employeeId, date });
  if (existing) throw httpError(409, 'You have already checked in today');

  const now = new Date();
  const rec = await Attendance.create({
    employeeId,
    date,
    checkIn: now,
    status: computeStatus(now, null, settings),
    source,
  });
  return rec;
}

async function checkOut(employeeId) {
  const settings = await getSettings();
  const date = todayStr();
  const rec = await Attendance.findOne({ employeeId, date });
  if (!rec) throw httpError(404, 'No check-in found for today');
  if (rec.checkOut) throw httpError(409, 'You have already checked out today');
  const now = new Date();
  rec.checkOut = now;
  rec.workedMinutes = Math.max(0, Math.round((now - rec.checkIn) / 60000));
  rec.status = computeStatus(rec.checkIn, now, settings);
  await rec.save();
  return rec;
}

// Daily board for HR/Admin: every employee with effective status for a date.
async function dailyBoard(dateStr) {
  const settings = await getSettings();
  const date = dateStr || todayStr();
  const employees = await Employee.find({ joinDate: { $lte: date } })
    .select('code name department joinDate exitDate status')
    .populate('department', 'name')
    .lean();

  const records = await Attendance.find({ date }).lean();
  const byEmp = new Map(records.map((r) => [String(r.employeeId), r]));

  const { start, end } = monthRange(
    Number(date.slice(0, 4)), Number(date.slice(5, 7))
  );
  const leaves = await LeaveRequest.find({
    status: 'approved',
    start: { $lte: date },
    end: { $gte: date },
  }).lean();
  const onLeaveSet = new Set(leaves.map((l) => String(l.employeeId)));

  const isWeekend = settings.weekendDays.includes(parseDateStr(date).getDay());
  const holidaySet = await holidaySetForRange(start, end);
  const isHoliday = holidaySet.has(date);

  const rows = employees
    .filter((e) => e.status !== 'exited' || (e.exitDate && e.exitDate >= date))
    .filter((e) => !e.exitDate || e.exitDate >= date)
    .filter((e) => e.joinDate <= date)
    .map((e) => {
      const rec = byEmp.get(String(e._id));
      let status;
      if (onLeaveSet.has(String(e._id))) status = 'on_leave';
      else if (rec) status = effectiveStatus(rec, date);
      else if (isWeekend) status = 'weekend';
      else if (isHoliday) status = 'holiday';
      else status = 'absent';
      return {
        employeeId: e._id,
        code: e.code,
        name: e.name,
        department: e.department ? e.department.name : '—',
        departmentId: e.department ? e.department._id : null,
        status,
        checkIn: rec ? rec.checkIn : null,
        checkOut: rec ? rec.checkOut : null,
        source: rec ? rec.source : null,
        workedMinutes: rec && rec.workedMinutes != null ? rec.workedMinutes : null,
      };
    });

  const counts = { present: 0, late: 0, half_day: 0, missing_checkout: 0, absent: 0, on_leave: 0 };
  rows.forEach((r) => {
    if (counts[r.status] !== undefined) counts[r.status] += 1;
  });

  return { date, isWeekend, isHoliday, counts, rows };
}

// Attendance trend over the last N days (or a month) for HR/Admin dashboards.
async function trend(days = 14, departmentId = null) {
  const settings = await getSettings();
  const today = todayStr();
  const from = new Date();
  from.setDate(from.getDate() - (days - 1));
  const fromStr = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}-${String(from.getDate()).padStart(2, '0')}`;

  const match = { date: { $gte: fromStr, $lte: today } };
  if (departmentId) match.departmentId = departmentId;

  const [records, leaves] = await Promise.all([
    Attendance.find(match).lean(),
    LeaveRequest.find({ status: 'approved', start: { $lte: today }, end: { $gte: fromStr } }).lean(),
  ]);

  const empFilter = departmentId ? { department: departmentId } : {};
  const employees = await Employee.find({ ...empFilter, status: { $ne: 'exited' } }).select('joinDate').lean();
  const activeIds = new Set(employees.filter((e) => e.joinDate <= today).map((e) => String(e._id)));
  const activeCount = activeIds.size;

  const holidaySet = await holidaySetForRange(fromStr, today);
  const leaveDays = new Set();
  leaves.forEach((l) => {
    if (activeIds.has(String(l.employeeId))) {
      listDateStrs(l.start > fromStr ? l.start : fromStr, l.end < today ? l.end : today).forEach((d) => leaveDays.add(`${l.employeeId}|${d}`));
    }
  });

  const out = [];
  listDateStrs(fromStr, today).forEach((d) => {
    const weekend = settings.weekendDays.includes(parseDateStr(d).getDay());
    const holiday = holidaySet.has(d);
    const dayRecords = records.filter((r) => r.date === d && activeIds.has(String(r.employeeId)));
    let attended = 0;
    let onLeave = 0;
    dayRecords.forEach((r) => {
      const s = effectiveStatus(r, d);
      if (s === 'present' || s === 'late' || s === 'missing_checkout') attended += 1;
      else if (s === 'half_day') attended += 0.5;
    });
    activeIds.forEach((id) => {
      if (leaveDays.has(`${id}|${d}`)) onLeave += 1;
    });
    const expected = weekend || holiday ? 0 : Math.max(0, activeCount - onLeave);
    const rate = expected > 0 ? (attended / expected) * 100 : null;
    out.push({
      date: d,
      label: parseDateStr(d).toLocaleDateString('en', { day: 'numeric', month: 'short' }),
      weekend: weekend || holiday,
      attended,
      onLeave,
      expected,
      rate: rate == null ? null : Math.round(rate * 10) / 10,
    });
  });
  return out;
}

module.exports = { checkIn, checkOut, dailyBoard, trend, effectiveStatus, computeStatus, haversineMeters };
