const crypto = require('node:crypto');
const { promisify } = require('node:util');
const db = require('../db');

const scryptAsync = promisify(crypto.scrypt);

function validatePasswordComplexity(password) {
  if (!password || typeof password !== 'string') {
    return { isValid: false, reason: 'Password is required' };
  }
  if (password.length < 10) {
    return { isValid: false, reason: 'Password must be at least 10 characters long' };
  }
  if (!/[A-Z]/.test(password)) {
    return { isValid: false, reason: 'Password must include at least one uppercase letter (A-Z)' };
  }
  if (!/[a-z]/.test(password)) {
    return { isValid: false, reason: 'Password must include at least one lowercase letter (a-z)' };
  }
  if (!/[0-9]/.test(password)) {
    return { isValid: false, reason: 'Password must include at least one number (0-9)' };
  }
  if (!/[!@#$%^&*(),.?":{}|<>\-_]/.test(password)) {
    return { isValid: false, reason: 'Password must include at least one special character (!@#$%^&*)' };
  }
  return { isValid: true };
}

// Asynchronous scrypt prevents event-loop starvation and DoS under concurrent login load
async function hashPassword(password, salt) {
  const derivedKey = await scryptAsync(password, salt, 64);
  return derivedKey.toString('hex');
}

async function hasAnyLeadershipUsers() {
  const row = await db.get('SELECT COUNT(*) AS count FROM leadership_users');
  return row ? parseInt(row.count, 10) > 0 : false;
}

async function createLeadershipUser(username, fullName, email, password) {
  const complexity = validatePasswordComplexity(password);
  if (!complexity.isValid) {
    throw new Error(complexity.reason);
  }

  const cleanUsername = String(username).trim().toLowerCase();
  const cleanName = String(fullName).trim();
  const cleanEmail = String(email || '').trim().toLowerCase();

  const existing = await db.get('SELECT id FROM leadership_users WHERE username = ?', [cleanUsername]);
  if (existing) {
    throw new Error(`Username '${cleanUsername}' is already taken.`);
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await hashPassword(password, salt);
  const id = `usr_leader_${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();

  await db.run(`
    INSERT INTO leadership_users (id, username, full_name, email, password_hash, password_salt, role, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'LEADER', 1, ?)
  `, [id, cleanUsername, cleanName, cleanEmail, hash, salt, now]);

  return { id, username: cleanUsername, full_name: cleanName, email: cleanEmail, created_at: now };
}

async function verifyLeadershipUser(username, password) {
  const cleanUsername = String(username || '').trim().toLowerCase();
  const user = await db.get('SELECT * FROM leadership_users WHERE username = ?', [cleanUsername]);

  if (!user) {
    return { user: null, reason: 'INVALID_CREDENTIALS', message: 'Invalid username or password.' };
  }

  if (!user.is_active) {
    return { user: null, reason: 'DEACTIVATED', message: 'Account is deactivated. Please contact an administrator.' };
  }

  // Account Lockout Check
  if (user.is_locked) {
    return {
      user: null,
      reason: 'ACCOUNT_LOCKED',
      message: `Account '${user.username}' is locked due to multiple failed login attempts. Any active administrator can unlock it from the Admins menu.`
    };
  }

  const computedHash = await hashPassword(password, user.password_salt);
  const a = Buffer.from(computedHash, 'hex');
  const b = Buffer.from(user.password_hash, 'hex');

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    const newFailures = (parseInt(user.failed_login_attempts, 10) || 0) + 1;
    const MAX_FAILURES = 5;

    if (newFailures >= MAX_FAILURES) {
      const now = new Date().toISOString();
      await db.run('UPDATE leadership_users SET failed_login_attempts = ?, is_locked = 1, locked_at = ? WHERE id = ?', [
        newFailures, now, user.id
      ]);
      return {
        user: null,
        reason: 'ACCOUNT_LOCKED',
        message: `Account '${user.username}' has been locked due to 5 consecutive failed login attempts. Any active administrator can unlock your account.`
      };
    } else {
      await db.run('UPDATE leadership_users SET failed_login_attempts = ? WHERE id = ?', [
        newFailures, user.id
      ]);
      const remaining = MAX_FAILURES - newFailures;
      return {
        user: null,
        reason: 'INVALID_CREDENTIALS',
        message: `Invalid username or password. (${remaining} attempt${remaining === 1 ? '' : 's'} remaining before lockout)`
      };
    }
  }

  // Authentication succeeded: reset lockout state and update last login
  const now = new Date().toISOString();
  await db.run('UPDATE leadership_users SET last_login_at = ?, failed_login_attempts = 0, is_locked = 0, locked_at = NULL WHERE id = ?', [
    now, user.id
  ]);

  return {
    user: {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      email: user.email,
      role: user.role
    },
    reason: null
  };
}

async function unlockLeadershipUser(userId) {
  const user = await db.get('SELECT * FROM leadership_users WHERE id = ?', [userId]);
  if (!user) {
    throw new Error('Leadership user not found.');
  }

  await db.run('UPDATE leadership_users SET is_locked = 0, failed_login_attempts = 0, locked_at = NULL WHERE id = ?', [
    user.id
  ]);

  return {
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    email: user.email,
    is_locked: false
  };
}

async function createSession(userId, username, ip, userAgent) {
  const sessionId = `sw_sess_${crypto.randomBytes(32).toString('hex')}`;
  const now = new Date().toISOString();

  await db.run(`
    INSERT INTO leadership_sessions (id, user_id, username, ip_address, user_agent, created_at, last_activity_at, duration_seconds)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `, [sessionId, userId, username, ip || '', userAgent || '', now, now]);

  return sessionId;
}

// 2-hour idle timeout & 24-hour absolute session expiration
const MAX_IDLE_SECONDS = 2 * 60 * 60;
const MAX_SESSION_SECONDS = 24 * 60 * 60;

async function validateSession(token) {
  if (!token) return null;

  const session = await db.get(`
    SELECT s.*, u.full_name, u.email, u.role
    FROM leadership_sessions s
    JOIN leadership_users u ON s.user_id = u.id
    WHERE s.id = ? AND s.ended_at IS NULL AND u.is_active = 1
  `, [token]);

  if (!session) return null;

  const now = new Date();
  const createdTime = new Date(session.created_at);
  const lastActiveTime = new Date(session.last_activity_at || session.created_at);

  const idleSeconds = Math.max(0, Math.floor((now.getTime() - lastActiveTime.getTime()) / 1000));
  const totalDuration = Math.max(0, Math.floor((now.getTime() - createdTime.getTime()) / 1000));

  // Invalidate expired sessions automatically
  if (idleSeconds > MAX_IDLE_SECONDS || totalDuration > MAX_SESSION_SECONDS) {
    await endSession(token);
    return null;
  }

  await db.run(`
    UPDATE leadership_sessions 
    SET last_activity_at = ?, duration_seconds = ?
    WHERE id = ?
  `, [now.toISOString(), totalDuration, token]);

  return {
    sessionId: session.id,
    userId: session.user_id,
    username: session.username,
    fullName: session.full_name,
    email: session.email,
    role: session.role,
    durationSeconds: totalDuration
  };
}

async function endSession(token) {
  if (!token) return;
  const now = new Date();
  const session = await db.get('SELECT * FROM leadership_sessions WHERE id = ?', [token]);
  if (session) {
    const createdTime = new Date(session.created_at);
    const durationSeconds = Math.max(0, Math.floor((now.getTime() - createdTime.getTime()) / 1000));
    await db.run(`
      UPDATE leadership_sessions SET ended_at = ?, duration_seconds = ? WHERE id = ?
    `, [now.toISOString(), durationSeconds, token]);
  }
}

function sanitizeLogText(str) {
  if (!str) return '';
  return String(str)
    .replace(/[<>]/g, '')
    .slice(0, 500);
}

async function recordAuditLog({ sessionId, userId, username, actionType, targetId, targetName, description, details, ip }) {
  const now = new Date().toISOString();
  const detailsStr = details ? JSON.stringify(details) : null;

  await db.run(`
    INSERT INTO audit_logs (session_id, user_id, username, action_type, target_id, target_name, description, details_json, ip_address, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    sessionId || '',
    userId || 'SYSTEM',
    sanitizeLogText(username || 'SYSTEM'),
    sanitizeLogText(actionType),
    sanitizeLogText(targetId || ''),
    sanitizeLogText(targetName || ''),
    sanitizeLogText(description),
    detailsStr,
    sanitizeLogText(ip || ''),
    now
  ]);
}

module.exports = {
  validatePasswordComplexity,
  hashPassword,
  hasAnyLeadershipUsers,
  createLeadershipUser,
  verifyLeadershipUser,
  unlockLeadershipUser,
  createSession,
  validateSession,
  endSession,
  recordAuditLog
};
