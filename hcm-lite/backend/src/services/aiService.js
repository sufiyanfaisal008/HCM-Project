// AI assistant service.
// Guardrails (challenge brief, section 4):
//  - The AI key lives only in the backend env; the browser never calls the provider.
//  - The model never touches the database: it picks a tool, the backend runs it with
//    the caller's role/data scope, the model writes the answer.
//  - 15 s timeout, ~20 requests per user per hour, every call logged in ai_logs.
const AiLog = require('../models/AiLog');
const Employee = require('../models/Employee');
const Attendance = require('../models/Attendance');
const LeaveRequest = require('../models/LeaveRequest');
const LeaveType = require('../models/LeaveType');
const PayrollRun = require('../models/PayrollRun');
const { getSettings } = require('./settingsService');
const { balancesFor } = require('./leaveService');
const { dailyBoard, trend } = require('./attendanceService');
const { todayStr } = require('../utils/dates');

const AI_KEY = () => process.env.AI_API_KEY || '';
const AI_URL = () => (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const AI_MODEL = () => process.env.AI_MODEL || 'gpt-4o-mini';
const TIMEOUT_MS = 15000;
const HOURLY_LIMIT = 20;

const isConfigured = () => Boolean(AI_KEY());

const FALLBACK_REPLY =
  'The AI assistant is not configured yet. Add AI_API_KEY (and optionally AI_BASE_URL / AI_MODEL) to backend/.env and restart the server.';

async function callLLM({ messages, tools = null, timeoutMs = TIMEOUT_MS }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = { model: AI_MODEL(), messages, temperature: 0.2 };
    if (tools && tools.length) {
      body.tools = tools.map((t) => ({ type: 'function', function: t }));
      body.tool_choice = 'auto';
    }
    const res = await fetch(`${AI_URL()}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_KEY()}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw Object.assign(new Error(`AI provider error (${res.status}): ${text.slice(0, 300)}`), { status: 502 });
    }
    const data = await res.json();
    return data.choices[0].message;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Tools available to the model. Each runs with the caller's scope. ----------

const TOOL_DEFS = [
  {
    name: 'get_headcount',
    description: 'Get the current number of employees (headcount). Optionally filter by department name.',
    parameters: {
      type: 'object',
      properties: { department: { type: 'string', description: 'Department name (optional)' } },
    },
  },
  {
    name: 'get_attendance_summary',
    description: 'Attendance summary for a date (default today) or the last N days: counts by status and attendance rate.',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD, defaults to today' },
        days: { type: 'number', description: 'If given, summarize trend for the last N days instead' },
      },
    },
  },
  {
    name: 'get_late_comers',
    description: 'Employees who came late most often in a month (default current month), with late counts.',
    parameters: {
      type: 'object',
      properties: { month: { type: 'string', description: 'YYYY-MM, defaults to current month' } },
    },
  },
  {
    name: 'get_leave_summary',
    description: 'Leave summary: approved days by type this year, pending request count, and who is on leave today.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_my_leave_balance',
    description: "The current user's own leave balances (quota, used, remaining per leave type) for a year.",
    parameters: {
      type: 'object',
      properties: { year: { type: 'number', description: 'Defaults to the current year' } },
    },
  },
  {
    name: 'get_payroll_summary',
    description: 'Payroll totals (gross, deductions, tax, net) for a month. Admin and HR only.',
    parameters: {
      type: 'object',
      properties: {
        year: { type: 'number', description: 'Defaults to current year' },
        month: { type: 'number', description: '1-12, defaults to last finished month' },
      },
    },
  },
  {
    name: 'search_employees',
    description: 'Search employees by name, code or department. Returns directory data only. Admin and HR only.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name or employee code fragment' },
        department: { type: 'string', description: 'Department name filter' },
      },
    },
  },
];

async function runTool(user, name, args) {
  const settings = await getSettings();
  const isAdmin = user.role === 'admin';
  const isHRorAdmin = user.role === 'hr' || isAdmin;

  const Department = require('../models/Department');
  const deptIdByName = async (name) => {
    if (!name) return null;
    const d = await Department.findOne({ name: { $regex: `^${name}$`, $options: 'i' } });
    return d ? d._id : null;
  };

  switch (name) {
    case 'get_headcount': {
      if (!isHRorAdmin) return { error: 'Not allowed for your role' };
      const dept = args.department ? await Department.findOne({ name: { $regex: `^${args.department}$`, $options: 'i' } }) : null;
      const filter = { status: { $ne: 'exited' } };
      if (dept) filter.department = dept._id;
      const count = await Employee.countDocuments(filter);
      return { scope: dept ? dept.name : 'company', headcount: count };
    }
    case 'get_attendance_summary': {
      if (!isHRorAdmin) return { error: 'Not allowed for your role' };
      if (args.days) {
        const t = await trend(Math.min(30, Math.max(1, Math.round(args.days))));
        const valid = t.filter((d) => !d.weekend && d.expected > 0);
        const avgRate = valid.length
          ? Math.round((valid.reduce((s, d) => s + d.rate, 0) / valid.length) * 10) / 10
          : null;
        return { days: t, averageAttendanceRate: avgRate };
      }
      const board = await dailyBoard(args.date || todayStr());
      return { date: board.date, counts: board.counts, weekend: board.isWeekend, holiday: board.isHoliday };
    }
    case 'get_late_comers': {
      if (!isHRorAdmin) return { error: 'Not allowed for your role' };
      const now = new Date();
      const ym = args.month && /^\d{4}-\d{2}$/.test(args.month) ? args.month : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const start = `${ym}-01`;
      const endDate = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0, 12);
      const end = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`;
      const agg = await Attendance.aggregate([
        { $match: { date: { $gte: start, $lte: end }, status: 'late' } },
        { $group: { _id: '$employeeId', lateCount: { $sum: 1 } } },
        { $sort: { lateCount: -1 } },
        { $limit: 10 },
      ]);
      const emps = await Employee.find({ _id: { $in: agg.map((a) => a._id) } })
        .populate('department', 'name').select('name code department').lean();
      const byId = new Map(emps.map((e) => [String(e._id), e]));
      return {
        month: ym,
        lateComers: agg
          .map((a) => {
            const e = byId.get(String(a._id));
            return e ? { name: e.name, code: e.code, department: e.department ? e.department.name : '', lateCount: a.lateCount } : null;
          })
          .filter(Boolean),
      };
    }
    case 'get_leave_summary': {
      if (!isHRorAdmin) return { error: 'Not allowed for your role' };
      const year = new Date().getFullYear();
      const byType = await LeaveRequest.aggregate([
        { $match: { status: 'approved', start: { $gte: `${year}-01-01` } } },
        { $group: { _id: '$typeName', days: { $sum: '$days' } } },
        { $sort: { days: -1 } },
      ]);
      const pending = await LeaveRequest.countDocuments({ status: 'pending' });
      const today = todayStr();
      const onLeaveToday = await LeaveRequest.find({ status: 'approved', start: { $lte: today }, end: { $gte: today } })
        .populate('employeeId', 'name').lean();
      return {
        year,
        approvedDaysByType: byType.map((b) => ({ type: b._id, days: b.days })),
        pendingRequests: pending,
        onLeaveToday: onLeaveToday.map((l) => ({ name: l.employeeId ? l.employeeId.name : 'unknown', type: l.typeName, until: l.end })),
      };
    }
    case 'get_my_leave_balance': {
      if (!user.employeeId) return { error: 'Your account has no employee profile' };
      const balances = await balancesFor(user.employeeId, args.year || new Date().getFullYear());
      return { balances };
    }
    case 'get_payroll_summary': {
      if (!isHRorAdmin) return { error: 'Not allowed for your role' };
      const now = new Date();
      const year = args.year || now.getFullYear();
      const month = args.month || (now.getMonth() === 0 ? 12 : now.getMonth());
      const run = await PayrollRun.findOne({ year, month });
      if (!run) return { found: false, message: `No payroll run for ${year}-${month}` };
      return { found: true, year, month, status: run.status, totals: run.totals };
    }
    case 'search_employees': {
      if (!isHRorAdmin) return { error: 'Not allowed for your role' };
      const filter = { status: { $ne: 'exited' } };
      if (args.department) {
        const dept = await deptIdByName(args.department);
        if (!dept) return { results: [], note: 'Unknown department' };
        filter.department = dept;
      }
      if (args.query) {
        const rx = new RegExp(args.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        filter.$or = [{ name: rx }, { code: rx }];
      }
      const emps = await Employee.find(filter).populate('department', 'name')
        .select('name code email department status joinDate').limit(20).lean();
      return {
        results: emps.map((e) => ({
          name: e.name, code: e.code, email: e.email,
          department: e.department ? e.department.name : '', status: e.status, joinDate: e.joinDate,
        })),
      };
    }
    default:
      return { error: `Unknown tool ${name}` };
  }
}

function toolsForRole(role) {
  if (role === 'employee') {
    return TOOL_DEFS.filter((t) => t.name === 'get_my_leave_balance');
  }
  return TOOL_DEFS;
}

async function policyPrompt(user) {
  const settings = await getSettings();
  const types = await LeaveType.find().lean();
  const quotaText = types.length
    ? types.map((t) => `${t.name}: ${t.unlimited ? 'unlimited' : t.annualQuota} days/year (${t.paid ? 'paid' : 'unpaid'})`).join('; ')
    : 'no leave types configured yet';

  return [
    `You are the AI assistant inside HCM Lite, an HR system for "${settings ? settings.companyName : 'the company'}".`,
    `The current user is ${user.name} with role "${user.role}". Today is ${todayStr()} (${new Date().toLocaleDateString('en', { weekday: 'long' })}).`,
    '',
    'COMPANY RULES (answer policy questions only from these rules; if something is not covered, say you do not know):',
    `- Office starts at ${settings ? settings.officeStart : '09:00'} with ${settings ? settings.graceMinutes : 15} minutes grace; arriving later is "late".`,
    `- Working less than ${settings ? settings.halfDayHours : 5} hours is a half day; a day with check-in but no check-out ends as missing_checkout.`,
    `- Weekend days: ${settings ? settings.weekendDays.map((d) => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d]).join(' and ') : 'Saturday and Sunday'}.`,
    `- Employees are absent if there is no attendance record and no approved leave for the day.`,
    `- Leave counts working days only (weekends and public holidays are skipped). Quotas: ${quotaText}. Overlapping or over-balance requests are rejected.`,
    '- Salary: gross = 1.5 x basic (basic + HRA 40% of basic + medical 10% of basic).',
    '- Payroll deductions: absent days + unpaid leave days + half of each half day, at gross / working days per day. Joiners and leavers are prorated.',
    '- Illustrative annual tax slabs on gross x 12: up to 600k no tax; up to 1.2M 5% over 600k; up to 2.4M 30k + 15% over 1.2M; up to 3.6M 210k + 25% over 2.4M; above 3.6M 510k + 35% over 3.6M.',
    '',
    'ACCESS RULES (very important):',
    '- Employees can only see their own data. If an employee asks about a colleague (attendance, salary, leave, personal data), politely refuse.',
    '- Salary details are never revealed by you to employees.',
    '- Use the tools for anything about real data; never invent numbers. If a tool errors or returns nothing, say so.',
    '- Keep answers short and factual. Numbers you quote must come from tool results or the rules above.',
  ].join('\n');
}

async function checkRateLimit(userId) {
  const since = new Date(Date.now() - 3600 * 1000);
  const count = await AiLog.countDocuments({ userId, createdAt: { $gte: since } });
  if (count >= HOURLY_LIMIT) {
    throw Object.assign(
      new Error(`AI hourly limit reached (${HOURLY_LIMIT} requests). Please try again later.`),
      { status: 429 }
    );
  }
}

async function logCall(userId, kind, ok, error, durationMs, toolCalls, inputPreview) {
  await AiLog.create({
    userId, kind, ok, error: error || '', durationMs, toolCalls: toolCalls || [],
    inputPreview: (inputPreview || '').slice(0, 500),
  }).catch(() => {});
}

async function chat(user, history) {
  if (!isConfigured()) return { reply: FALLBACK_REPLY, aiGenerated: false, configured: false };
  await checkRateLimit(user.id);

  const started = Date.now();
  const messages = [
    { role: 'system', content: await policyPrompt(user) },
    ...history.slice(-12).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 2000) })),
  ];
  const tools = toolsForRole(user.role);
  const called = [];

  try {
    let reply = null;
    for (let round = 0; round < 4; round += 1) {
      // eslint-disable-next-line no-await-in-loop
      const msg = await callLLM({ messages, tools });
      if (msg.tool_calls && msg.tool_calls.length) {
        messages.push(msg);
        for (const tc of msg.tool_calls) {
          let parsed = {};
          try {
            parsed = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          } catch {
            parsed = {};
          }
          // eslint-disable-next-line no-await-in-loop
          const result = await runTool(user, tc.function.name, parsed);
          called.push(tc.function.name);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 6000) });
        }
      } else {
        reply = msg.content;
        break;
      }
    }
    if (reply == null) reply = 'I could not complete that request. Please try rephrasing.';
    await logCall(user.id, 'chat', true, '', Date.now() - started, called, history[history.length - 1]?.content);
    return { reply, aiGenerated: true, configured: true, toolsUsed: called };
  } catch (err) {
    const friendly = err.name === 'AbortError'
      ? 'The AI service took too long to answer (15 s timeout). Please try again.'
      : `AI service issue: ${err.message}`;
    await logCall(user.id, 'chat', false, err.message, Date.now() - started, called, history[history.length - 1]?.content);
    return { reply: friendly, aiGenerated: false, configured: true, error: true };
  }
}

async function dashboardSummary(user, kpis) {
  if (!isConfigured()) return { reply: FALLBACK_REPLY, aiGenerated: false, configured: false };
  if (user.role === 'employee') {
    throw Object.assign(new Error('Dashboard summary is available to Admin and HR only'), { status: 403 });
  }
  await checkRateLimit(user.id);
  const started = Date.now();
  const messages = [
    {
      role: 'system',
      content: 'You summarize HR dashboard KPIs. Use ONLY the numbers provided in the user message. Reply with 3 to 5 short insight bullets, each starting with "- ". No preamble, no invented numbers.',
    },
    { role: 'user', content: `Dashboard KPIs (JSON): ${JSON.stringify(kpis).slice(0, 4000)}` },
  ];
  try {
    const msg = await callLLM({ messages });
    await logCall(user.id, 'summary', true, '', Date.now() - started, [], 'dashboard summary');
    return { reply: msg.content, aiGenerated: true, configured: true };
  } catch (err) {
    const friendly = err.name === 'AbortError'
      ? 'Summary timed out. Please retry.'
      : `AI service issue: ${err.message}`;
    await logCall(user.id, 'summary', false, err.message, Date.now() - started, [], 'dashboard summary');
    return { reply: friendly, aiGenerated: false, configured: true, error: true };
  }
}

function validateSmartLeave(parsed, types) {
  if (!parsed || typeof parsed !== 'object') return 'Response was not a JSON object';
  const { type, start, end, reason } = parsed;
  const match = types.find((t) => t.name.toLowerCase() === String(type || '').toLowerCase().trim());
  if (!match) return `Unknown leave type "${type}". Available: ${types.map((t) => t.name).join(', ')}`;
  const dateRx = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRx.test(String(start)) || !dateRx.test(String(end))) return 'start and end must be YYYY-MM-DD';
  if (String(start) > String(end)) return 'start is after end';
  if (!reason || !String(reason).trim()) return 'reason is required';
  return null;
}

// Smart leave: turn a plain sentence into a validated {type, start, end, reason} form.
async function smartLeave(user, text) {
  if (!isConfigured()) return { reply: FALLBACK_REPLY, aiGenerated: false, configured: false };
  if (!user.employeeId) {
    throw Object.assign(new Error('Your account has no employee profile, so leave cannot be applied'), { status: 400 });
  }
  await checkRateLimit(user.id);
  const started = Date.now();
  const types = await LeaveType.find().lean();
  if (!types.length) {
    return { reply: 'No leave types are configured yet. Ask Admin to add leave types first.', aiGenerated: false, configured: true };
  }

  const messages = [
    {
      role: 'system',
      content: [
        'You convert a leave request sentence into JSON.',
        `Today is ${todayStr()} (${new Date().toLocaleDateString('en', { weekday: 'long' })}). Resolve phrases like "next Monday" to real dates.`,
        `Allowed leave types: ${types.map((t) => t.name).join(', ')}.`,
        'Reply with ONLY minified JSON: {"type":"...","start":"YYYY-MM-DD","end":"YYYY-MM-DD","reason":"..."} — no markdown, no extra text.',
      ].join(' '),
    },
    { role: 'user', content: String(text || '').slice(0, 500) },
  ];

  const attempt = async () => {
    const msg = await callLLM({ messages });
    const raw = (msg.content || '').replace(/```json|```/g, '').trim();
    const start = raw.indexOf('{');
    const endIx = raw.lastIndexOf('}');
    if (start === -1 || endIx === -1) throw new Error('No JSON found in AI response');
    return JSON.parse(raw.slice(start, endIx + 1));
  };

  try {
    let parsed;
    let err = null;
    try {
      parsed = await attempt();
      err = validateSmartLeave(parsed, types);
    } catch {
      parsed = null;
      err = 'AI response was not valid JSON';
    }
    if (err) {
      // Retry once on failure, then fall back to the normal form.
      try {
        parsed = await attempt();
        err = validateSmartLeave(parsed, types);
      } catch {
        err = 'AI response was not valid JSON';
      }
    }
    if (err || !parsed) {
      await logCall(user.id, 'smart_leave', false, err, Date.now() - started, [], text);
      return { reply: `Could not build a leave form from that (${err}). Please fill the form manually.`, aiGenerated: false, configured: true };
    }
    await logCall(user.id, 'smart_leave', true, '', Date.now() - started, [], text);
    return {
      aiGenerated: true,
      configured: true,
      leave: {
        leaveTypeId: types.find((t) => t.name.toLowerCase() === String(parsed.type).toLowerCase().trim())._id,
        typeName: types.find((t) => t.name.toLowerCase() === String(parsed.type).toLowerCase().trim()).name,
        start: parsed.start,
        end: parsed.end,
        reason: String(parsed.reason).trim(),
      },
    };
  } catch (err2) {
    const friendly = err2.name === 'AbortError' ? 'AI timed out. Please fill the form manually.' : `AI service issue: ${err2.message}`;
    await logCall(user.id, 'smart_leave', false, err2.message, Date.now() - started, [], text);
    return { reply: friendly, aiGenerated: false, configured: true };
  }
}

module.exports = { isConfigured, chat, dashboardSummary, smartLeave, FALLBACK_REPLY };
