// Organization setup: departments, designations, leave types and public holidays.
// Admin manages (create/update/delete); HR and employees can read.
const router = require('express').Router();
const Department = require('../models/Department');
const Designation = require('../models/Designation');
const LeaveType = require('../models/LeaveType');
const Holiday = require('../models/Holiday');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncHandler, httpError } = require('../middleware/errors');
const { auditService } = require('../services');
const { isValidDateStr } = require('../utils/dates');

const crud = (Model, entity, extraValidate) => {
  const r = require('express').Router();

  r.get('/', requireAuth, asyncHandler(async (req, res) => {
    res.json(await Model.find().sort({ name: 1 }).lean());
  }));

  r.post('/', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
    const { name } = req.body;
    if (!name || !name.trim()) throw httpError(422, 'Name is required');
    if (extraValidate) extraValidate(req.body);
    const dup = await Model.findOne({ name: name.trim() });
    if (dup) throw httpError(409, `"${name.trim()}" already exists`);
    const doc = await Model.create(req.body);
    auditService.log(req.user, `${entity}.create`, entity, doc._id, null, { name: doc.name });
    res.status(201).json(doc);
  }));

  r.put('/:id', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
    const doc = await Model.findById(req.params.id);
    if (!doc) throw httpError(404, 'Not found');
    const before = doc.toJSON();
    if (extraValidate) extraValidate(req.body);
    ['name', 'annualQuota', 'unlimited', 'paid', 'date'].forEach((k) => {
      if (req.body[k] !== undefined) doc[k] = req.body[k];
    });
    await doc.save();
    auditService.log(req.user, `${entity}.update`, entity, doc._id, before, doc.toJSON());
    res.json(doc);
  }));

  r.delete('/:id', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
    const doc = await Model.findById(req.params.id);
    if (!doc) throw httpError(404, 'Not found');
    const before = doc.toJSON();
    await doc.deleteOne();
    auditService.log(req.user, `${entity}.delete`, entity, doc._id, before, null);
    res.json({ message: 'Deleted' });
  }));

  return r;
};

const leaveTypeValidate = (body) => {
  if (body.annualQuota !== undefined && (Number(body.annualQuota) < 0 || Number.isNaN(Number(body.annualQuota)))) {
    throw httpError(422, 'Quota must be 0 or more');
  }
};

const holidayValidate = (body) => {
  if (!isValidDateStr(String(body.date || ''))) throw httpError(422, 'date must be YYYY-MM-DD');
};

router.use('/departments', crud(Department, 'Department'));
router.use('/designations', crud(Designation, 'Designation'));
router.use('/leave-types', crud(LeaveType, 'LeaveType', leaveTypeValidate));
router.use('/holidays', crud(Holiday, 'Holiday', holidayValidate));

// Default leave types helper for setup (rules from the challenge brief, not data)
router.post(
  '/leave-types/defaults',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const defaults = [
      { name: 'Annual', annualQuota: 14, unlimited: false, paid: true },
      { name: 'Sick', annualQuota: 8, unlimited: false, paid: true },
      { name: 'Casual', annualQuota: 10, unlimited: false, paid: true },
      { name: 'Unpaid', annualQuota: 0, unlimited: true, paid: false },
    ];
    const created = [];
    for (const d of defaults) {
      const exists = await LeaveType.findOne({ name: d.name });
      if (!exists) created.push(await LeaveType.create(d));
    }
    auditService.log(req.user, 'leaveType.createDefaults', 'LeaveType', null, null, { created: created.length });
    res.status(201).json({ created: created.length, types: await LeaveType.find().lean() });
  })
);

module.exports = router;
