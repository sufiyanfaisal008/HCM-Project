// Comms: announcements (Admin/HR post, everyone reads) and personal notifications.
const router = require('express').Router();
const Announcement = require('../models/Announcement');
const Notification = require('../models/Notification');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncHandler, httpError } = require('../middleware/errors');
const { auditService } = require('../services');

router.get(
  '/announcements',
  requireAuth,
  asyncHandler(async (req, res) => {
    const items = await Announcement.find().sort({ createdAt: -1 }).limit(50).lean();
    res.json(items);
  })
);

router.post(
  '/announcements',
  requireAuth,
  requireRole('admin', 'hr'),
  asyncHandler(async (req, res) => {
    const { title, body } = req.body;
    if (!title || !body) throw httpError(422, 'Title and body are required');
    const doc = await Announcement.create({
      title: title.trim(),
      body: body.trim(),
      postedBy: req.user.id,
      postedByName: req.user.name,
    });
    auditService.log(req.user, 'announcement.post', 'Announcement', doc._id, null, { title: doc.title });
    res.status(201).json(doc);
  })
);

router.get(
  '/notifications',
  requireAuth,
  asyncHandler(async (req, res) => {
    const items = await Notification.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(30).lean();
    const unread = items.filter((n) => !n.read).length;
    res.json({ unread, items });
  })
);

router.post(
  '/notifications/read-all',
  requireAuth,
  asyncHandler(async (req, res) => {
    await Notification.updateMany({ userId: req.user.id, read: false }, { read: true });
    res.json({ message: 'All notifications marked as read' });
  })
);

// Audit log: Admin only, read-only, filterable.
const AuditLog = require('../models/AuditLog');
router.get(
  '/audit',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { entity, action, page = 1, limit = 25 } = req.query;
    const filter = {};
    if (entity) filter.entity = entity;
    if (action) filter.action = action;
    const total = await AuditLog.countDocuments(filter);
    const items = await AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .skip((Math.max(1, +page) - 1) * Math.min(100, Math.max(1, +limit)))
      .limit(Math.min(100, Math.max(1, +limit)))
      .lean();
    res.json({ total, page: +page, items });
  })
);

module.exports = router;
