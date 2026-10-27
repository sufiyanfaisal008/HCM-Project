const Notification = require('../models/Notification');

function notify(userId, title, body) {
  if (!userId) return Promise.resolve();
  return Notification.create({ userId, title, body: body || '' }).catch((err) =>
    console.error('notification failed:', err.message)
  );
}

async function notifyMany(userIds, title, body) {
  if (!userIds.length) return;
  await Notification.insertMany(
    userIds.map((userId) => ({ userId, title, body: body || '' }))
  ).catch((err) => console.error('notification failed:', err.message));
}

module.exports = { notify, notifyMany };
