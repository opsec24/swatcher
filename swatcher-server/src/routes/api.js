const express = require('express');
const crypto = require('node:crypto');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const {
  validatePasswordComplexity,
  hasAnyLeadershipUsers,
  createLeadershipUser,
  verifyLeadershipUser,
  unlockLeadershipUser,
  createSession,
  validateSession,
  endSession,
  recordAuditLog
} = require('../services/auth');
const { getOverview, getEngagementMetrics, getEngagementDetail } = require('../services/analytics');

const router = express.Router();

// Rate limiters for authentication endpoints
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts from this IP. Please try again in 15 minutes.' }
});

const verifyKeyLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many key verification requests. Please slow down.' }
});

const setupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many setup attempts from this IP.' }
});

function getClientIp(req) {
  return req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1';
}

/**
 * ==========================================================
 * LEADERSHIP DASHBOARD AUTHENTICATION MIDDLEWARE
 * ==========================================================
 */
async function authenticateLeader(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    let token = req.headers['x-session-token'] || '';
    if (!token && authHeader.startsWith('Bearer sw_sess_')) {
      token = authHeader.slice(7).trim();
    }

    const session = await validateSession(token);
    if (!session) {
      return res.status(401).json({ error: 'Authentication required. Please log in.' });
    }

    req.leader = session;
    next();
  } catch (err) {
    res.status(500).json({ error: 'Session validation error: ' + err.message });
  }
}

/**
 * ==========================================================
 * BURP PLUGIN INGESTION AUTHENTICATION MIDDLEWARE
 * ==========================================================
 */
async function authenticateIngestion(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    let token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
    if (!token && req.headers['x-api-key']) {
      token = String(req.headers['x-api-key']).trim();
    }

    if (!token) {
      return res.status(401).json({ error: 'Missing API Token. Please configure your Swatcher API Key in Burp Suite.' });
    }

    const tester = await db.get('SELECT id, username, full_name, is_active FROM pentesters WHERE api_key = ?', [token]);
    if (!tester) {
      return res.status(401).json({ error: 'Invalid API Token. Token not recognized.' });
    }
    if (!tester.is_active) {
      return res.status(403).json({ error: 'Pentester account deactivated.' });
    }

    const now = new Date().toISOString();
    await db.run('UPDATE pentesters SET last_active_at = ? WHERE id = ?', [now, tester.id]);

    req.pentester = tester;
    next();
  } catch (err) {
    res.status(500).json({ error: 'Ingestion auth error: ' + err.message });
  }
}

/**
 * ==========================================================
 * 1. AUTH & SETUP ENDPOINTS
 * ==========================================================
 */
router.get('/auth/status', async (req, res) => {
  try {
    const hasUsers = await hasAnyLeadershipUsers();
    const token = req.headers['x-session-token'] || (req.headers.authorization?.startsWith('Bearer sw_sess_') ? req.headers.authorization.slice(7) : null);
    const session = await validateSession(token);

    res.json({
      setupRequired: !hasUsers,
      authenticated: Boolean(session),
      user: session ? { username: session.username, full_name: session.fullName, role: session.role } : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/auth/verify-key', verifyKeyLimiter, async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    let token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
    if (!token && req.body?.api_key) {
      token = String(req.body.api_key).trim();
    }

    if (!token) {
      return res.status(401).json({ valid: false, error: 'API token is required.' });
    }

    const tester = await db.get('SELECT id, username, full_name, email, is_active FROM pentesters WHERE api_key = ?', [token]);

    if (!tester) {
      return res.status(401).json({ valid: false, error: 'API Key not recognized by swatcher server.' });
    }
    if (!tester.is_active) {
      return res.status(403).json({ valid: false, error: 'This pentester account has been deactivated by leadership.' });
    }

    const now = new Date().toISOString();
    await db.run('UPDATE pentesters SET last_active_at = ? WHERE id = ?', [now, tester.id]);

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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/auth/setup', setupLimiter, async (req, res) => {
  try {
    const hasUsers = await hasAnyLeadershipUsers();
    if (hasUsers) {
      return res.status(403).json({ error: 'Setup is already completed. Please log in.' });
    }

    const { username, full_name, email, password } = req.body;
    if (!username || !password || !full_name) {
      return res.status(400).json({ error: 'Username, full name, and password are required.' });
    }

    const user = await createLeadershipUser(username, full_name, email, password);
    const ip = getClientIp(req);
    const token = await createSession(user.id, user.username, ip, req.headers['user-agent']);

    await recordAuditLog({
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

router.post('/auth/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    const ip = getClientIp(req);

    const result = await verifyLeadershipUser(username, password);
    if (!result.user) {
      await recordAuditLog({
        actionType: result.reason === 'ACCOUNT_LOCKED' ? 'ACCOUNT_LOCKED' : 'FAILED_LOGIN_ATTEMPT',
        username: username || 'UNKNOWN',
        description: result.message || `Failed login attempt for username '${username}'`,
        ip
      });
      return res.status(401).json({ error: result.message || 'Invalid username or password.' });
    }

    const user = result.user;
    const token = await createSession(user.id, user.username, ip, req.headers['user-agent']);

    await recordAuditLog({
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/auth/logout', authenticateLeader, async (req, res) => {
  try {
    await endSession(req.leader.sessionId);
    await recordAuditLog({
      sessionId: req.leader.sessionId,
      userId: req.leader.userId,
      username: req.leader.username,
      actionType: 'USER_LOGOUT',
      description: `Leadership user ${req.leader.username} logged out (Session duration: ${req.leader.durationSeconds}s)`,
      details: { duration_seconds: req.leader.durationSeconds },
      ip: getClientIp(req)
    });
    res.json({ status: 'OK' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/auth/users', authenticateLeader, async (req, res) => {
  const { username, full_name, email, password } = req.body;
  if (!username || !password || !full_name) {
    return res.status(400).json({ error: 'Username, full name, and password are required.' });
  }

  try {
    const user = await createLeadershipUser(username, full_name, email, password);
    await recordAuditLog({
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

router.get('/auth/users', authenticateLeader, async (req, res) => {
  try {
    const users = await db.all('SELECT id, username, full_name, email, role, is_active, is_locked, locked_at, failed_login_attempts, created_at, last_login_at FROM leadership_users ORDER BY created_at DESC');
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Any authenticated leader can unlock a locked leadership account
router.post('/auth/users/:id/unlock', authenticateLeader, async (req, res) => {
  try {
    const user = await unlockLeadershipUser(req.params.id);
    const ip = getClientIp(req);

    await recordAuditLog({
      sessionId: req.leader.sessionId,
      userId: req.leader.userId,
      username: req.leader.username,
      actionType: 'UNLOCK_USER',
      targetId: user.id,
      targetName: user.username,
      description: `Administrator ${req.leader.username} unlocked account for ${user.username}`,
      details: { unlocked_user: user.username, full_name: user.full_name },
      ip
    });

    res.json({
      status: 'OK',
      message: `Account for '${user.username}' has been successfully unlocked.`,
      user
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * ==========================================================
 * 2. COMPREHENSIVE AUDIT TRAIL ENDPOINTS
 * ==========================================================
 */
router.get('/audit-logs', authenticateLeader, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const logs = await db.all(`
      SELECT a.*, s.duration_seconds
      FROM audit_logs a
      LEFT JOIN leadership_sessions s ON a.session_id = s.id
      ORDER BY a.created_at DESC
      LIMIT ?
    `, [limit]);

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
router.get('/analytics/overview', authenticateLeader, async (req, res) => {
  try {
    const data = await getOverview();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/analytics/engagements', authenticateLeader, async (req, res) => {
  try {
    const data = await getEngagementMetrics();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/analytics/engagements/:ritm', authenticateLeader, async (req, res) => {
  try {
    const detail = await getEngagementDetail(req.params.ritm);
    if (!detail) return res.status(404).json({ error: 'Engagement not found' });
    res.json(detail);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/engagements/:ritm', authenticateLeader, async (req, res) => {
  try {
    const ritm = String(req.params.ritm).trim().toUpperCase();
    const eng = await db.get('SELECT * FROM engagements WHERE ritm = ?', [ritm]);
    if (!eng) return res.status(404).json({ error: 'Engagement not found' });

    const logCountRow = await db.get('SELECT COUNT(*) as count FROM traffic_logs WHERE ritm = ?', [ritm]);
    const logCount = logCountRow ? parseInt(logCountRow.count, 10) : 0;

    await db.run('DELETE FROM traffic_logs WHERE ritm = ?', [ritm]);
    await db.run('DELETE FROM sessions WHERE ritm = ?', [ritm]);
    await db.run('DELETE FROM engagements WHERE ritm = ?', [ritm]);

    await recordAuditLog({
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/engagements/batch-delete', authenticateLeader, async (req, res) => {
  try {
    const { ritms } = req.body;
    if (!Array.isArray(ritms) || ritms.length === 0) {
      return res.status(400).json({ error: 'ritms array is required' });
    }

    let deletedCount = 0;
    let totalPurgedLogs = 0;

    for (const rawRitm of ritms) {
      const ritm = String(rawRitm).trim().toUpperCase();
      const countRow = await db.get('SELECT COUNT(*) as count FROM traffic_logs WHERE ritm = ?', [ritm]);
      const count = countRow ? parseInt(countRow.count, 10) : 0;

      await db.run('DELETE FROM traffic_logs WHERE ritm = ?', [ritm]);
      await db.run('DELETE FROM sessions WHERE ritm = ?', [ritm]);
      await db.run('DELETE FROM engagements WHERE ritm = ?', [ritm]);
      deletedCount++;
      totalPurgedLogs += count;
    }

    await recordAuditLog({
      sessionId: req.leader.sessionId,
      userId: req.leader.userId,
      username: req.leader.username,
      actionType: 'BATCH_DELETE_RITMS',
      description: `Batch deleted ${deletedCount} engagements (${ritms.join(', ')})`,
      details: { ritms, deletedCount, totalPurgedLogs },
      ip: getClientIp(req)
    });

    res.json({ status: 'OK', deletedCount, totalPurgedLogs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * ==========================================================
 * 4. PENTESTER PROFILE MANAGEMENT & DELETION
 * ==========================================================
 */
router.get('/pentesters', authenticateLeader, async (req, res) => {
  try {
    const rows = await db.all('SELECT id, username, full_name, email, api_key, is_active, created_at, last_active_at FROM pentesters ORDER BY created_at DESC');

    const enriched = [];
    for (const p of rows) {
      const stats = await db.get('SELECT COUNT(*) AS total_requests, COUNT(DISTINCT ritm) AS total_engagements FROM traffic_logs WHERE tester_username = ?', [p.username]);
      enriched.push({
        ...p,
        is_active: Boolean(p.is_active),
        total_requests: parseInt(stats?.total_requests || 0, 10),
        total_engagements: parseInt(stats?.total_engagements || 0, 10)
      });
    }

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/pentesters', authenticateLeader, async (req, res) => {
  try {
    const { username, full_name, email } = req.body;
    if (!username || !full_name) {
      return res.status(400).json({ error: 'username and full_name are required' });
    }

    const cleanUsername = String(username).trim().toLowerCase();
    const cleanName = String(full_name).trim();
    const cleanEmail = String(email || '').trim().toLowerCase();

    const existing = await db.get('SELECT id FROM pentesters WHERE username = ?', [cleanUsername]);
    if (existing) {
      return res.status(409).json({ error: `Pentester with username '${cleanUsername}' already exists.` });
    }

    const id = `usr_${crypto.randomUUID().slice(0, 8)}`;
    const apiKey = `sw_live_${crypto.randomBytes(24).toString('hex')}`;
    const now = new Date().toISOString();

    await db.run(`
      INSERT INTO pentesters (id, username, full_name, email, api_key, is_active, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `, [id, cleanUsername, cleanName, cleanEmail, apiKey, now]);

    await recordAuditLog({
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/pentesters/:id', authenticateLeader, async (req, res) => {
  try {
    const tester = await db.get('SELECT * FROM pentesters WHERE id = ?', [req.params.id]);
    if (!tester) return res.status(404).json({ error: 'Pentester not found' });

    await db.run('DELETE FROM pentesters WHERE id = ?', [req.params.id]);

    await recordAuditLog({
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/pentesters/batch-delete', authenticateLeader, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array is required' });
    }

    let deletedCount = 0;
    for (const id of ids) {
      await db.run('DELETE FROM pentesters WHERE id = ?', [id]);
      deletedCount++;
    }

    await recordAuditLog({
      sessionId: req.leader.sessionId,
      userId: req.leader.userId,
      username: req.leader.username,
      actionType: 'BATCH_DELETE_PENTESTERS',
      description: `Batch deleted ${deletedCount} pentesters`,
      details: { ids },
      ip: getClientIp(req)
    });

    res.json({ status: 'OK', deletedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/pentesters/:id/toggle', authenticateLeader, async (req, res) => {
  try {
    const tester = await db.get('SELECT * FROM pentesters WHERE id = ?', [req.params.id]);
    if (!tester) return res.status(404).json({ error: 'Pentester not found' });

    const newStatus = tester.is_active ? 0 : 1;
    await db.run('UPDATE pentesters SET is_active = ? WHERE id = ?', [newStatus, tester.id]);

    await recordAuditLog({
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/pentesters/:id/regenerate-key', authenticateLeader, async (req, res) => {
  try {
    const tester = await db.get('SELECT * FROM pentesters WHERE id = ?', [req.params.id]);
    if (!tester) return res.status(404).json({ error: 'Pentester not found' });

    const newApiKey = `sw_live_${crypto.randomBytes(24).toString('hex')}`;
    await db.run('UPDATE pentesters SET api_key = ? WHERE id = ?', [newApiKey, tester.id]);

    await recordAuditLog({
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * ==========================================================
 * 5. BURP PLUGIN INGESTION & SESSIONS
 * ==========================================================
 */
router.post('/sessions/verify', authenticateIngestion, async (req, res) => {
  try {
    const { ritm, application_id, tester_machine, client_name, allocated_hours } = req.body;
    if (!ritm || !application_id) {
      return res.status(400).json({ error: 'ritm and application_id are required' });
    }

    const cleanRitm = String(ritm).trim().toUpperCase();
    const cleanAppId = String(application_id).trim().toUpperCase();
    const effortHours = parseFloat(allocated_hours) || 40.0;
    const now = new Date().toISOString();

    let existingEng = await db.get('SELECT * FROM engagements WHERE ritm = ?', [cleanRitm]);

    if (!existingEng) {
      const engagementId = `eng_${cleanRitm}_${Date.now()}`;
      await db.run('INSERT INTO engagements (id, ritm, application_id, client_name, allocated_hours, status, created_at) VALUES (?, ?, ?, ?, ?, \'ACTIVE\', ?)', [
        engagementId, cleanRitm, cleanAppId, client_name || '', effortHours, now
      ]);
      existingEng = { id: engagementId, ritm: cleanRitm, application_id: cleanAppId, allocated_hours: effortHours };
    } else {
      if ((!existingEng.allocated_hours || existingEng.allocated_hours <= 0) && effortHours > 0) {
        await db.run('UPDATE engagements SET allocated_hours = ? WHERE id = ?', [effortHours, existingEng.id]);
        existingEng.allocated_hours = effortHours;
      }
    }

    const sessionId = `sess_${cleanRitm}_${req.pentester.username}_${Date.now()}`;
    await db.run(`
      INSERT INTO sessions (id, ritm, application_id, tester_id, tester_username, tester_machine, started_at, last_active_at, request_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    `, [sessionId, cleanRitm, existingEng.application_id, req.pentester.id, req.pentester.username, tester_machine || '', now, now]);

    res.json({
      status: 'OK',
      session_id: sessionId,
      ritm: cleanRitm,
      application_id: existingEng.application_id,
      allocated_hours: existingEng.allocated_hours,
      tester: req.pentester.username
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/ingest/batch', authenticateIngestion, async (req, res) => {
  try {
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

      let engRecord = await db.get('SELECT * FROM engagements WHERE ritm = ?', [itemRitm]);
      if (!engRecord && itemRitm !== 'UNKNOWN') {
        const engId = `eng_${itemRitm}_${Date.now()}`;
        try {
          await db.run('INSERT INTO engagements (id, ritm, application_id, client_name, allocated_hours, status, created_at) VALUES (?, ?, ?, \'\', ?, \'ACTIVE\', ?)', [
            engId, itemRitm, itemAppId, effortHours, now
          ]);
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
        await db.run(`
          INSERT OR IGNORE INTO traffic_logs (
            event_id, session_id, ritm, application_id, tester_id, tester_username, tester_machine,
            tool, timestamp, method, url, host, port, path, query,
            request_headers, request_body, request_body_length,
            status_code, response_headers, response_body, response_body_length,
            duration_ms, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          eventId, itemSessionId, itemRitm, resolvedAppId, req.pentester.id, req.pentester.username, machineName,
          tool, timestamp, method, url, host, port, path, query,
          reqHeadersStr, reqBody, reqBodyLen,
          statusCode, resHeadersStr, resBody, resBodyLen,
          durationMs, now
        ]);
        ingested++;
      } catch (err) {
        console.error('[swatcher-server] Failed to insert log entry:', err.message);
      }
    }

    res.json({
      status: 'OK',
      received: batch.length,
      ingested,
      tester: req.pentester.username,
      timestamp: now
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * ==========================================================
 * 6. LOGS EXPLORER (Leadership only)
 * ==========================================================
 */
router.get('/logs', authenticateLeader, async (req, res) => {
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

    const rows = await db.all(query, params);

    let countQuery = 'SELECT COUNT(*) AS total FROM traffic_logs WHERE 1=1';
    const countParams = params.slice(0, params.length - 2);
    if (ritm) countQuery += ' AND ritm = ?';
    if (tool) countQuery += ' AND tool = ?';
    if (tester) countQuery += ' AND tester_username = ?';
    if (method) countQuery += ' AND method = ?';
    if (status_code) countQuery += ' AND status_code = ?';
    if (search) countQuery += ' AND (url LIKE ? OR path LIKE ?)';

    const totalRow = await db.get(countQuery, countParams);
    const totalCount = totalRow ? parseInt(totalRow.total, 10) : 0;

    res.json({ total: totalCount, limit: parseInt(limit, 10) || 50, offset: parseInt(offset, 10) || 0, logs: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/logs/:id', authenticateLeader, async (req, res) => {
  try {
    const row = await db.get('SELECT * FROM traffic_logs WHERE id = ?', [req.params.id]);
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
