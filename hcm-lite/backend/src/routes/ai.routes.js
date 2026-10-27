// AI assistant endpoints. The API key stays on the server; the browser only
// talks to these routes. Every call is rate limited and logged.
const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errors');
const aiService = require('../services/aiService');

router.get(
  '/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ configured: aiService.isConfigured() });
  })
);

router.post(
  '/chat',
  requireAuth,
  asyncHandler(async (req, res) => {
    const history = Array.isArray(req.body.messages) ? req.body.messages : [];
    if (!history.length) return res.status(422).json({ message: 'messages array is required' });
    const result = await aiService.chat(req.user, history);
    res.json(result);
  })
);

// Dashboard summary for Admin/HR: KPIs in, 3-5 insight bullets out.
router.post(
  '/summary',
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await aiService.dashboardSummary(req.user, req.body.kpis || {});
    res.json(result);
  })
);

// Smart leave for employees: a sentence in, a pre-filled leave form out.
// The user still confirms and applies through the normal leave endpoint.
router.post(
  '/smart-leave',
  requireAuth,
  asyncHandler(async (req, res) => {
    const text = String(req.body.text || '').trim();
    if (!text) return res.status(422).json({ message: 'text is required' });
    const result = await aiService.smartLeave(req.user, text);
    res.json(result);
  })
);

module.exports = router;
