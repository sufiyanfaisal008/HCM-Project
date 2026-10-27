// Attendance: web/camera check-in and check-out, own calendar, daily board,
// and correction requests (employee requests, HR approves).
const router = require('express').Router();
const Attendance = require('../models/Attendance');
const AttendanceCorrection = require('../models/AttendanceCorrection');
const Employee = require('../models/Employee');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncHandler, httpError } = require('../middleware/errors');
const attendanceService = require('../services/attendanceService');
const { auditService, notificationService } = require('../services');
const { todayStr, isValidDateStr, isValidTimeStr, monthRange } = require('../utils/dates');

const isHRorAdmin = requireRole('hr', 'admin');

function requireEmployeeProfile(req, res, next) {
  if (!req.user.employeeId) return next(httpError(400, 'Your account has no employee profile'));
  return next();
}

// Check in. The server stamps the time; one record per employee per day (409 on repeat).
// Optional lat/lng triggers the geofence check; source "camera" requires location.
router.post(
  '/check-in',
  requireAuth,
  requireEmployeeProfile,
  asyncHandler(async (req, res) => {
    const { lat, lng, source } = req.body || {};
    const rec = await attendanceService.checkIn(req.user.employeeId, {
      lat: lat != null ? Number(lat) : null,
      lng: lng != null ? Number(lng) : null,
      source: source === 'camera' ? 'camera' : 'web',
    });
    res.status(201).json(rec);
  })
);

router.post(
  '/check-out',
  requireAuth,
  requireEmployeeProfile,
  asyncHandler(async (req, res) => {
    const rec = await attendanceService.checkOut(req.user.employeeId);
    res.json(rec);
  })
);

router.get(
  '/today',
  requireAuth,
  requireEmployeeProfile,
  asyncHandler(async (req, res) => {
    const rec = await Attendance.findOne({ employeeId: req.user.employeeId, date: todayStr() }).lean();
    res.json(rec);
  })
);

// Own attendance calendar (month view).
router.get(
  '/me',
  requireAuth,
  requireEmployeeProfile,
  asyncHandler(async (req, res) => {
    const month = req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)
      ? req.query.month
      : todayStr().slice(0, 7);
    const { start, end } = monthRange(Number(month.slice(0, 4)), Number(month.slice(5, 7)));
    const records = await Attendance.find({
      employeeId: req.user.employeeId,
      date: { $gte: start, $lte: end },
    }).sort({ date: 1 }).lean();
    res.json({ month, records });
  })
);

// Daily attendance board for HR/Admin.
router.get(
  '/board',
  requireAuth,
  isHRorAdmin,
  asyncHandler(async (req, res) => {
    const date = req.query.date && isValidDateStr(req.query.date) ? req.query.date : todayStr();
    res.json(await attendanceService.dailyBoard(date));
  })
);

// 14-day trend (used by the HR dashboard chart).
router.get(
  '/trend',
  requireAuth,
  isHRorAdmin,
  asyncHandler(async (req, res) => {
    const days = Math.min(30, Math.max(7, Number(req.query.days) || 14));
    res.json(await attendanceService.trend(days, req.query.department || null));
  })
);

// ---------- Corrections ----------

router.post(
  '/corrections',
  requireAuth,
  requireEmployeeProfile,
  asyncHandler(async (req, res) => {
    const { date, checkIn, checkOut, reason } = req.body;
    if (!isValidDateStr(String(date))) throw httpError(422, 'date must be YYYY-MM-DD');
    if (date >= todayStr()) throw httpError(422, 'Corrections can only be requested for past days');
    if (!isValidTimeStr(String(checkIn))) throw httpError(422, 'checkIn must be HH:mm');
    if (checkOut && !isValidTimeStr(String(checkOut))) throw httpError(422, 'checkOut must be HH:mm');
    if (!reason || !reason.trim()) throw httpError(422, 'A reason is required');

    const dup = await AttendanceCorrection.findOne({ employeeId: req.user.employeeId, date, status: 'pending' });
    if (dup) throw httpError(409, 'You already have a pending correction for this date');

    const rec = await AttendanceCorrection.create({
      employeeId: req.user.employeeId,
      date,
      checkIn,
      checkOut: checkOut || '',
      reason: reason.trim(),
    });
    res.status(201).json(rec);
  })
);

router.get(
  '/corrections',
  requireAuth,
  asyncHandler(async (req, res) => {
    const filter = {};
    if (req.user.role === 'employee') {
      filter.employeeId = req.user.employeeId;
    }
    if (req.query.status) filter.status = req.query.status;
    const items = await AttendanceCorrection.find(filter)
      .sort({ createdAt: -1 })
      .limit(100)
      .populate('employeeId', 'name code')
      .lean();
    res.json(items);
  })
);

// HR approves/rejects a correction; approval rewrites the attendance record.
router.patch(
  '/corrections/:id/decision',
  requireAuth,
  requireRole('hr', 'admin'),
  asyncHandler(async (req, res) => {
    const { action, comment } = req.body;
    if (!['approve', 'reject'].includes(action)) throw httpError(422, 'action must be approve or reject');
    const corr = await AttendanceCorrection.findById(req.params.id).populate('employeeId', 'name code userId');
    if (!corr) throw httpError(404, 'Correction not found');
    if (corr.status !== 'pending') throw httpError(409, 'This correction was already decided');

    corr.status = action === 'approve' ? 'approved' : 'rejected';
    corr.decidedBy = req.user.id;
    corr.decidedAt = new Date();
    corr.comment = comment || '';
    await corr.save();

    if (action === 'approve') {
      const [y, m, d] = corr.date.split('-').map(Number);
      const checkIn = new Date(y, m - 1, d, ...corr.checkIn.split(':').map(Number));
      const checkOut = corr.checkOut
        ? new Date(y, m - 1, d, ...corr.checkOut.split(':').map(Number))
        : null;
      const { getSettings } = require('../services/settingsService');
      const settings = await getSettings();
      const status = checkOut
        ? ((checkOut - checkIn) / 3600000 < settings.halfDayHours ? 'half_day'
          : (checkIn.getHours() * 60 + checkIn.getMinutes() > 9 * 60 + 60 * 0 + settings.graceMinutes + 0 ? 'late' : 'present'))
        : (checkIn.getHours() * 60 + checkIn.getMinutes() > 9 * 60 + settings.graceMinutes ? 'late' : 'present');

      await Attendance.findOneAndUpdate(
        { employeeId: corr.employeeId._id, date: corr.date },
        {
          checkIn,
          checkOut,
          workedMinutes: checkOut ? Math.max(0, Math.round((checkOut - checkIn) / 60000)) : null,
          status,
          source: 'correction',
          corrected: true,
        },
        { upsert: true, new: true }
      );
    }

    auditService.log(req.user, `attendanceCorrection.${action}`, 'AttendanceCorrection', corr._id, null, {
      employee: corr.employeeId ? corr.employeeId.name : '',
      date: corr.date, comment: comment || '',
    });
    if (corr.employeeId && corr.employeeId.userId) {
      notificationService.notify(
        corr.employeeId.userId,
        action === 'approve' ? 'Attendance correction approved' : 'Attendance correction rejected',
        `Your correction for ${corr.date} was ${action}d${comment ? `: ${comment}` : ''}.`
      );
    }
    res.json(corr);
  })
);

module.exports = router;
