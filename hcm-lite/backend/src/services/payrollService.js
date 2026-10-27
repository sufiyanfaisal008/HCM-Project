const PayrollRun = require('../models/PayrollRun');
const Payslip = require('../models/Payslip');
const Employee = require('../models/Employee');
const Attendance = require('../models/Attendance');
const LeaveRequest = require('../models/LeaveRequest');
const { getSettings, holidaySetForRange } = require('./settingsService');
const { workingDaysBetween, workingDaysInMonth, monthRange, listDateStrs, parseDateStr } = require('../utils/dates');

const httpError = (status, message) => Object.assign(new Error(message), { status });

// Illustrative annual tax slab on gross x 12:
// 0 to 600k: 0 | to 1.2M: 5% over 600k | to 2.4M: 30k + 15% over 1.2M
// to 3.6M: 210k + 25% over 2.4M | above: 510k + 35% over 3.6M
function annualTax(annualGross) {
  if (annualGross <= 600000) return 0;
  if (annualGross <= 1200000) return (annualGross - 600000) * 0.05;
  if (annualGross <= 2400000) return 30000 + (annualGross - 1200000) * 0.15;
  if (annualGross <= 3600000) return 210000 + (annualGross - 2400000) * 0.25;
  return 510000 + (annualGross - 3600000) * 0.35;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Gross = 1.5 x basic: basic + HRA (40% of basic) + medical (10% of basic).
function earnings(basic) {
  return {
    basic: round2(basic),
    hra: round2(basic * 0.4),
    medical: round2(basic * 0.1),
    gross: round2(basic * 1.5),
  };
}

// Builds (or rebuilds) the draft payroll for a month. Finalized runs are locked.
async function buildRun(year, month, actor) {
  const existing = await PayrollRun.findOne({ year, month });
  if (existing && existing.status === 'finalized') {
    throw httpError(409, `Payroll for ${year}-${month} is finalized and locked`);
  }

  const settings = await getSettings();
  const { start, end } = monthRange(year, month);
  const holidaySet = await holidaySetForRange(start, end);
  const workingDays = workingDaysBetween(start, end, settings.weekendDays, holidaySet).length;

  // While a month is still running, a draft only owes the days elapsed so far.
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const elapsedEnd = end < today ? end : today; // past month => full month; current month => today

  const employees = await Employee.find({ basicSalary: { $gt: 0 }, joinDate: { $lte: elapsedEnd } })
    .populate('department', 'name')
    .populate('designation', 'name')
    .lean();

  const run =
    existing ||
    (await PayrollRun.create({ year, month, status: 'draft', createdBy: actor.id }));

  await Payslip.deleteMany({ runId: run._id });

  const slips = [];
  for (const emp of employees) {
    // Prorate joiners and leavers (and cap at days elapsed for the running month)
    const effectiveStart = emp.joinDate > start ? emp.joinDate : start;
    const capEnd = elapsedEnd < end ? elapsedEnd : end;
    const effectiveEnd = emp.exitDate && emp.exitDate < capEnd ? emp.exitDate : capEnd;
    const expectedDays = workingDaysBetween(effectiveStart, effectiveEnd, settings.weekendDays, holidaySet).length;
    if (expectedDays <= 0) continue;
    const exitedBeforeMonth = emp.status === 'exited' && emp.exitDate && emp.exitDate < start;
    if (exitedBeforeMonth) continue;

    const { basic, hra, medical, gross } = earnings(emp.basicSalary);
    const perDayRate = round2(gross / (workingDays || 1));

    const records = await Attendance.find({
      employeeId: emp._id,
      date: { $gte: effectiveStart, $lte: effectiveEnd },
    }).lean();

    let fullDays = 0;
    let halfDays = 0;
    records.forEach((r) => {
      if (!r.checkOut) {
        // open record on a past day counts as attended (missing_checkout still pays)
        fullDays += 1;
      } else if (r.status === 'half_day') halfDays += 1;
      else fullDays += 1;
    });

    const leaves = await LeaveRequest.find({
      employeeId: emp._id,
      status: 'approved',
      start: { $lte: effectiveEnd },
      end: { $gte: effectiveStart },
    }).lean();
    let paidLeaveDays = 0;
    let unpaidDays = 0;
    leaves.forEach((l) => {
      const from = l.start > effectiveStart ? l.start : effectiveStart;
      const to = l.end < effectiveEnd ? l.end : effectiveEnd;
      const days = workingDaysBetween(from, to, settings.weekendDays, holidaySet).length;
      if (l.paid) paidLeaveDays += days;
      else unpaidDays += days;
    });

    const attended = fullDays + 0.5 * halfDays + paidLeaveDays;
    const absentDays = Math.max(0, round2(expectedDays - attended - unpaidDays));
    const absentDeduction = round2(absentDays * perDayRate);
    const unpaidDeduction = round2(unpaidDays * perDayRate);
    const halfDayDeduction = round2(0.5 * halfDays * perDayRate);
    const tax = round2(annualTax(gross * 12) / 12);
    const net = round2(gross - absentDeduction - unpaidDeduction - halfDayDeduction - tax);

    slips.push({
      runId: run._id,
      employeeId: emp._id,
      employeeCode: emp.code,
      employeeName: emp.name,
      departmentName: emp.department ? emp.department.name : '',
      designationName: emp.designation ? emp.designation.name : '',
      basic, hra, medical, gross,
      workingDays,
      expectedDays,
      absentDays,
      unpaidDays,
      halfDays,
      perDayRate,
      absentDeduction,
      unpaidDeduction,
      halfDayDeduction,
      tax,
      net,
      prorated: expectedDays < workingDays,
      note: expectedDays < workingDays ? `Prorated: payable ${expectedDays} of ${workingDays} working days` : '',
    });
  }

  if (slips.length) await Payslip.insertMany(slips);

  const totals = slips.reduce(
    (acc, s) => ({
      employees: acc.employees + 1,
      gross: round2(acc.gross + s.gross),
      deductions: round2(acc.deductions + s.absentDeduction + s.unpaidDeduction + s.halfDayDeduction),
      tax: round2(acc.tax + s.tax),
      net: round2(acc.net + s.net),
    }),
    { employees: 0, gross: 0, deductions: 0, tax: 0, net: 0 }
  );

  run.totals = totals;
  await run.save();
  return { run, payslips: slips };
}

module.exports = { buildRun, earnings, annualTax };
