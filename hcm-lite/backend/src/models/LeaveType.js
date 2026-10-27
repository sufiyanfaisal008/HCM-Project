const mongoose = require('mongoose');

// annualQuota: null means unlimited (e.g. unpaid leave)
const leaveTypeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    annualQuota: { type: Number, default: 0, min: 0 },
    unlimited: { type: Boolean, default: false },
    paid: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('LeaveType', leaveTypeSchema);
