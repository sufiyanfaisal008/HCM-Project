const mongoose = require('mongoose');

const settingSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'company', unique: true },
    companyName: { type: String, required: true, trim: true },
    officeStart: { type: String, default: '09:00' }, // HH:mm
    graceMinutes: { type: Number, default: 15, min: 0 },
    halfDayHours: { type: Number, default: 5, min: 1 },
    weekendDays: { type: [Number], default: [6, 0] }, // JS getDay(): 0=Sun, 6=Sat
    standardWeekHours: { type: Number, default: 40 },
    officeLocation: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },
    officeRadiusM: { type: Number, default: 150, min: 10 },
    currency: { type: String, default: 'PKR' },
    setupDone: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Setting', settingSchema);
