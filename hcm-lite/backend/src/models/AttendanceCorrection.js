const mongoose = require('mongoose');

const correctionSchema = new mongoose.Schema(
  {
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    date: { type: String, required: true }, // YYYY-MM-DD
    checkIn: { type: String, required: true }, // HH:mm
    checkOut: { type: String, default: '' }, // HH:mm
    reason: { type: String, required: true, trim: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    comment: { type: String, default: '' },
  },
  { timestamps: true }
);

correctionSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('AttendanceCorrection', correctionSchema);
