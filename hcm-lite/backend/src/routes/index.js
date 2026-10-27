const router = require('express').Router();

router.use('/setup', require('./setup.routes'));
router.use('/auth', require('./auth.routes'));
router.use('/settings', require('./settings.routes'));
router.use('/org', require('./org.routes'));
router.use('/users', require('./user.routes'));
router.use('/employees', require('./employee.routes'));
router.use('/attendance', require('./attendance.routes'));
router.use('/leaves', require('./leave.routes'));
router.use('/payroll', require('./payroll.routes'));
router.use('/dashboards', require('./dashboard.routes'));
router.use('/ai', require('./ai.routes'));
router.use('/comms', require('./comms.routes'));

module.exports = router;
