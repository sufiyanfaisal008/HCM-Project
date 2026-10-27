const LeaveRequest = require('../models/LeaveRequest');
const LeaveType = require('../models/LeaveType');
const { getSettings, holidaySetForRange } = require('./settingsService');
const { workingDaysBetween, todayStr, parseDateStr, isValidDateStr } = require('../utils/dates');

const httpError = (status, message) => Object.assign(new Error(message), { status });

async function balancesFor(employeeId, year = new Date().getFullYear()) {
  const types = await LeaveType.find().lean();
  const approved = await LeaveRequest.find({
    employeeId,
    status: 'approved',
  }).lean();
  const usedByType = new Map();
  approved.forEach((l) => {
    // Count working days that fall inside the requested year.
    const startYear = Number(l.start.slice(0, 4));
    if (startYear !== year) return;
    usedByType.set(l.leaveType.toString(), (usedByType.get(l.leaveType.toString()) || 0) + l.days);
  });
  return types.map((t) => {
    const used = usedByType.get(String(t._id)) || 0;
    return {
      typeId: t._id,
      name: t.name,
      paid: t.paid,
      quota: t.unlimited ? null : t.annualQuota,
      used,
      remaining: t.unlimited ? null : Math.max(0, t.annualQuota - used),
    };
  });
}

async function applyLeave(employeeId, { leaveTypeId, start, end, reason }) {
  const settings = await getSettings();
  if (!isValidDateStr(start) || !isValidDateStr(end)) throw httpError(422, 'Invalid start or end date');
  if (start > end) throw httpError(422, 'Start date must be on or before end date');
  if (start < todayStr()) throw httpError(422, 'Leave cannot start in the past');
  if (!reason || !reason.trim()) throw httpError(422, 'A reason is required');

  const type = await LeaveType.findById(leaveTypeId);
  if (!type) throw httpError(422, 'Unknown leave type');

  const holidaySet = await holidaySetForRange(start, end);
  const days = workingDaysBetween(start, end, settings.weekendDays, holidaySet);
  if (days.length === 0) throw httpError(422, 'The selected range has no working days (weekend/holiday only)');

  // Overlap check against pending or approved leaves
  const overlap = await LeaveRequest.findOne({
    employeeId,
    status: { $in: ['pending', 'approved'] },
    start: { $lte: end },
    end: { $gte: start },
  });
  if (overlap) {
    throw httpError(422, `You already have a ${overlap.status} ${overlap.typeName} request from ${overlap.start} to ${overlap.end}`);
  }

  // Balance check (quota for the leave year of the start date)
  if (!type.unlimited) {
    const year = Number(start.slice(0, 4));
    const balances = await balancesFor(employeeId, year);
    const bal = balances.find((b) => String(b.typeId) === String(type._id));
    const remaining = bal ? bal.remaining : type.annualQuota;
    if (days.length > remaining) {
      throw httpError(422, `Not enough balance: ${type.name} has ${remaining} day(s) left, you requested ${days.length}`);
    }
  }

  const created = await LeaveRequest.create({
    employeeId,
    leaveType: type._id,
    typeName: type.name,
    paid: type.paid,
    start,
    end,
    days: days.length,
    reason: reason.trim(),
  });
  return created;
}

// Paid/unpaid approved working-day counts inside a month range (for payroll).
async function approvedLeaveDaysInRange(employeeId, startStr, endStr) {
  const settings = await getSettings();
  const holidaySet = await holidaySetForRange(startStr, endStr);
  const leaves = await LeaveRequest.find({
    employeeId,
    status: 'approved',
    start: { $lte: endStr },
    end: { $gte: startStr },
  }).lean();
  let paid = 0;
  let unpaid = 0;
  leaves.forEach((l) => {
    const from = l.start > startStr ? l.start : startStr;
    const to = l.end < endStr ? l.end : endStr;
    const days = workingDaysBetween(from, to, settings.weekendDays, holidaySet).length;
    if (l.paid) paid += days;
    else unpaid += days;
  });
  return { paid, unpaid };
}

module.exports = { applyLeave, balancesFor, approvedLeaveDaysInRange };
