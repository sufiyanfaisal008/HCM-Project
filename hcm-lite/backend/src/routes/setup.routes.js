const router = require('express').Router();
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { createSettings, isSetupDone } = require('../services/settingsService');
const { signToken } = require('../middleware/auth');
const { asyncHandler, httpError } = require('../middleware/errors');
const { auditService } = require('../services');

router.get(
  '/status',
  asyncHandler(async (req, res) => {
    res.json({ setupDone: await isSetupDone() });
  })
);

// First-run setup: creates the company profile and the Admin account.
// Open only while no user exists in the database.
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const anyUser = await User.countDocuments();
    if (anyUser > 0) throw httpError(403, 'Setup is already completed');

    const { companyName, name, email, password } = req.body;
    if (!companyName || !name || !email || !password) {
      throw httpError(422, 'Company name, admin name, email and password are required');
    }
    if (String(password).length < 6) throw httpError(422, 'Password must be at least 6 characters');

    const settings = await createSettings({ companyName });
    const admin = await User.create({
      name,
      email: String(email).toLowerCase().trim(),
      passwordHash: await bcrypt.hash(password, 10),
      role: 'admin',
    });
    auditService.log(
      { id: admin._id, name: admin.name, role: 'admin' },
      'setup.company',
      'Setting',
      settings._id,
      null,
      { companyName, officeStart: settings.officeStart, graceMinutes: settings.graceMinutes }
    );
    res.status(201).json({
      message: 'Company setup completed',
      token: signToken(admin),
      user: { id: admin._id, name: admin.name, email: admin.email, role: admin.role, mustChangePassword: false },
    });
  })
);

module.exports = router;
