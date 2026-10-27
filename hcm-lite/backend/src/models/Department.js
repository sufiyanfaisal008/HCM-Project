const mongoose = require('mongoose');

const departmentSchema = new mongoose.Schema(
  { name: { type: String, required: true, unique: true, trim: true } },
  { timestamps: true }
);

module.exports = mongoose.model('Department', departmentSchema);
