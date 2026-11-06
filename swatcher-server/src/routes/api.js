const express = require('express');
const crypto = require('node:crypto');
const db = require('../db');
const {
  validatePasswordComplexity,
  hasAnyLeadershipUsers,
  createLeadershipUser,
  verifyLeadershipUser,
  createSession,
  validateSession,
  endSession,
  recordAuditLog
} = require('../services/auth');
const { getOverview, getEngagementMetrics, getEngagementDetail } = require('../services/analytics');

const router = express.Router();

// Helper to extract client IP
function getClientIp(req) {
  return req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1';
}

/**
 * ==========================================================
 * LEADERSHIP DASHBOARD AUTHENTICATION MIDDLEWARE
 * ==========================================================
 */
function authenticateLeader(req, res, next) {
  const authHeader = req.headers.authorization || '';
  let token = req.headers['x-session-token'] || '';
  if (!token && authHeader.startsWith('Bearer sw_sess_')) {
    token = authHeader.slice(7).trim();
  }

  const session = validateSession(token);
  if (!session) {
    return res.status(401).json({ error: 'Authentication required. Please log in.' });
  }

  req.leader = session;
  next();
}

/**
 * ==========================================================
 * BURP PLUGIN INGESTION AUTHENTICATION MIDDLEWARE
 * ==========================================================
 */
function authenticateIngestion(req, res, next) {
  const authHeader = req.headers.authorization || '';
  let token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
  if (!token && req.headers['x-api-key']) {
    token = String(req.headers['x-api-key']).trim();
  }

  if (!token) {
    return res.status(401).json({ error: 'Missing API Token. Please configure your Swatcher API Key in Burp Suite.' });
  }

  const tester = db.prepare('SELECT id, username, full_name, is_active FROM pentesters WHERE api_key = ?').get(token);
  if (!tester) {
    return res.status(401).json({ error: 'Invalid API Token. Token not recognized.' });
  }
  if (!tester.is_active) {
    return res.status(403).json({ error: 'Pentester account deactivated.' });
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE pentesters SET last_active_at = ? WHERE id = ?').run(now, tester.id);

  req.pentester = tester;
  next();
}

// Prepared statements for ingestion
const insertLogStmt = db.prepare(`
  INSERT OR IGNORE INTO traffic_logs (
    event_id, session_id, ritm, application_id, tester_id, tester_username, tester_machine,
    tool, timestamp, method, url, host, port, path, query,
    request_headers, request_body, request_body_length,
    status_code, response_headers, response_body, response_body_length,
    duration_ms, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertEngagementStmt = db.prepare(`
  INSERT INTO engagements (id, ritm, application_id, client_name, allocated_hours, status, created_at)
  VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)
`);

/**
 * ==========================================================
 * 1. AUTH & SETUP ENDPOINTS
 * ==========================================================
 */

/**
 * Check initial setup status & current session
 */
router.get('/auth/status', (req, res) => {
  const setupRequired = !hasAnyLeadershipUsers();
  const token = req.headers['x-session-token'] || (req.headers.authorization?.startsWith('Bearer sw_sess_') ? req.headers.authorization.slice(7) : null);
  const session = validateSession(token);

  res.json({
    setupRequired,
    authenticated: Boolean(session),
    user: session ? { username: session.username, full_name: session.fullName, role: session.role } : null
  });
});

/**
 * Burp Plugin Handshake: Verify Pentester API Token on Extension Startup
 */
router.post('/auth/verify-key', (req, res) => {
  const authHeader = req.headers.authorization || '';
  let token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
  if (!token && req.body?.api_key) {
    token = String(req.body.api_key).trim();
  }

  if (!token) {
    return res.status(401).json({ valid: false, error: 'API token is required.' });
  }

  const tester = db.prepare('SELECT id, username, full_name, email, is_active FROM pentesters WHERE api_key = ?').get(token);

  if (!tester) {
    return res.status(401).json({ valid: false, error: 'API Key not recognized by swatcher server.' });
  }
  if (!tester.is_active) {
    return res.status(403).json({ valid: false, error: 'This pentester account has been deactivated by leadership.' });
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE pentesters SET last_active_at = ? WHERE id = ?').run(now, tester.id);

  res.json({
    valid: true,
    pentester: {
      id: tester.id,
      username: tester.username,
      full_name: tester.full_name,
      email: tester.email
    },
    message: `Welcome back, ${tester.full_name} (${tester.username})!`,
    server_time: now
  });
});

/**
 * First-Time Setup Wizard: Create initial admin user
 */
router.post('/auth/setup', (req, res) => {
  if (hasAnyLeadershipUsers()) {
    return res.status(403).json({ error: 'Setup is already completed. Please log in.' });
  }

  const { username, full_name, email, password } = req.body;
  if (!username || !password || !full_name) {
    return res.status(400).json({ error: 'Username, full name, and password are required.' });
  }

  try {
    const user = createLeadershipUser(username, full_name, email, password);
    const ip = getClientIp(req);
    const token = createSession(user.id, user.username, ip, req.headers['user-agent']);

    recordAuditLog({
      sessionId: token,
      userId: user.id,
      username: user.username,
      actionType: 'INITIAL_SETUP',
      description: `Initial administrator account created for ${user.username}`,
      details: { full_name, email },
      ip
    });

    res.status(201).json({
      status: 'OK',
      message: 'Initial administrator account created successfully.',
      token,
      user: { username: user.username, full_name: user.full_name, role: 'LEADER' }
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Leadership User Login
 */
router.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  const ip = getClientIp(req);

  const user = verifyLeadershipUser(username, password);
  if (!user) {
    recordAuditLog({
      actionType: 'FAILED_LOGIN_ATTEMPT',
      username: username || 'UNKNOWN',
      description: `Failed login attempt for username '${username}'`,
      ip
    });
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  const token = createSession(user.id, user.username, ip, req.headers['user-agent']);

  recordAuditLog({
    sessionId: token,
    userId: user.id,
    username: user.username,
    actionType: 'USER_LOGIN',
    description: `Leadership user ${user.username} logged into operations dashboard`,
    ip
  });

  res.json({
    status: 'OK',
    token,
    user: { username: user.username, full_name: user.full_name, role: user.role }
  });
});

/**
 * Leadership User Logout
 */
router.post('/auth/logout', authenticateLeader, (req, res) => {
  endSession(req.leader.sessionId);
  recordAuditLog({
    sessionId: req.leader.sessionId,
    userId: req.leader.userId,
    username: req.leader.username,
    actionType: 'USER_LOGOUT',
    description: `Leadership user ${req.leader.username} logged out (Session duration: ${req.leader.durationSeconds}s)`,
    details: { duration_seconds: req.leader.durationSeconds },
    ip: getClientIp(req)
  });
  res.json({ status: 'OK' });
});

/**
 * Create New Leadership User (Authenticated leaders only)
 */
router.post('/auth/users', authenticateLeader, (req, res) => {
  const { username, full_name, email, password } = req.body;
  if (!username || !password || !full_name) {
    return res.status(400).json({ error: 'Username, full name, and password are required.' });
  }

  try {
    const user = createLeadershipUser(username, full_name, email, password);
    recordAuditLog({
      sessionId: req.leader.sessionId,
      userId: req.leader.userId,
      username: req.leader.username,
      actionType: 'CREATE_USER',
      targetId: user.id,
      targetName: user.username,
      description: `Leader ${req.leader.username} created new dashboard user ${user.username}`,
      details: { full_name, email },
      ip: getClientIp(req)
    });

    res.status(201).json({ status: 'OK', user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * List Leadership Users
 */
router.get('/auth/users', authenticateLeader, (req, res) => {
  const users = db.prepare('SELECT id, username, full_name, email, role, is_active, created_at, last_login_at FROM leadership_users ORDER BY created_at DESC').all();
  res.json(users);
});

/**
 * ==========================================================
 * 2. COMPREHENSIVE AUDIT TRAIL ENDPOINTS
 * ==========================================================
 */
router.get('/audit-logs', authenticateLeader, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const logs = db.prepare(`
      SELECT a.*, s.duration_seconds
      FROM audit_logs a
      LEFT JOIN leadership_sessions s ON a.session_id = s.id
      ORDER BY a.created_at DESC
      LIMIT ?
    `).all(limit);

    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * ==========================================================
 * 3. DASHBOARD KPIS & ENGAGEMENTS
 * ==========================================================
 */
router.get('/analytics/overview', authenticateLeader, (req, res) => {
  try {
    const data = getOverview();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/analytics/engagements', authenticateLeader, (req, res) => {
  try {
    const data = getEngagementMetrics();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/analytics/engagements/:ritm', authenticateLeader, (req, res) => {
  try {
    const detail = getEngagementDetail(req.params.ritm);
    if (!detail) return res.status(404).json({ error: 'Engagement not found' });
    res.json(detail);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Delete Single RITM Engagement
 */
router.delete('/engagements/:ritm', authenticateLeader, (req, res) => {
  const ritm = String(req.params.ritm).trim().toUpperCase();
  const eng = db.prepare('SELECT * FROM engagements WHERE ritm = ?').get(ritm);
  if (!eng) return res.status(404).json({ error: 'Engagement not found' });

  const logCount = db.prepare('SELECT COUNT(*) as count FROM traffic_logs WHERE ritm = ?').get(ritm).count;

  db.prepare('DELETE FROM traffic_logs WHERE ritm = ?').run(ritm);
  db.prepare('DELETE FROM sessions WHERE ritm = ?').run(ritm);
  db.prepare('DELETE FROM engagements WHERE ritm = ?').run(ritm);

  recordAuditLog({
    sessionId: req.leader.sessionId,
    userId: req.leader.userId,
    username: req.leader.username,
    actionType: 'DELETE_RITM',
    targetId: ritm,
    targetName: eng.application_id,
    description: `Deleted engagement ${ritm} and purged ${logCount} associated traffic records`,
    details: { ritm, application_id: eng.application_id, purged_logs: logCount },
    ip: getClientIp(req)
  });

  res.json({ status: 'OK', deleted_ritm: ritm, purged_logs: logCount });
});

/**
 * Batch Delete RITM Engagements
 */
router.post('/engagements/batch-delete', authenticateLeader, (req, res) => {
  const { ritms } = req.body;
  if (!Array.isArray(ritms) || ritms.length === 0) {
    return res.status(400).json({ error: 'ritms array is required' });
  }

  let deletedCount = 0;
  let totalPurgedLogs = 0;

  for (const rawRitm of ritms) {
    const ritm = String(rawRitm).trim().toUpperCase();
    const count = db.prepare('SELECT COUNT(*) as count FROM traffic_logs WHERE ritm = ?').get(ritm).count;
    db.prepare('DELETE FROM traffic_logs WHERE ritm = ?').run(ritm);
    db.prepare('DELETE FROM sessions WHERE ritm = ?').run(ritm);
    db.prepare('DELETE FROM engagements WHERE ritm = ?').run(ritm);
    deletedCount++;
    totalPurgedLogs += count;
  }

  recordAuditLog({
    sessionId: req.leader.sessionId,
    userId: req.leader.userId,
    username: req.leader.username,
    actionType: 'BATCH_DELETE_RITMS',
    description: `Batch deleted ${deletedCount} engagements (${ritms.join(', ')})`,
    details: { ritms, deletedCount, totalPurgedLogs },
    ip: getClientIp(req)
  });

  res.json({ status: 'OK', deletedCount, totalPurgedLogs });
});

/**
 * ==========================================================
 * 4. PENTESTER PROFILE MANAGEMENT & DELETION
 * ==========================================================
 */
router.get('/pentesters', authenticateLeader, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, username, full_name, email, api_key, is_active, created_at, last_active_at
      FROM pentesters
      ORDER BY created_at DESC
    `).all();

    const enriched = rows.map(p => {
      const stats = db.prepare(`
        SELECT COUNT(*) AS total_requests, COUNT(DISTINCT ritm) AS total_engagements
        FROM traffic_logs WHERE tester_username = ?
      `).get(p.username);

      return {
        ...p,
        is_active: Boolean(p.is_active),
        total_requests: stats.total_requests || 0,
        total_engagements: stats.total_engagements || 0
      };
    });

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/pentesters', authenticateLeader, (req, res) => {
  const { username, full_name, email } = req.body;
  if (!username || !full_name) {
    return res.status(400).json({ error: 'username and full_name are required' });
  }

  const cleanUsername = String(username).trim().toLowerCase();
  const cleanName = String(full_name).trim();
  const cleanEmail = String(email || '').trim().toLowerCase();

  const existing = db.prepare('SELECT id FROM pentesters WHERE username = ?').get(cleanUsername);
  if (existing) {
    return res.status(409).json({ error: `Pentester with username '${cleanUsername}' already exists.` });
  }

  const id = `usr_${crypto.randomUUID().slice(0, 8)}`;
  const apiKey = `sw_live_${crypto.randomBytes(24).toString('hex')}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO pentesters (id, username, full_name, email, api_key, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)
  `).run(id, cleanUsername, cleanName, cleanEmail, apiKey, now);

  recordAuditLog({
    sessionId: req.leader.sessionId,
    userId: req.leader.userId,
    username: req.leader.username,
    actionType: 'CREATE_PENTESTER',
    targetId: id,
    targetName: cleanUsername,
    description: `Created pentester profile for ${cleanName} (${cleanUsername}) and generated API token`,
    details: { id, username: cleanUsername, full_name: cleanName, email: cleanEmail },
    ip: getClientIp(req)
  });

  res.status(201).json({
    status: 'CREATED',
    pentester: { id, username: cleanUsername, full_name: cleanName, email: cleanEmail, api_key: apiKey, is_active: true }
  });
});

router.delete('/pentesters/:id', authenticateLeader, (req, res) => {
  const tester = db.prepare('SELECT * FROM pentesters WHERE id = ?').get(req.params.id);
  if (!tester) return res.status(404).json({ error: 'Pentester not found' });

  db.prepare('DELETE FROM pentesters WHERE id = ?').run(req.params.id);

  recordAuditLog({
    sessionId: req.leader.sessionId,
    userId: req.leader.userId,
    username: req.leader.username,
    actionType: 'DELETE_PENTESTER',
    targetId: tester.id,
    targetName: tester.username,
    description: `Deleted pentester ${tester.full_name} (${tester.username}) and revoked API key`,
    details: { id: tester.id, username: tester.username },
    ip: getClientIp(req)
  });

  res.json({ status: 'OK', deleted_id: tester.id });
});

router.post('/pentesters/batch-delete', authenticateLeader, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array is required' });
  }

  let deletedCount = 0;
  for (const id of ids) {
    db.prepare('DELETE FROM pentesters WHERE id = ?').run(id);
    deletedCount++;
  }

  recordAuditLog({
    sessionId: req.leader.sessionId,
    userId: req.leader.userId,
    username: req.leader.username,
    actionType: 'BATCH_DELETE_PENTESTERS',
    description: `Batch deleted ${deletedCount} pentesters`,
    details: { ids },
    ip: getClientIp(req)
  });

  res.json({ status: 'OK', deletedCount });
});

router.patch('/pentesters/:id/toggle', authenticateLeader, (req, res) => {
  const tester = db.prepare('SELECT * FROM pentesters WHERE id = ?').get(req.params.id);
  if (!tester) return res.status(404).json({ error: 'Pentester not found' });

  const newStatus = tester.is_active ? 0 : 1;
  db.prepare('UPDATE pentesters SET is_active = ? WHERE id = ?').run(newStatus, tester.id);

  recordAuditLog({
    sessionId: req.leader.sessionId,
    userId: req.leader.userId,
    username: req.leader.username,
    actionType: 'TOGGLE_PENTESTER_STATUS',
    targetId: tester.id,
    targetName: tester.username,
    description: `${newStatus ? 'Activated' : 'Deactivated'} pentester ${tester.username}`,
    ip: getClientIp(req)
  });

  res.json({ status: 'OK', id: tester.id, is_active: Boolean(newStatus) });
});

router.post('/pentesters/:id/regenerate-key', authenticateLeader, (req, res) => {
  const tester = db.prepare('SELECT * FROM pentesters WHERE id = ?').get(req.params.id);
  if (!tester) return res.status(404).json({ error: 'Pentester not found' });

  const newApiKey = `sw_live_${crypto.randomBytes(24).toString('hex')}`;
  db.prepare('UPDATE pentesters SET api_key = ? WHERE id = ?').run(newApiKey, tester.id);

  recordAuditLog({
    sessionId: req.leader.sessionId,
    userId: req.leader.userId,
    username: req.leader.username,
    actionType: 'REGENERATE_API_KEY',
    targetId: tester.id,
    targetName: tester.username,
    description: `Regenerated API token for pentester ${tester.username}`,
    ip: getClientIp(req)
  });

  res.json({ status: 'OK', id: tester.id, new_api_key: newApiKey });
});

/**
 * ==========================================================
 * 5. BURP PLUGIN INGESTION & SESSIONS
 * ==========================================================
 */
router.post('/sessions/verify', authenticateIngestion, (req, res) => {
  const { ritm, application_id, tester_machine, client_name, allocated_hours } = req.body;
  if (!ritm || !application_id) {
    return res.status(400).json({ error: 'ritm and application_id are required' });
  }

  const cleanRitm = String(ritm).trim().toUpperCase();
  const cleanAppId = String(application_id).trim().toUpperCase();
  const effortHours = parseFloat(allocated_hours) || 40.0;
  const now = new Date().toISOString();

  let existingEng = db.prepare('SELECT * FROM engagements WHERE ritm = ?').get(cleanRitm);

  if (!existingEng) {
    const engagementId = `eng_${cleanRitm}_${Date.now()}`;
    insertEngagementStmt.run(engagementId, cleanRitm, cleanAppId, client_name || '', effortHours, now);
    existingEng = { id: engagementId, ritm: cleanRitm, application_id: cleanAppId, allocated_hours: effortHours };
  } else {
    if ((!existingEng.allocated_hours || existingEng.allocated_hours <= 0) && effortHours > 0) {
      db.prepare('UPDATE engagements SET allocated_hours = ? WHERE id = ?').run(effortHours, existingEng.id);
      existingEng.allocated_hours = effortHours;
    }
  }

  const sessionId = `sess_${cleanRitm}_${req.pentester.username}_${Date.now()}`;
  db.prepare(`
    INSERT INTO sessions (id, ritm, application_id, tester_id, tester_username, tester_machine, started_at, last_active_at, request_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(sessionId, cleanRitm, existingEng.application_id, req.pentester.id, req.pentester.username, tester_machine || '', now, now);

  res.json({
    status: 'OK',
    session_id: sessionId,
    ritm: cleanRitm,
    application_id: existingEng.application_id,
    allocated_hours: existingEng.allocated_hours,
    tester: req.pentester.username
  });
});

router.post('/ingest/batch', authenticateIngestion, (req, res) => {
  const { batch, engagement, session_id } = req.body;
  if (!Array.isArray(batch) || batch.length === 0) {
    return res.status(400).json({ error: 'batch must be a non-empty array of traffic records' });
  }

  const now = new Date().toISOString();
  let ingested = 0;

  for (const item of batch) {
    const eventId = item.event_id || crypto.randomUUID();
    const itemRitm = (item.engagement?.ritm || engagement?.ritm || 'UNKNOWN').trim().toUpperCase();
    const itemAppId = (item.engagement?.application_id || engagement?.application_id || 'UNKNOWN').trim().toUpperCase();
    const effortHours = parseFloat(item.engagement?.allocated_hours || engagement?.allocated_hours) || 40.0;

    let engRecord = db.prepare('SELECT * FROM engagements WHERE ritm = ?').get(itemRitm);
    if (!engRecord && itemRitm !== 'UNKNOWN') {
      const engId = `eng_${itemRitm}_${Date.now()}`;
      try {
        insertEngagementStmt.run(engId, itemRitm, itemAppId, '', effortHours, now);
        engRecord = { id: engId, ritm: itemRitm, application_id: itemAppId, allocated_hours: effortHours };
      } catch (_) {}
    }

    const resolvedAppId = engRecord ? engRecord.application_id : itemAppId;
    const itemSessionId = item.session_id || session_id || `sess_${itemRitm}_${req.pentester.username}`;
    const machineName = item.tester?.machine_name || '';

    const reqData = item.request || {};
    const resData = item.response || {};

    const tool = (reqData.tool || item.tool || 'PROXY').toUpperCase();
    const timestamp = reqData.timestamp || item.timestamp || now;
    const method = (reqData.method || 'GET').toUpperCase();
    const url = reqData.url || '';
    const host = reqData.host || (url ? new URL(url).hostname : 'unknown');
    const port = reqData.port || 443;
    const path = reqData.path || '/';
    const query = reqData.query || '';

    const reqHeadersStr = typeof reqData.headers === 'string' ? reqData.headers : JSON.stringify(reqData.headers || {});
    const reqBody = reqData.body || '';
    const reqBodyLen = reqData.body_length !== undefined ? reqData.body_length : reqBody.length;

    const statusCode = resData.status_code || 0;
    const resHeadersStr = typeof resData.headers === 'string' ? resData.headers : JSON.stringify(resData.headers || {});
    const resBody = resData.body || '';
    const resBodyLen = resData.body_length !== undefined ? resData.body_length : resBody.length;
    const durationMs = resData.duration_ms || 0;

    try {
      insertLogStmt.run(
        eventId,
        itemSessionId,
        itemRitm,
        resolvedAppId,
        req.pentester.id,
        req.pentester.username,
        machineName,
        tool,
        timestamp,
        method,
        url,
        host,
        port,
        path,
        query,
        reqHeadersStr,
        reqBody,
        reqBodyLen,
        statusCode,
        resHeadersStr,
        resBody,
        resBodyLen,
        durationMs,
        now
      );
      ingested++;
    } catch (err) {
      console.error('Failed to insert log entry:', err.message);
    }
  }

  res.json({
    status: 'OK',
    received: batch.length,
    ingested,
    tester: req.pentester.username,
    timestamp: now
  });
});

/**
 * ==========================================================
 * 6. LOGS EXPLORER (Leadership only)
 * ==========================================================
 */
router.get('/logs', authenticateLeader, (req, res) => {
  try {
    const { ritm, tool, tester, method, status_code, search, limit = 50, offset = 0 } = req.query;

    let query = 'SELECT id, event_id, ritm, application_id, tester_username, tool, timestamp, method, url, host, path, status_code, duration_ms, request_body_length, response_body_length FROM traffic_logs WHERE 1=1';
    const params = [];

    if (ritm) { query += ' AND ritm = ?'; params.push(String(ritm).trim().toUpperCase()); }
    if (tool) { query += ' AND tool = ?'; params.push(String(tool).trim().toUpperCase()); }
    if (tester) { query += ' AND tester_username = ?'; params.push(String(tester).trim()); }
    if (method) { query += ' AND method = ?'; params.push(String(method).trim().toUpperCase()); }
    if (status_code) { query += ' AND status_code = ?'; params.push(parseInt(status_code, 10)); }
    if (search) { query += ' AND (url LIKE ? OR path LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }

    query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    params.push(Math.min(parseInt(limit, 10) || 50, 200), parseInt(offset, 10) || 0);

    const rows = db.prepare(query).all(...params);

    let countQuery = 'SELECT COUNT(*) AS total FROM traffic_logs WHERE 1=1';
    const countParams = params.slice(0, params.length - 2);
    if (ritm) countQuery += ' AND ritm = ?';
    if (tool) countQuery += ' AND tool = ?';
    if (tester) countQuery += ' AND tester_username = ?';
    if (method) countQuery += ' AND method = ?';
    if (status_code) countQuery += ' AND status_code = ?';
    if (search) countQuery += ' AND (url LIKE ? OR path LIKE ?)';

    const totalCount = db.prepare(countQuery).get(...countParams).total;

    res.json({ total: totalCount, limit: parseInt(limit, 10) || 50, offset: parseInt(offset, 10) || 0, logs: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/logs/:id', authenticateLeader, (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM traffic_logs WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Log entry not found' });

    let parsedReqHeaders = row.request_headers;
    let parsedResHeaders = row.response_headers;
    try { parsedReqHeaders = JSON.parse(row.request_headers); } catch (_) {}
    try { parsedResHeaders = JSON.parse(row.response_headers); } catch (_) {}

    res.json({ ...row, request_headers: parsedReqHeaders, response_headers: parsedResHeaders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
