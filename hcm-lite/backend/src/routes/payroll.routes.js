// Payroll Lite: HR builds/reviews the monthly draft, Admin finalizes (locks),
// payslips with PDF download. Finalized runs can never be edited.
const router = require('express').Router();
const PayrollRun = require('../models/PayrollRun');
const Payslip = require('../models/Payslip');
const Employee = require('../models/Employee');
const User = require('../models/User');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncHandler, httpError } = require('../middleware/errors');
const payrollService = require('../services/payrollService');
const { auditService, notificationService } = require('../services');
const { monthLabel } = require('../utils/dates');

const isHRorAdmin = requireRole('hr', 'admin');

router.get(
  '/runs',
  requireAuth,
  isHRorAdmin,
  asyncHandler(async (req, res) => {
    const runs = await PayrollRun.find()
      .sort({ year: -1, month: -1 })
      .populate('createdBy', 'name')
      .populate('finalizedBy', 'name')
      .lean();
    res.json(runs);
  })
);

// HR creates (or recalculates) the draft for a month.
router.post(
  '/runs',
  requireAuth,
  requireRole('hr', 'admin'),
  asyncHandler(async (req, res) => {
    const year = Number(req.body.year);
    const month = Number(req.body.month);
    if (!year || !month || month < 1 || month > 12) throw httpError(422, 'year and month (1-12) are required');
    const { run } = await payrollService.buildRun(year, month, req.user);
    auditService.log(req.user, 'payroll.createDraft', 'PayrollRun', run._id, null, {
      year, month, employees: run.totals.employees, net: run.totals.net,
    });
    res.status(201).json(run);
  })
);

router.get(
  '/runs/:id',
  requireAuth,
  isHRorAdmin,
  asyncHandler(async (req, res) => {
    const run = await PayrollRun.findById(req.params.id).populate('createdBy', 'name').populate('finalizedBy', 'name').lean();
    if (!run) throw httpError(404, 'Payroll run not found');
    const payslips = await Payslip.find({ runId: run._id }).sort({ employeeCode: 1 }).lean();
    res.json({ run, payslips });
  })
);

// Only Admin can finalize; finalized runs are locked forever.
router.patch(
  '/runs/:id/finalize',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const run = await PayrollRun.findById(req.params.id);
    if (!run) throw httpError(404, 'Payroll run not found');
    if (run.status === 'finalized') throw httpError(409, 'This payroll run is already finalized');

    const before = { status: run.status };
    run.status = 'finalized';
    run.finalizedBy = req.user.id;
    run.finalizedAt = new Date();
    await run.save();

    const slips = await Payslip.find({ runId: run._id }).select('employeeId').lean();
    const emps = await Employee.find({ _id: { $in: slips.map((s) => s.employeeId) } }).select('userId').lean();
    await notificationService.notifyMany(
      emps.filter((e) => e.userId).map((e) => e.userId),
      'Payslip ready',
      `Your payslip for ${monthLabel(run.year, run.month)} is available for download.`
    );

    auditService.log(req.user, 'payroll.finalize', 'PayrollRun', run._id, before, {
      year: run.year, month: run.month, net: run.totals.net,
    });
    res.json(run);
  })
);

// Employee: own payslips (finalized runs only).
router.get(
  '/payslips/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.user.employeeId) throw httpError(400, 'Your account has no employee profile');
    const runs = await PayrollRun.find({ status: 'finalized' }).select('_id year month').lean();
    const runIds = runs.map((r) => r._id);
    const slips = await Payslip.find({ runId: { $in: runIds }, employeeId: req.user.employeeId })
      .sort({ createdAt: -1 })
      .lean();
    const runById = new Map(runs.map((r) => [String(r._id), r]));
    res.json(slips.map((s) => ({ ...s, runLabel: monthLabel(runById.get(String(s.runId)).year, runById.get(String(s.runId)).month) })));
  })
);

router.get(
  '/payslips/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const slip = await Payslip.findById(req.params.id).lean();
    if (!slip) throw httpError(404, 'Payslip not found');
    const run = await PayrollRun.findById(slip.runId).lean();
    if (req.user.role === 'employee') {
      if (String(slip.employeeId) !== String(req.user.employeeId)) throw httpError(403, 'You can only view your own payslips');
      if (run.status !== 'finalized') throw httpError(403, 'Payslips are available after the payroll is finalized');
    }
    res.json({ ...slip, runStatus: run.status, runLabel: monthLabel(run.year, run.month) });
  })
);

// Payslip PDF (pdfkit).
router.get(
  '/payslips/:id/pdf',
  requireAuth,
  asyncHandler(async (req, res) => {
    const slip = await Payslip.findById(req.params.id).lean();
    if (!slip) throw httpError(404, 'Payslip not found');
    const run = await PayrollRun.findById(slip.runId).lean();
    if (req.user.role === 'employee') {
      if (String(slip.employeeId) !== String(req.user.employeeId)) throw httpError(403, 'You can only download your own payslips');
      if (run.status !== 'finalized') throw httpError(403, 'Payslips are available after the payroll is finalized');
    }
    const { getSettings } = require('../services/settingsService');
    const settings = await getSettings();
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ size: 'A4', margin: 48 });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="payslip-${slip.employeeCode}-${run.year}-${run.month}.pdf"`);
    doc.pipe(res);

    const currency = settings ? settings.currency : 'PKR';
    const money = (n) => `${currency} ${Number(n).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    doc.fontSize(20).fillColor('#1e293b').text(settings ? settings.companyName : 'Company', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor('#64748b').text(`Payslip — ${monthLabel(run.year, run.month)}`, { align: 'center' });
    doc.moveDown(1);

    doc.fillColor('#0f172a').fontSize(11)
      .text(`Employee: ${slip.employeeName}  (${slip.employeeCode})`)
      .text(`Department: ${slip.departmentName || '—'}   Designation: ${slip.designationName || '—'}`)
      .text(`Status: ${run.status === 'finalized' ? 'Finalized' : 'Draft'}`)
      .moveDown(1);

    const row = (label, value, bold = false) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10)
        .fillColor(bold ? '#0f172a' : '#334155')
        .text(label, 60, doc.y, { continued: true, width: 340 })
        .text(value, { align: 'right', width: 180 });
    };

    doc.rect(48, doc.y, 498, 0.8).fill('#e2e8f0');
    doc.moveDown(0.6);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#1e293b').text('Earnings');
    doc.moveDown(0.3);
    row('Basic salary', money(slip.basic));
    row('House rent allowance (40%)', money(slip.hra));
    row('Medical allowance (10%)', money(slip.medical));
    row('Gross salary', money(slip.gross), true);
    doc.moveDown(0.8);

    doc.font('Helvetica-Bold').fontSize(11).fillColor('#1e293b').text('Attendance basis');
    doc.moveDown(0.3);
    row('Working days in month', String(slip.workingDays));
    row('Payable days (prorated)', `${slip.expectedDays}${slip.prorated ? ' (prorated)' : ''}`);
    row('Absent days', String(slip.absentDays));
    row('Unpaid leave days', String(slip.unpaidDays));
    row('Half days', String(slip.halfDays));
    doc.moveDown(0.8);

    doc.font('Helvetica-Bold').fontSize(11).fillColor('#1e293b').text('Deductions');
    doc.moveDown(0.3);
    row(`Absent deduction (${slip.absentDays} x ${money(slip.perDayRate)})`, money(slip.absentDeduction));
    row(`Unpaid leave deduction`, money(slip.unpaidDeduction));
    row(`Half-day deduction (0.5 x ${slip.halfDays})`, money(slip.halfDayDeduction));
    row('Tax (monthly, illustrative slab)', money(slip.tax));
    doc.moveDown(0.8);

    doc.rect(48, doc.y, 498, 26).fill('#f1f5f9');
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#0f172a')
      .text('Net pay', 60, doc.y + 8, { continued: true, width: 340 })
      .text(money(slip.net), { align: 'right', width: 180 });
    doc.moveDown(2);

    if (slip.note) doc.fontSize(9).fillColor('#64748b').text(slip.note);
    doc.fontSize(8).fillColor('#94a3b8')
      .text('This payslip is system generated by HCM Lite. Tax figures are illustrative.', 48, 780, { lineGap: 2 });

    doc.end();
  })
);

module.exports = router;
