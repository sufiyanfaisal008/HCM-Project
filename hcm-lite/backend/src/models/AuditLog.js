const mongoose = require('mongoose');

// Append-only audit trail. There are no update or delete routes for this collection.
const auditLogSchema = new mongoose.Schema(
  {
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    actorName: { type: String, default: 'system' },
    actorRole: { type: String, default: '' },
    action: { type: String, required: true }, // e.g. employee.create, leave.approve
    entity: { type: String, required: true }, // e.g. Employee, PayrollRun
    entityId: { type: String, default: '' },
    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ entity: 1, createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
