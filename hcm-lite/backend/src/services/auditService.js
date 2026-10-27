const AuditLog = require('../models/AuditLog');

// Append-only log of every important action: actor, action, entity, before/after JSON.
function log(actor, action, entity, entityId, before, after) {
  return AuditLog.create({
    actorId: actor ? actor.id || actor._id : null,
    actorName: actor ? actor.name || 'system' : 'system',
    actorRole: actor ? actor.role || '' : '',
    action,
    entity,
    entityId: entityId ? String(entityId) : '',
    before: before === undefined ? null : JSON.parse(JSON.stringify(before)),
    after: after === undefined ? null : JSON.parse(JSON.stringify(after)),
  }).catch((err) => console.error('audit log failed:', err.message));
}

module.exports = { log };
