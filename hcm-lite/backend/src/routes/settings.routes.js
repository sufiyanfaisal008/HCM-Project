const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errors');
const { getSettings, updateSettings } = require('../services/settingsService');
const { auditService } = require('../services');

router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await getSettings());
  })
);

// Admin manages company settings; HR and employees can only view.
router.put(
  '/',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const before = await getSettings();
    const updated = await updateSettings(req.body);
    auditService.log(req.user, 'settings.update', 'Setting', updated._id,
      { companyName: before.companyName, officeStart: before.officeStart, graceMinutes: before.graceMinutes, weekendDays: before.weekendDays, officeLocation: before.officeLocation },
      { companyName: updated.companyName, officeStart: updated.officeStart, graceMinutes: updated.graceMinutes, weekendDays: updated.weekendDays, officeLocation: updated.officeLocation });
    res.json(updated);
  })
);

module.exports = router;
