const mongoose = require('mongoose');

const employeeSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, trim: true, uppercase: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, default: '', trim: true },
    address: { type: String, default: '', trim: true },
    gender: { type: String, enum: ['male', 'female', 'other'], default: 'male' },
    dob: { type: String, default: '' }, // YYYY-MM-DD
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null },
    designation: { type: mongoose.Schema.Types.ObjectId, ref: 'Designation', default: null },
    joinDate: { type: String, required: true }, // YYYY-MM-DD
    exitDate: { type: String, default: null }, // set when employee exits
    basicSalary: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: ['active', 'probation', 'exited'], default: 'active' },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

employeeSchema.index({ name: 'text' });

module.exports = mongoose.model('Employee', employeeSchema);
