const mongoose = require('mongoose');

const payslipSchema = new mongoose.Schema(
  {
    runId: { type: mongoose.Schema.Types.ObjectId, ref: 'PayrollRun', required: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    employeeCode: String,
    employeeName: String,
    departmentName: { type: String, default: '' },
    designationName: { type: String, default: '' },
    basic: Number,
    hra: Number,
    medical: Number,
    gross: Number,
    workingDays: Number,
    expectedDays: Number,
    absentDays: Number,
    unpaidDays: Number,
    halfDays: Number,
    perDayRate: Number,
    absentDeduction: Number,
    unpaidDeduction: Number,
    halfDayDeduction: Number,
    tax: Number,
    net: Number,
    prorated: { type: Boolean, default: false },
    note: { type: String, default: '' },
  },
  { timestamps: true }
);

payslipSchema.index({ runId: 1, employeeId: 1 }, { unique: true });

module.exports = mongoose.model('Payslip', payslipSchema);
