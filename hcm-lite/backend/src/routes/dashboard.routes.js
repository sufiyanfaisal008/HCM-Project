// Dashboards: all numbers are computed on the server (aggregations over real data),
// filterable by date range and department.
const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, httpError } = require('../middleware/errors');
const dashboardService = require('../services/dashboardService');

const scopeByRole = {
  admin: dashboardService.adminDashboard,
  hr: dashboardService.hrDashboard,
};

router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { from, to, department } = req.query;
    if (req.user.role === 'employee') {
      if (!req.user.employeeId) throw httpError(400, 'Your account has no employee profile');
      return res.json(await dashboardService.employeeDashboard(req.user.employeeId));
    }
    const handler = scopeByRole[req.user.role];
    if (!handler) throw httpError(403, 'No dashboard for this role');
    res.json(await handler({ from, to, department: department || null }));
  })
);

module.exports = router;
