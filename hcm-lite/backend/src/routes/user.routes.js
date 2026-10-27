// Admin manages logins: create HR accounts, deactivate/reactivate, reset passwords.
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Employee = require('../models/Employee');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncHandler, httpError } = require('../middleware/errors');
const { auditService, notificationService } = require('../services');

function randomTempPassword() {
  return `Hcm@${Math.random().toString(36).slice(2, 8)}1`;
}

router.get(
  '/',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const users = await User.find()
      .select('-passwordHash')
      .populate('employeeId', 'code name status')
      .sort({ createdAt: -1 })
      .lean();
    res.json(users);
  })
);

// Create an HR login (optionally with an employee profile so HR can also
// check in and apply for leave, per the functionality checklist).
router.post(
  '/',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { name, email, password, createProfile, department, designation, joinDate } = req.body;
    if (!name || !email || !password) throw httpError(422, 'Name, email and password are required');
    if (String(password).length < 6) throw httpError(422, 'Password must be at least 6 characters');
    const dup = await User.findOne({ email: String(email).toLowerCase().trim() });
    if (dup) throw httpError(409, 'A user with this email already exists');

    let employeeId = null;
    if (createProfile !== false) {
      const count = await Employee.countDocuments();
      const code = `HR-${String(count + 1).padStart(3, '0')}`;
      const emp = await Employee.create({
        code,
        name,
        email: String(email).toLowerCase().trim(),
        department: department || null,
        designation: designation || null,
        joinDate: joinDate || new Date().toISOString().slice(0, 10),
        basicSalary: 0,
        status: 'active',
      });
      employeeId = emp._id;
    }

    const user = await User.create({
      name,
      email: String(email).toLowerCase().trim(),
      passwordHash: await bcrypt.hash(password, 10),
      role: 'hr',
      employeeId,
      mustChangePassword: true,
    });
    if (employeeId) {
      await Employee.updateOne({ _id: employeeId }, { userId: user._id });
    }
    auditService.log(req.user, 'user.create', 'User', user._id, null, { name, email, role: 'hr' });
    notificationService.notify(user._id, 'Welcome to HCM Lite', 'Your HR account has been created. Please change your temporary password.');
    res.status(201).json({ user: { id: user._id, name, email: user.email, role: user.role, mustChangePassword: true } });
  })
);

// Reset a login: gives a fresh temporary password that must be changed on next sign-in.
router.post(
  '/:id/reset-password',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user) throw httpError(404, 'User not found');
    const temp = randomTempPassword();
    user.passwordHash = await bcrypt.hash(temp, 10);
    user.mustChangePassword = true;
    await user.save();
    auditService.log(req.user, 'user.resetPassword', 'User', user._id, null, { email: user.email });
    notificationService.notify(user._id, 'Password reset', 'An administrator reset your password. Please sign in with the temporary password and change it.');
    res.json({ message: 'Password reset', temporaryPassword: temp });
  })
);

router.patch(
  '/:id/status',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { active } = req.body;
    if (typeof active !== 'boolean') throw httpError(422, 'active must be true or false');
    if (String(req.params.id) === String(req.user.id)) throw httpError(422, 'You cannot deactivate your own account');
    const user = await User.findById(req.params.id);
    if (!user) throw httpError(404, 'User not found');
    const before = { active: user.active };
    user.active = active;
    await user.save();
    auditService.log(req.user, active ? 'user.activate' : 'user.deactivate', 'User', user._id, before, { active });
    res.json({ message: active ? 'Account activated' : 'Account deactivated' });
  })
);

module.exports = router;
