// Employees: HR registers employees (creating their login), edits details;
// Admin views all; employees see/edit only their own profile (phone & address).
// Includes Employee 360, CSV import (dry-run) and CSV export.
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const Employee = require('../models/Employee');
const User = require('../models/User');
const Department = require('../models/Department');
const Designation = require('../models/Designation');
const Attendance = require('../models/Attendance');
const LeaveRequest = require('../models/LeaveRequest');
const Payslip = require('../models/Payslip');
const PayrollRun = require('../models/PayrollRun');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncHandler, httpError } = require('../middleware/errors');
const { auditService, notificationService } = require('../services');
const { balancesFor } = require('../services/leaveService');
const { isValidDateStr, todayStr } = require('../utils/dates');

const isHRorAdmin = requireRole('hr', 'admin');

async function nextCode() {
  const count = await Employee.countDocuments();
  return `EMP-${String(count + 1).padStart(4, '0')}`;
}

// Directory with server-side search, filters and paging.
router.get(
  '/',
  requireAuth,
  isHRorAdmin,
  asyncHandler(async (req, res) => {
    const { search = '', department = '', status = '', page = 1, limit = 10, sort = 'createdAt' } = req.query;
    const filter = {};
    if (search) {
      const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: rx }, { code: rx }, { email: rx }];
    }
    if (department) filter.department = department;
    if (status) filter.status = status;

    const sortMap = { createdAt: '-createdAt', name: 'name', code: 'code', salary: '-basicSalary' };
    const total = await Employee.countDocuments(filter);
    const items = await Employee.find(filter)
      .populate('department', 'name')
      .populate('designation', 'name')
      .sort(sortMap[sort] || '-createdAt')
      .skip((Math.max(1, +page) - 1) * Math.min(50, Math.max(1, +limit)))
      .limit(Math.min(50, Math.max(1, +limit)))
      .lean();
    res.json({ total, page: +page, items });
  })
);

// Employee 360: profile + attendance + leave + payslips (scoped by role).
router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.user.employeeId) throw httpError(400, 'Your account has no employee profile');
    const emp = await Employee.findById(req.user.employeeId)
      .populate('department', 'name').populate('designation', 'name').lean();
    if (!emp) throw httpError(404, 'Employee profile not found');
    delete emp.__v;
    res.json(emp);
  })
);

router.patch(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    // Employees may edit only their phone and address.
    const emp = await Employee.findById(req.user.employeeId);
    if (!emp) throw httpError(404, 'Employee profile not found');
    const before = { phone: emp.phone, address: emp.address };
    if (req.body.phone !== undefined) emp.phone = String(req.body.phone).trim();
    if (req.body.address !== undefined) emp.address = String(req.body.address).trim();
    await emp.save();
    auditService.log(req.user, 'employee.selfUpdate', 'Employee', emp._id, before, { phone: emp.phone, address: emp.address });
    res.json(emp);
  })
);

router.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.user.role === 'employee') {
      if (String(req.user.employeeId) !== String(req.params.id)) {
        throw httpError(403, 'You can only view your own profile');
      }
    }
    const emp = await Employee.findById(req.params.id)
      .populate('department', 'name').populate('designation', 'name').lean();
    if (!emp) throw httpError(404, 'Employee not found');

    const [attendance, leaves, payslips] = await Promise.all([
      Attendance.find({ employeeId: emp._id }).sort({ date: -1 }).limit(31).lean(),
      LeaveRequest.find({ employeeId: emp._id }).sort({ createdAt: -1 }).limit(20).lean(),
      Payslip.find({ employeeId: emp._id }).sort({ createdAt: -1 }).limit(12).lean(),
    ]);
    const balances = await balancesFor(emp._id);

    const includeSalary = req.user.role === 'admin' || req.user.role === 'hr';
    const profile = { ...emp };
    if (!includeSalary) delete profile.basicSalary;

    res.json({
      employee: profile,
      attendance,
      leaves,
      payslips: includeSalary ? payslips : payslips.map((p) => ({ _id: p._id, net: p.net, createdAt: p.createdAt, runId: p.runId })),
      balances,
    });
  })
);

// HR registers an employee; this creates their login with a temporary password.
router.post(
  '/',
  requireAuth,
  requireRole('hr', 'admin'),
  asyncHandler(async (req, res) => {
    const { name, email, phone, address, gender, dob, department, designation, joinDate, basicSalary, status } = req.body;
    if (!name || !email) throw httpError(422, 'Name and email are required');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email))) throw httpError(422, 'Invalid email');
    if (joinDate && !isValidDateStr(String(joinDate))) throw httpError(422, 'joinDate must be YYYY-MM-DD');
    if (basicSalary !== undefined && Number(basicSalary) < 0) throw httpError(422, 'Salary cannot be negative');

    const emailNorm = String(email).toLowerCase().trim();
    if (await Employee.findOne({ email: emailNorm })) throw httpError(409, 'An employee with this email already exists');
    if (await Employee.findOne({ code: String(req.body.code || '').toUpperCase().trim() || 'NOPE' })) {
      throw httpError(409, 'This employee code is already in use');
    }

    let dept = null;
    if (department) {
      dept = await Department.findById(department);
      if (!dept) throw httpError(422, 'Unknown department');
    }
    let desig = null;
    if (designation) {
      desig = await Designation.findById(designation);
      if (!desig) throw httpError(422, 'Unknown designation');
    }

    const tempPassword = `Hcm@${Math.random().toString(36).slice(2, 8)}1`;
    const code = (req.body.code && req.body.code.trim()) || (await nextCode());

    const emp = await Employee.create({
      code,
      name: name.trim(),
      email: emailNorm,
      phone: phone || '',
      address: address || '',
      gender: gender || 'male',
      dob: dob || '',
      department: dept ? dept._id : null,
      designation: desig ? desig._id : null,
      joinDate: joinDate || todayStr(),
      basicSalary: Number(basicSalary) || 0,
      status: status === 'probation' ? 'probation' : 'active',
    });

    const user = await User.create({
      name: name.trim(),
      email: emailNorm,
      passwordHash: await bcrypt.hash(tempPassword, 10),
      role: 'employee',
      employeeId: emp._id,
      mustChangePassword: true,
    });
    emp.userId = user._id;
    await emp.save();

    auditService.log(req.user, 'employee.create', 'Employee', emp._id, null, { code: emp.code, name: emp.name, email: emp.email, basicSalary: emp.basicSalary, department: dept ? dept.name : '' });
    notificationService.notify(user._id, 'Welcome to HCM Lite', `Your employee account has been created. Sign in with your email and the temporary password, then change it.`);

    res.status(201).json({ employee: emp, login: { email: emailNorm, temporaryPassword: tempPassword } });
  })
);

// HR/Admin edits an employee (job details, salary, status/exit).
router.put(
  '/:id',
  requireAuth,
  isHRorAdmin,
  asyncHandler(async (req, res) => {
    const emp = await Employee.findById(req.params.id);
    if (!emp) throw httpError(404, 'Employee not found');
    const before = emp.toJSON();

    const fields = ['name', 'phone', 'address', 'gender', 'dob', 'department', 'designation', 'joinDate', 'basicSalary', 'status', 'exitDate'];
    fields.forEach((f) => {
      if (req.body[f] !== undefined) emp[f] = req.body[f];
    });
    if (emp.status === 'exited' && !emp.exitDate) emp.exitDate = todayStr();
    if (emp.status !== 'exited') emp.exitDate = null;
    await emp.save();

    // Keep the login in sync with employment status
    if (emp.userId) {
      await User.updateOne({ _id: emp.userId }, { active: emp.status !== 'exited' });
    }

    auditService.log(req.user, 'employee.update', 'Employee', emp._id, before, emp.toJSON());
    res.json(emp);
  })
);

// ---------- CSV import (dry-run first) and export ----------

function parseCsv(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((line, i) => {
    const cols = line.split(',').map((c) => c.trim());
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = cols[idx] !== undefined ? cols[idx] : '';
    });
    row.__row = i + 2; // 1-based line number in the file (header = line 1)
    return row;
  });
}

const REQUIRED = ['code', 'name', 'email', 'department', 'joindate', 'basicsalary'];

async function validateRows(rows) {
  const [departments, employees, users] = await Promise.all([
    Department.find().lean(),
    Employee.find().select('code email').lean(),
    User.find().select('email').lean(),
  ]);
  const deptByName = new Map(departments.map((d) => [d.name.toLowerCase(), d._id]));
  const codes = new Set(employees.map((e) => e.code));
  const emails = new Set([...employees.map((e) => e.email), ...users.map((u) => u.email)]);

  const results = [];
  for (const row of rows) {
    const errors = [];
    REQUIRED.forEach((f) => {
      if (!row[f]) errors.push({ field: f, reason: 'required field is missing' });
    });
    if (row.email) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(row.email)) errors.push({ field: 'email', reason: 'invalid email format' });
      else if (emails.has(row.email.toLowerCase())) errors.push({ field: 'email', reason: 'email already exists' });
    }
    if (row.code) {
      if (codes.has(row.code.toUpperCase())) errors.push({ field: 'code', reason: 'employee code already exists' });
    }
    if (row.department && !deptByName.has(row.department.toLowerCase())) {
      errors.push({ field: 'department', reason: `unknown department "${row.department}"` });
    }
    if (row.joindate && !isValidDateStr(row.joindate)) {
      errors.push({ field: 'joinDate', reason: 'date must be ISO YYYY-MM-DD' });
    }
    if (row.basicsalary && (Number.isNaN(Number(row.basicsalary)) || Number(row.basicsalary) <= 0)) {
      errors.push({ field: 'basicSalary', reason: 'salary must be a number greater than 0' });
    }
    results.push({ row: row.__row, data: { code: row.code, name: row.name, email: row.email }, valid: errors.length === 0, errors });
  }
  return { results, deptByName };
}

// Dry run: returns a row + field + reason error report, changes nothing.
router.post(
  '/import/preview',
  requireAuth,
  requireRole('hr', 'admin'),
  asyncHandler(async (req, res) => {
    const rows = parseCsv(req.body.csv || '');
    if (!rows.length) throw httpError(422, 'CSV is empty or has no data rows');
    const { results } = await validateRows(rows);
    res.json({ total: results.length, valid: results.filter((r) => r.valid).length, invalid: results.filter((r) => !r.valid).length, results });
  })
);

router.post(
  '/import',
  requireAuth,
  requireRole('hr', 'admin'),
  asyncHandler(async (req, res) => {
    const rows = parseCsv(req.body.csv || '');
    if (!rows.length) throw httpError(422, 'CSV is empty or has no data rows');
    const { results, deptByName } = await validateRows(rows);
    const created = [];
    const logins = [];
    for (const r of results.filter((x) => x.valid)) {
      const row = rows.find((x) => x.__row === r.row);
      const emailNorm = row.email.toLowerCase();
      const tempPassword = `Hcm@${Math.random().toString(36).slice(2, 8)}1`;
      // eslint-disable-next-line no-await-in-loop
      const emp = await Employee.create({
        code: row.code.toUpperCase(),
        name: row.name,
        email: emailNorm,
        phone: row.phone || '',
        department: deptByName.get(row.department.toLowerCase()) || null,
        joinDate: row.joindate,
        basicSalary: Number(row.basicsalary) || 0,
        status: 'active',
      });
      // eslint-disable-next-line no-await-in-loop
      const user = await User.create({
        name: row.name,
        email: emailNorm,
        passwordHash: await bcrypt.hash(tempPassword, 10),
        role: 'employee',
        employeeId: emp._id,
        mustChangePassword: true,
      });
      // eslint-disable-next-line no-await-in-loop
      await Employee.updateOne({ _id: emp._id }, { userId: user._id });
      created.push(emp.code);
      logins.push({ code: emp.code, email: emailNorm, temporaryPassword: tempPassword });
      auditService.log(req.user, 'employee.import', 'Employee', emp._id, null, { code: emp.code, name: emp.name });
    }
    res.status(201).json({
      imported: created.length,
      skipped: results.filter((x) => !x.valid).length,
      errors: results.filter((x) => !x.valid),
      logins,
    });
  })
);

router.get(
  '/export/csv',
  requireAuth,
  requireRole('hr', 'admin'),
  asyncHandler(async (req, res) => {
    const employees = await Employee.find().populate('department', 'name').populate('designation', 'name').lean();
    const header = 'code,name,email,phone,department,designation,joinDate,basicSalary,status';
    const lines = employees.map((e) =>
      [
        e.code, e.name, e.email, e.phone || '',
        e.department ? e.department.name : '',
        e.designation ? e.designation.name : '',
        e.joinDate, e.basicSalary, e.status,
      ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="employees.csv"');
    res.send([header, ...lines].join('\n'));
  })
);

module.exports = router;
