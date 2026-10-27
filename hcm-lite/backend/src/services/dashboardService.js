const Employee = require('../models/Employee');
const Attendance = require('../models/Attendance');
const AttendanceCorrection = require('../models/AttendanceCorrection');
const Holiday = require('../models/Holiday');
const Department = require('../models/Department');
const LeaveRequest = require('../models/LeaveRequest');
const LeaveType = require('../models/LeaveType');
const PayrollRun = require('../models/PayrollRun');
const Payslip = require('../models/Payslip');
const AuditLog = require('../models/AuditLog');
const Announcement = require('../models/Announcement');
const { getSettings } = require('./settingsService');
const { effectiveStatus, trend, dailyBoard } = require('./attendanceService');
const { balancesFor } = require('./leaveService');
const { workingDaysInMonth, monthRange, todayStr, parseDateStr, listDateStrs } = require('../utils/dates');

const round1 = (n) => Math.round(n * 10) / 10;

async function adminDashboard({ from, to, department } = {}) {
  const settings = await getSettings();
  const now = new Date();
  const year = now.getFullYear();

  const deptFilter = department ? { department } : {};
  const [active, probation, exitsYtd, employees, runs, recentAudit, announcements] = await Promise.all([
    Employee.countDocuments({ ...deptFilter, status: 'active' }),
    Employee.countDocuments({ ...deptFilter, status: 'probation' }),
    Employee.countDocuments({ status: 'exited', exitDate: { $gte: `${year}-01-01` } }),
    Employee.find({ status: { $ne: 'exited' } }).populate('department', 'name').select('gender joinDate department basicSalary').lean(),
    PayrollRun.find({ status: 'finalized' }).lean(),
    AuditLog.find().sort({ createdAt: -1 }).limit(12).lean(),
    Announcement.find().sort({ createdAt: -1 }).limit(5).populate('postedBy', 'name').lean(),
  ]);

  const headcount = active + probation;
  const avgHeadcount = headcount || 1;
  const attritionRate = round1((exitsYtd / avgHeadcount) * 100);

  let payrollCostYTD = 0;
  const monthlyCost = {};
  runs.forEach((r) => {
    if (r.year !== year) return;
    payrollCostYTD += r.totals.net || 0;
    monthlyCost[`${r.year}-${String(r.month).padStart(2, '0')}`] = r.totals.net || 0;
  });

  const byDeptMap = new Map();
  let totalSalary = 0;
  employees.forEach((e) => {
    const name = e.department ? e.department.name : 'Unassigned';
    byDeptMap.set(name, (byDeptMap.get(name) || 0) + 1);
    totalSalary += e.basicSalary * 1.5;
  });
  const headcountByDept = [...byDeptMap.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  const avgSalary = employees.length ? Math.round(totalSalary / employees.length) : 0;

  const gender = { male: 0, female: 0, other: 0 };
  employees.forEach((e) => {
    gender[e.gender] = (gender[e.gender] || 0) + 1;
  });

  const tenureBuckets = { '<1 yr': 0, '1-3 yrs': 0, '3-5 yrs': 0, '5+ yrs': 0 };
  employees.forEach((e) => {
    const yrs = (Date.now() - parseDateStr(e.joinDate).getTime()) / (365.25 * 24 * 3600 * 1000);
    if (yrs < 1) tenureBuckets['<1 yr'] += 1;
    else if (yrs < 3) tenureBuckets['1-3 yrs'] += 1;
    else if (yrs < 5) tenureBuckets['3-5 yrs'] += 1;
    else tenureBuckets['5+ yrs'] += 1;
  });

  return {
    role: 'admin',
    company: settings ? settings.companyName : '',
    kpis: {
      headcount,
      probation,
      exitsYtd,
      attritionRate,
      payrollCostYTD: Math.round(payrollCostYTD),
      avgSalary,
    },
    headcountByDept,
    monthlyPayrollCost: Object.entries(monthlyCost).map(([month, net]) => ({ month, net: Math.round(net) })),
    genderSplit: Object.entries(gender).map(([name, value]) => ({ name, value })),
    tenureBuckets: Object.entries(tenureBuckets).map(([name, value]) => ({ name, value })),
    recentAudit: recentAudit.map((a) => ({
      id: a._id,
      actorName: a.actorName,
      action: a.action,
      entity: a.entity,
      at: a.createdAt,
    })),
    announcements,
  };
}

async function hrDashboard({ department } = {}) {
  const today = todayStr();
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const deptFilter = department ? { department } : {};

  const [board, headcount, pendingLeaves, pendingCorrections, leaveByType, lateAgg, employees] = await Promise.all([
    dailyBoard(today),
    Employee.countDocuments({ ...deptFilter, status: { $ne: 'exited' } }),
    LeaveRequest.countDocuments({ status: 'pending' }),
    AttendanceCorrection.countDocuments({ status: 'pending' }),
    LeaveRequest.aggregate([
      { $match: { status: 'approved', start: { $gte: `${now.getFullYear()}-01-01` } } },
      { $group: { _id: '$typeName', days: { $sum: '$days' } } },
      { $sort: { days: -1 } },
    ]),
    Attendance.aggregate([
      { $match: { date: { $gte: monthStart, $lte: today }, status: 'late' } },
      { $group: { _id: '$employeeId', lateCount: { $sum: 1 } } },
      { $sort: { lateCount: -1 } },
      { $limit: 5 },
    ]),
    Employee.find({ status: { $ne: 'exited' } }).select('name department').populate('department', 'name').lean(),
  ]);

  let rows = board.rows;
  if (department) rows = rows.filter((r) => r.departmentId && String(r.departmentId) === String(department));

  const topLate = [];
  for (const item of lateAgg) {
    const emp = employees.find((e) => String(e._id) === String(item._id));
    if (emp && (!department || String(emp.department?._id) === String(department))) {
      topLate.push({ name: emp.name, lateCount: item.lateCount });
    }
  }

  const trendData = await trend(14, department || null);

  // Absenteeism by department for the current month
  const settings = await getSettings();
  const { start, end } = monthRange(now.getFullYear(), now.getMonth() + 1);
  const holidayDocs = await Holiday.find({ date: { $gte: start, $lte: end } }).select('date');
  const holidaySet = new Set(holidayDocs.map((h) => h.date));
  const workingDaysThisMonth = workingDaysInMonth(now.getFullYear(), now.getMonth() + 1, settings.weekendDays, holidaySet);
  const allActive = await Employee.find({ status: { $ne: 'exited' }, joinDate: { $lte: end } }).select('department joinDate').lean();
  const records = await Attendance.find({ date: { $gte: start, $lte: today } }).lean();
  const leaves = await LeaveRequest.find({ status: 'approved', start: { $lte: today }, end: { $gte: start } }).lean();

  const deptStats = new Map();
  allActive.forEach((e) => {
    const key = String(e.department || 'none');
    if (!deptStats.has(key)) deptStats.set(key, { absent: 0, expected: 0, deptId: e.department });
    const stat = deptStats.get(key);
    const from = e.joinDate > start ? e.joinDate : start;
    const daysSoFar = listDateStrs(from, today).filter(
      (d) => !settings.weekendDays.includes(parseDateStr(d).getDay()) && !holidaySet.has(d)
    );
    stat.expected += daysSoFar.length;
  });
  const attendedByDept = new Map();
  const empDept = new Map(allActive.map((e) => [String(e._id), String(e.department || 'none')]));
  records.forEach((r) => {
    const key = empDept.get(String(r.employeeId));
    if (!key) return;
    const s = effectiveStatus(r, r.date);
    const w = s === 'half_day' ? 0.5 : 1;
    attendedByDept.set(key, (attendedByDept.get(key) || 0) + w);
  });
  const onLeaveByDept = new Map();
  leaves.forEach((l) => {
    const key = empDept.get(String(l.employeeId));
    if (!key) return;
    const days = listDateStrs(l.start > start ? l.start : start, l.end < today ? l.end : today)
      .filter((d) => !settings.weekendDays.includes(parseDateStr(d).getDay()) && !holidaySet.has(d)).length;
    onLeaveByDept.set(key, (onLeaveByDept.get(key) || 0) + days);
  });

  const deptNames = new Map();
  for (const d of await Department.find().lean()) deptNames.set(String(d._id), d.name);

  const absenteeismByDept = [];
  deptStats.forEach((stat, key) => {
    const attended = attendedByDept.get(key) || 0;
    const onLeave = onLeaveByDept.get(key) || 0;
    const expected = Math.max(0, stat.expected - onLeave);
    const absent = Math.max(0, expected - attended);
    absenteeismByDept.push({
      name: key === 'none' ? 'Unassigned' : deptNames.get(key) || 'Dept',
      absentDays: absent,
      rate: expected > 0 ? round1((absent / expected) * 100) : 0,
    });
  });

  return {
    role: 'hr',
    kpis: {
      headcount,
      presentToday: board.counts.present + board.counts.missing_checkout,
      lateToday: board.counts.late,
      halfToday: board.counts.half_day,
      onLeaveToday: board.counts.on_leave,
      absentToday: board.counts.absent,
      pendingLeaveApprovals: pendingLeaves,
      pendingCorrections,
    },
    todayBoard: { date: board.date, counts: board.counts, isWeekend: board.isWeekend, isHoliday: board.isHoliday },
    trend: trendData,
    absenteeismByDept,
    leaveByType: leaveByType.map((l) => ({ name: l._id, days: l.days })),
    top5LateComers: topLate,
  };
}

async function employeeDashboard(employeeId) {
  const settings = await getSettings();
  const today = todayStr();
  const now = new Date();

  // Week = last 7 days (simple rolling week against standard hours)
  const from = new Date();
  from.setDate(from.getDate() - 6);
  const fromStr = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}-${String(from.getDate()).padStart(2, '0')}`;

  const [todayRec, weekRecords, monthRecords, balances, lastPayslip, announcements] = await Promise.all([
    Attendance.findOne({ employeeId, date: today }).lean(),
    Attendance.find({ employeeId, date: { $gte: fromStr, $lte: today } }).lean(),
    Attendance.find({
      employeeId,
      date: { $gte: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`, $lte: today },
    }).lean(),
    balancesFor(employeeId, now.getFullYear()),
    Payslip.findOne({ employeeId }).sort({ createdAt: -1 }).lean(),
    Announcement.find().sort({ createdAt: -1 }).limit(5).lean(),
  ]);

  const minutesThisWeek = weekRecords.reduce((sum, r) => sum + (r.workedMinutes || 0), 0);
  const lateCountMonth = monthRecords.filter((r) => r.status === 'late').length;

  return {
    role: 'employee',
    company: settings ? settings.companyName : '',
    today: {
      date: today,
      checkedIn: Boolean(todayRec),
      checkedOut: Boolean(todayRec && todayRec.checkOut),
      checkIn: todayRec ? todayRec.checkIn : null,
      checkOut: todayRec ? todayRec.checkOut : null,
      status: todayRec ? effectiveStatus(todayRec, today) : null,
      source: todayRec ? todayRec.source : null,
    },
    hoursThisWeek: round1(minutesThisWeek / 60),
    standardWeekHours: settings ? settings.standardWeekHours : 40,
    lateCountMonth,
    leaveBalances: balances,
    lastPayslip: lastPayslip
      ? { id: lastPayslip._id, net: lastPayslip.net, gross: lastPayslip.gross, createdAt: lastPayslip.createdAt }
      : null,
    announcements,
  };
}

module.exports = { adminDashboard, hrDashboard, employeeDashboard };
