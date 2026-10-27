const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { httpError } = require('./errors');

const SECRET = () => process.env.JWT_SECRET || 'hcm-lite-dev-secret';

function signToken(user) {
  return jwt.sign(
    { id: user._id, role: user.role, employeeId: user.employeeId },
    SECRET(),
    { expiresIn: '12h' }
  );
}

// Verifies the JWT and loads the user. Rejects deactivated accounts.
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw httpError(401, 'Authentication required');
    let payload;
    try {
      payload = jwt.verify(token, SECRET());
    } catch {
      throw httpError(401, 'Invalid or expired token');
    }
    const user = await User.findById(payload.id);
    if (!user) throw httpError(401, 'Account no longer exists');
    if (!user.active) throw httpError(403, 'Account is deactivated');
    req.user = {
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      employeeId: user.employeeId,
      mustChangePassword: user.mustChangePassword,
    };
    next();
  } catch (err) {
    next(err);
  }
}

// Role guard — access is checked on the server for every request.
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return next(httpError(403, 'You do not have permission to perform this action'));
  }
  next();
};

module.exports = { signToken, requireAuth, requireRole };
