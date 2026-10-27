const Setting = require('../models/Setting');

async function getSettings() {
  let doc = await Setting.findOne({ key: 'company' });
  return doc;
}

async function isSetupDone() {
  const doc = await getSettings();
  return Boolean(doc && doc.setupDone);
}

const DEFAULTS = {
  companyName: 'My Company',
  officeStart: '09:00',
  graceMinutes: 15,
  halfDayHours: 5,
  weekendDays: [6, 0],
  standardWeekHours: 40,
  officeRadiusM: 150,
  currency: 'PKR',
};

async function createSettings(data) {
  const doc = await Setting.findOneAndUpdate(
    { key: 'company' },
    { ...DEFAULTS, ...data, key: 'company', setupDone: true },
    { new: true, upsert: true }
  );
  return doc;
}

async function updateSettings(data) {
  const doc = await getSettings();
  if (!doc) throw Object.assign(new Error('Company setup not completed'), { status: 400 });
  const allowed = [
    'companyName', 'officeStart', 'graceMinutes', 'halfDayHours',
    'weekendDays', 'standardWeekHours', 'officeLocation', 'officeRadiusM', 'currency',
  ];
  allowed.forEach((k) => {
    if (data[k] !== undefined) doc[k] = data[k];
  });
  await doc.save();
  return doc;
}

async function holidaySetForRange(startStr, endStr) {
  const Holiday = require('../models/Holiday');
  const docs = await Holiday.find({ date: { $gte: startStr, $lte: endStr } }).select('date');
  return new Set(docs.map((d) => d.date));
}

module.exports = { getSettings, isSetupDone, createSettings, updateSettings, holidaySetForRange };
