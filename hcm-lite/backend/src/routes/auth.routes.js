const router = require('express').Router();
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { signToken, requireAuth } = require('../middleware/auth');
const { asyncHandler, httpError } = require('../middleware/errors');
const { isSetupDone } = require('../services/settingsService');

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    if (!(await isSetupDone())) throw httpError(400, 'Company setup is not completed yet');
    const { email, password } = req.body;
    if (!email || !password) throw httpError(422, 'Email and password are required');
    const user = await User.findOne({ email: String(email).toLowerCase().trim() });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw httpError(401, 'Invalid email or password');
    }
    if (!user.active) throw httpError(403, 'Account is deactivated. Contact your administrator.');
    user.lastLoginAt = new Date();
    await user.save();
    res.json({
      token: signToken(user),
      user: {
        id: user._id, name: user.name, email: user.email, role: user.role,
        employeeId: user.employeeId, mustChangePassword: user.mustChangePassword,
      },
    });
  })
);

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.id).populate('employeeId', 'code name department designation');
    res.json({
      id: user._id, name: user.name, email: user.email, role: user.role,
      employeeId: user.employeeId, mustChangePassword: user.mustChangePassword,
    });
  })
);

router.post(
  '/change-password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) throw httpError(422, 'Current and new password are required');
    if (String(newPassword).length < 6) throw httpError(422, 'New password must be at least 6 characters');
    const user = await User.findById(req.user.id);
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw httpError(401, 'Current password is incorrect');
    }
    user.passwordHash = await bcrypt.hash(newPassword, 10);
    user.mustChangePassword = false;
    await user.save();
    res.json({ message: 'Password changed' });
  })
);

module.exports = router;
