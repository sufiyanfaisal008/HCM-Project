const mongoose = require('mongoose');

const leaveRequestSchema = new mongoose.Schema(
  {
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    leaveType: { type: mongoose.Schema.Types.ObjectId, ref: 'LeaveType', required: true },
    typeName: { type: String, required: true },
    paid: { type: Boolean, default: true },
    start: { type: String, required: true }, // YYYY-MM-DD
    end: { type: String, required: true }, // YYYY-MM-DD
    days: { type: Number, required: true, min: 1 }, // working days
    reason: { type: String, required: true, trim: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'cancelled'], default: 'pending' },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    comment: { type: String, default: '' },
  },
  { timestamps: true }
);

leaveRequestSchema.index({ employeeId: 1, start: 1, end: 1 });
leaveRequestSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('LeaveRequest', leaveRequestSchema);
