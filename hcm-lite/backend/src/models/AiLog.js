const mongoose = require('mongoose');

const aiLogSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: ['chat', 'summary', 'smart_leave'], required: true },
    ok: { type: Boolean, default: true },
    error: { type: String, default: '' },
    durationMs: { type: Number, default: 0 },
    toolCalls: { type: [String], default: [] },
    inputPreview: { type: String, default: '' },
  },
  { timestamps: true }
);

aiLogSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('AiLog', aiLogSchema);
