const mongoose = require('mongoose');

// One record per employee per day. `date` is a local YYYY-MM-DD string.
const attendanceSchema = new mongoose.Schema(
  {
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    date: { type: String, required: true },
    checkIn: { type: Date, required: true },
    checkOut: { type: Date, default: null },
    workedMinutes: { type: Number, default: null },
    // present | late | half_day | missing_checkout (computed, may be re-derived)
    status: { type: String, enum: ['present', 'late', 'half_day', 'missing_checkout'], default: 'present' },
    source: { type: String, enum: ['web', 'camera', 'correction'], default: 'web' },
    corrected: { type: Boolean, default: false },
  },
  { timestamps: true }
);

attendanceSchema.index({ employeeId: 1, date: 1 }, { unique: true });
attendanceSchema.index({ date: 1 });

module.exports = mongoose.model('Attendance', attendanceSchema);
