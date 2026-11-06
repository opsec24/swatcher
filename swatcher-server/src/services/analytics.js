const db = require('../db');

/**
 * Calculates active testing minutes from an array of timestamps.
 * A 10-minute inactivity threshold is used to separate active bursts from idle gaps.
 */
function calculateActiveMinutes(timestamps, maxGapMinutes = 10, defaultBlockMinutes = 1) {
  if (!timestamps || timestamps.length === 0) return 0;
  if (timestamps.length === 1) return defaultBlockMinutes;

  const times = timestamps
    .map(t => new Date(t).getTime())
    .filter(t => !isNaN(t))
    .sort((a, b) => a - b);

  if (times.length === 0) return 0;
  if (times.length === 1) return defaultBlockMinutes;

  const maxGapMs = maxGapMinutes * 60 * 1000;
  let totalActiveMs = 0;
  let blockStart = times[0];
  let blockLast = times[0];

  for (let i = 1; i < times.length; i++) {
    const diff = times[i] - blockLast;
    if (diff <= maxGapMs) {
      blockLast = times[i];
    } else {
      const blockDuration = blockLast - blockStart;
      totalActiveMs += Math.max(blockDuration, defaultBlockMinutes * 60 * 1000);
      blockStart = times[i];
      blockLast = times[i];
    }
  }

  const lastBlockDuration = blockLast - blockStart;
  totalActiveMs += Math.max(lastBlockDuration, defaultBlockMinutes * 60 * 1000);

  return Math.round(totalActiveMs / (60 * 1000));
}

/**
 * Returns overall leadership metrics.
 */
function getOverview() {
  // 1. Current number of registered active pentesters
  const pentestersCount = db.prepare(`
    SELECT COUNT(*) AS count FROM pentesters WHERE is_active = 1
  `).get().count;

  // 2. Number of pentests currently in progress
  const inProgressCount = db.prepare(`
    SELECT COUNT(*) AS count FROM engagements WHERE status = 'ACTIVE'
  `).get().count;

  // 3. Total number of hours spent for CURRENT MONTH (across all pentests)
  const currentMonthPrefix = new Date().toISOString().slice(0, 7); // e.g. "2026-11"
  const currentMonthTimestamps = db.prepare(`
    SELECT timestamp FROM traffic_logs
    WHERE timestamp LIKE ?
    ORDER BY timestamp ASC
  `).all(`${currentMonthPrefix}%`).map(r => r.timestamp);

  const currentMonthActiveMins = calculateActiveMinutes(currentMonthTimestamps);
  const currentMonthHours = (currentMonthActiveMins / 60).toFixed(1);

  // General traffic stats
  const stats = db.prepare(`
    SELECT
      COUNT(*) AS total_requests,
      COUNT(DISTINCT tester_username) AS total_testers,
      COUNT(DISTINCT ritm) AS total_engagements,
      COUNT(DISTINCT application_id) AS total_applications,
      COUNT(DISTINCT host || path) AS unique_endpoints,
      COALESCE(SUM(duration_ms), 0) AS total_duration_ms
    FROM traffic_logs
  `).get();

  const allTimestamps = db.prepare('SELECT timestamp FROM traffic_logs ORDER BY timestamp ASC').all().map(r => r.timestamp);
  const manualTimestamps = db.prepare("SELECT timestamp FROM traffic_logs WHERE tool IN ('REPEATER', 'PROXY') ORDER BY timestamp ASC").all().map(r => r.timestamp);
  const automatedTimestamps = db.prepare("SELECT timestamp FROM traffic_logs WHERE tool IN ('SCANNER', 'INTRUDER') ORDER BY timestamp ASC").all().map(r => r.timestamp);

  const totalActiveMinutes = calculateActiveMinutes(allTimestamps);
  const manualActiveMinutes = calculateActiveMinutes(manualTimestamps);
  const automatedActiveMinutes = calculateActiveMinutes(automatedTimestamps);

  // Tool distribution
  const tools = db.prepare(`
    SELECT tool, COUNT(*) AS count
    FROM traffic_logs
    GROUP BY tool
    ORDER BY count DESC
  `).all();

  // Status code breakdown
  const statusCodes = db.prepare(`
    SELECT 
      CASE 
        WHEN status_code >= 200 AND status_code < 300 THEN '2xx Success'
        WHEN status_code >= 300 AND status_code < 400 THEN '3xx Redirect'
        WHEN status_code >= 400 AND status_code < 500 THEN '4xx Client Error'
        WHEN status_code >= 500 THEN '5xx Server Error'
        ELSE 'Other'
      END AS status_group,
      COUNT(*) AS count
    FROM traffic_logs
    GROUP BY status_group
  `).all();

  // 4. Calculate pending hours across all active engagements
  const activeEngagements = db.prepare(`
    SELECT ritm, allocated_hours FROM engagements WHERE status = 'ACTIVE'
  `).all();

  let totalPendingMinutes = 0;
  for (const eng of activeEngagements) {
    const engTimestamps = db.prepare(`
      SELECT timestamp FROM traffic_logs WHERE ritm = ? ORDER BY timestamp ASC
    `).all(eng.ritm).map(r => r.timestamp);

    const activeMins = calculateActiveMinutes(engTimestamps);
    const allocatedMins = (eng.allocated_hours || 40) * 60;
    const pendingMins = Math.max(0, allocatedMins - activeMins);
    totalPendingMinutes += pendingMins;
  }
  const totalPendingHours = (totalPendingMinutes / 60).toFixed(1);

  return {
    summary: {
      // The 4 Core Leadership Cards:
      current_pentesters: pentestersCount || 0,
      pentests_in_progress: inProgressCount || 0,
      hours_current_month: currentMonthHours,
      total_pending_hours: totalPendingHours,

      // Supporting Metrics
      total_requests: stats.total_requests || 0,
      total_engagements: stats.total_engagements || 0,
      total_applications: stats.total_applications || 0,
      unique_endpoints: stats.unique_endpoints || 0,
      total_active_hours: (totalActiveMinutes / 60).toFixed(1),
      manual_active_hours: (manualActiveMinutes / 60).toFixed(1),
      automated_active_hours: (automatedActiveMinutes / 60).toFixed(1)
    },
    tools,
    status_codes: statusCodes
  };
}

/**
 * Returns metrics per engagement (RITM) with Effort & Pending Hours.
 */
function getEngagementMetrics() {
  const engagements = db.prepare(`
    SELECT 
      id,
      ritm,
      application_id,
      client_name,
      allocated_hours,
      status,
      created_at
    FROM engagements
    ORDER BY created_at DESC
  `).all();

  return engagements.map(eng => {
    const timestamps = db.prepare(`
      SELECT timestamp FROM traffic_logs
      WHERE ritm = ?
      ORDER BY timestamp ASC
    `).all(eng.ritm).map(r => r.timestamp);

    const manualTimestamps = db.prepare(`
      SELECT timestamp FROM traffic_logs
      WHERE ritm = ? AND tool IN ('REPEATER', 'PROXY')
      ORDER BY timestamp ASC
    `).all(eng.ritm).map(r => r.timestamp);

    const automatedTimestamps = db.prepare(`
      SELECT timestamp FROM traffic_logs
      WHERE ritm = ? AND tool IN ('SCANNER', 'INTRUDER')
      ORDER BY timestamp ASC
    `).all(eng.ritm).map(r => r.timestamp);

    const activeMins = calculateActiveMinutes(timestamps);
    const manualMins = calculateActiveMinutes(manualTimestamps);
    const autoMins = calculateActiveMinutes(automatedTimestamps);

    const stats = db.prepare(`
      SELECT 
        COUNT(*) AS total_requests,
        COUNT(DISTINCT host || path) AS unique_endpoints,
        MIN(timestamp) AS started_at,
        MAX(timestamp) AS last_activity_at
      FROM traffic_logs
      WHERE ritm = ?
    `).get(eng.ritm);

    const testers = db.prepare(`
      SELECT DISTINCT tester_username FROM traffic_logs WHERE ritm = ?
    `).all(eng.ritm).map(t => t.tester_username);

    const activeHours = Number((activeMins / 60).toFixed(1));
    const manualHours = Number((manualMins / 60).toFixed(1));
    const autoHours = Number((autoMins / 60).toFixed(1));
    const allocated = Number(eng.allocated_hours || 40.0);
    const pendingHours = Math.max(0, allocated - activeHours).toFixed(1);

    const completionPct = allocated > 0 ? Math.round((activeHours / allocated) * 100) : 0;

    let progressStatus = 'IN_PROGRESS';
    if (completionPct >= 100) {
      progressStatus = completionPct > 105 ? 'OVER_BUDGET' : 'ON_TARGET';
    } else if (completionPct >= 85) {
      progressStatus = 'ON_TARGET';
    }

    return {
      id: eng.id,
      ritm: eng.ritm,
      application_id: eng.application_id,
      client_name: eng.client_name,
      allocated_hours: allocated,
      active_hours: activeHours,
      pending_hours: pendingHours,
      manual_hours: manualHours,
      automated_hours: autoHours,
      completion_percentage: completionPct,
      progress_status: progressStatus,
      status: eng.status,
      total_requests: stats.total_requests || 0,
      testers,
      unique_endpoints: stats.unique_endpoints || 0,
      started_at: stats.started_at || eng.created_at,
      last_activity_at: stats.last_activity_at || eng.created_at
    };
  });
}

/**
 * Returns single engagement deep-dive detail.
 */
function getEngagementDetail(ritm) {
  const eng = db.prepare('SELECT * FROM engagements WHERE ritm = ?').get(ritm.toUpperCase());
  if (!eng) return null;

  const timestamps = db.prepare('SELECT timestamp FROM traffic_logs WHERE ritm = ? ORDER BY timestamp ASC').all(eng.ritm).map(r => r.timestamp);
  const manualTimestamps = db.prepare("SELECT timestamp FROM traffic_logs WHERE ritm = ? AND tool IN ('REPEATER', 'PROXY') ORDER BY timestamp ASC").all(eng.ritm).map(r => r.timestamp);
  const autoTimestamps = db.prepare("SELECT timestamp FROM traffic_logs WHERE ritm = ? AND tool IN ('SCANNER', 'INTRUDER') ORDER BY timestamp ASC").all(eng.ritm).map(r => r.timestamp);

  const activeMins = calculateActiveMinutes(timestamps);
  const manualMins = calculateActiveMinutes(manualTimestamps);
  const autoMins = calculateActiveMinutes(autoTimestamps);

  const activeHours = Number((activeMins / 60).toFixed(1));
  const allocated = Number(eng.allocated_hours || 40.0);
  const pendingHours = Math.max(0, allocated - activeHours).toFixed(1);
  const completionPct = allocated > 0 ? Math.round((activeHours / allocated) * 100) : 0;

  // Breakdown by tester on this engagement
  const testerStats = db.prepare(`
    SELECT tester_username, COUNT(*) as request_count, MIN(timestamp) as first_seen, MAX(timestamp) as last_seen
    FROM traffic_logs
    WHERE ritm = ?
    GROUP BY tester_username
  `).all(eng.ritm).map(ts => {
    const tTimes = db.prepare('SELECT timestamp FROM traffic_logs WHERE ritm = ? AND tester_username = ? ORDER BY timestamp ASC').all(eng.ritm, ts.tester_username).map(r => r.timestamp);
    const tActiveMins = calculateActiveMinutes(tTimes);
    return {
      username: ts.tester_username,
      request_count: ts.request_count,
      active_hours: (tActiveMins / 60).toFixed(1),
      first_seen: ts.first_seen,
      last_seen: ts.last_seen
    };
  });

  // Unique endpoints on this engagement
  const endpoints = db.prepare(`
    SELECT method, host, path, status_code, COUNT(*) as hits, MAX(timestamp) as last_hit
    FROM traffic_logs
    WHERE ritm = ?
    GROUP BY method, host, path
    ORDER BY hits DESC
    LIMIT 100
  `).all(eng.ritm);

  // Tools breakdown for this engagement
  const tools = db.prepare(`
    SELECT tool, COUNT(*) as count FROM traffic_logs WHERE ritm = ? GROUP BY tool
  `).all(eng.ritm);

  return {
    engagement: {
      id: eng.id,
      ritm: eng.ritm,
      application_id: eng.application_id,
      client_name: eng.client_name,
      allocated_hours: allocated,
      active_hours: activeHours,
      pending_hours: pendingHours,
      manual_hours: (manualMins / 60).toFixed(1),
      automated_hours: (autoMins / 60).toFixed(1),
      completion_percentage: completionPct,
      status: eng.status,
      created_at: eng.created_at
    },
    testers: testerStats,
    tools,
    endpoints
  };
}

module.exports = {
  calculateActiveMinutes,
  getOverview,
  getEngagementMetrics,
  getEngagementDetail
};
