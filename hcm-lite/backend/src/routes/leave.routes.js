// Leave: apply, cancel, balances, history; HR approval inbox with comments.
const router = require('express').Router();
const LeaveRequest = require('../models/LeaveRequest');
const LeaveType = require('../models/LeaveType');
const Employee = require('../models/Employee');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncHandler, httpError } = require('../middleware/errors');
const leaveService = require('../services/leaveService');
const { auditService, notificationService } = require('../services');

const isHRorAdmin = requireRole('hr', 'admin');

function requireEmployeeProfile(req, res, next) {
  if (!req.user.employeeId) return next(httpError(400, 'Your account has no employee profile'));
  return next();
}

router.get(
  '/types',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await LeaveType.find().sort({ name: 1 }).lean());
  })
);

// Own balances (quota / used / remaining per type).
router.get(
  '/balance',
  requireAuth,
  requireEmployeeProfile,
  asyncHandler(async (req, res) => {
    const year = req.query.year ? Number(req.query.year) : new Date().getFullYear();
    res.json(await leaveService.balancesFor(req.user.employeeId, year));
  })
);

// Apply: working days only, overlap and over-balance rejected with 422.
router.post(
  '/',
  requireAuth,
  requireEmployeeProfile,
  asyncHandler(async (req, res) => {
    const created = await leaveService.applyLeave(req.user.employeeId, req.body);
    auditService.log(req.user, 'leave.apply', 'LeaveRequest', created._id, null, {
      type: created.typeName, start: created.start, end: created.end, days: created.days,
    });
    res.status(201).json(created);
  })
);

// All leaves (HR/Admin) or own history (employee).
router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const filter = {};
    if (req.user.role === 'employee') filter.employeeId = req.user.employeeId;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.type) filter.typeName = req.query.type;
    if (req.query.employee) filter.employeeId = req.query.employee;
    const items = await LeaveRequest.find(filter)
      .sort({ createdAt: -1 })
      .limit(200)
      .populate('employeeId', 'name code department')
      .lean();
    res.json(items);
  })
);

router.get(
  '/pending',
  requireAuth,
  isHRorAdmin,
  asyncHandler(async (req, res) => {
    const items = await LeaveRequest.find({ status: 'pending' })
      .sort({ createdAt: 1 })
      .populate('employeeId', 'name code department')
      .lean();
    res.json(items);
  })
);

// Cancel own pending request.
router.post(
  '/:id/cancel',
  requireAuth,
  requireEmployeeProfile,
  asyncHandler(async (req, res) => {
    const leave = await LeaveRequest.findById(req.params.id);
    if (!leave) throw httpError(404, 'Leave request not found');
    if (String(leave.employeeId) !== String(req.user.employeeId)) {
      throw httpError(403, 'You can only cancel your own requests');
    }
    if (leave.status !== 'pending') throw httpError(409, 'Only pending requests can be cancelled');
    leave.status = 'cancelled';
    await leave.save();
    auditService.log(req.user, 'leave.cancel', 'LeaveRequest', leave._id, null, { start: leave.start, end: leave.end });
    res.json(leave);
  })
);

// HR/Admin approves or rejects with a comment.
router.patch(
  '/:id/decision',
  requireAuth,
  requireRole('hr', 'admin'),
  asyncHandler(async (req, res) => {
    const { action, comment } = req.body;
    if (!['approve', 'reject'].includes(action)) throw httpError(422, 'action must be approve or reject');
    const leave = await LeaveRequest.findById(req.params.id).populate('employeeId', 'name userId');
    if (!leave) throw httpError(404, 'Leave request not found');
    if (leave.status !== 'pending') throw httpError(409, 'This request was already decided');

    // Re-check balance at approval time (balancesFor counts only approved days,
    // and this request is still pending, so add its days on top).
    if (action === 'approve') {
      const type = await LeaveType.findById(leave.leaveType);
      if (type && !type.unlimited) {
        const year = Number(leave.start.slice(0, 4));
        const balances = await leaveService.balancesFor(leave.employeeId._id, year);
        const bal = balances.find((b) => String(b.typeId) === String(type._id));
        const used = bal ? bal.used : 0;
        if (used + leave.days > type.annualQuota) {
          throw httpError(422, `Balance exceeded for ${type.name}: quota ${type.annualQuota}, already used ${used}, this request needs ${leave.days}`);
        }
      }
    }

    const before = { status: leave.status };
    leave.status = action === 'approve' ? 'approved' : 'rejected';
    leave.decidedBy = req.user.id;
    leave.decidedAt = new Date();
    leave.comment = comment || '';
    await leave.save();

    auditService.log(req.user, `leave.${action}`, 'LeaveRequest', leave._id, before, {
      employee: leave.employeeId ? leave.employeeId.name : '', comment: comment || '',
    });
    if (leave.employeeId && leave.employeeId.userId) {
      notificationService.notify(
        leave.employeeId.userId,
        `Leave ${leave.status}`,
        `Your ${leave.typeName} leave (${leave.start} to ${leave.end}) was ${leave.status}${comment ? `: ${comment}` : ''}.`
      );
    }
    res.json(leave);
  })
);

module.exports = router;
