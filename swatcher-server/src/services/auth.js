const crypto = require('node:crypto');
const db = require('../db');

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

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
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
  const hash = hashPassword(password, salt);
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

  if (!user || !user.is_active) {
    return null;
  }

  const computedHash = hashPassword(password, user.password_salt);
  const a = Buffer.from(computedHash, 'hex');
  const b = Buffer.from(user.password_hash, 'hex');

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return null;
  }

  const now = new Date().toISOString();
  await db.run('UPDATE leadership_users SET last_login_at = ? WHERE id = ?', [now, user.id]);

  return {
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    email: user.email,
    role: user.role
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
  const durationSeconds = Math.max(0, Math.floor((now.getTime() - createdTime.getTime()) / 1000));

  await db.run(`
    UPDATE leadership_sessions 
    SET last_activity_at = ?, duration_seconds = ?
    WHERE id = ?
  `, [now.toISOString(), durationSeconds, token]);

  return {
    sessionId: session.id,
    userId: session.user_id,
    username: session.username,
    fullName: session.full_name,
    email: session.email,
    role: session.role,
    durationSeconds
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

async function recordAuditLog({ sessionId, userId, username, actionType, targetId, targetName, description, details, ip }) {
  const now = new Date().toISOString();
  const detailsStr = details ? JSON.stringify(details) : null;

  await db.run(`
    INSERT INTO audit_logs (session_id, user_id, username, action_type, target_id, target_name, description, details_json, ip_address, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    sessionId || '',
    userId || 'SYSTEM',
    username || 'SYSTEM',
    actionType,
    targetId || '',
    targetName || '',
    description,
    detailsStr,
    ip || '',
    now
  ]);
}

module.exports = {
  validatePasswordComplexity,
  hashPassword,
  hasAnyLeadershipUsers,
  createLeadershipUser,
  verifyLeadershipUser,
  createSession,
  validateSession,
  endSession,
  recordAuditLog
};
