const db = require('../db');

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

async function getOverview() {
  const pentestersRow = await db.get('SELECT COUNT(*) AS count FROM pentesters WHERE is_active = 1');
  const pentestersCount = pentestersRow ? parseInt(pentestersRow.count, 10) : 0;

  const inProgressRow = await db.get("SELECT COUNT(*) AS count FROM engagements WHERE status = 'ACTIVE'");
  const inProgressCount = inProgressRow ? parseInt(inProgressRow.count, 10) : 0;

  const currentMonthPrefix = new Date().toISOString().slice(0, 7);
  const currentMonthRows = await db.all('SELECT timestamp FROM traffic_logs WHERE timestamp LIKE ? ORDER BY timestamp ASC', [`${currentMonthPrefix}%`]);
  const currentMonthTimestamps = currentMonthRows.map(r => r.timestamp);

  const currentMonthActiveMins = calculateActiveMinutes(currentMonthTimestamps);
  const currentMonthHours = (currentMonthActiveMins / 60).toFixed(1);

  const stats = (await db.get(`
    SELECT
      COUNT(*) AS total_requests,
      COUNT(DISTINCT tester_username) AS total_testers,
      COUNT(DISTINCT ritm) AS total_engagements,
      COUNT(DISTINCT application_id) AS total_applications,
      COUNT(DISTINCT host || path) AS unique_endpoints,
      COALESCE(SUM(duration_ms), 0) AS total_duration_ms
    FROM traffic_logs
  `)) || {};

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const allRows = await db.all('SELECT timestamp FROM traffic_logs WHERE timestamp >= ? ORDER BY timestamp ASC', [thirtyDaysAgo]);
  const manualRows = await db.all("SELECT timestamp FROM traffic_logs WHERE tool IN ('REPEATER', 'PROXY') AND timestamp >= ? ORDER BY timestamp ASC", [thirtyDaysAgo]);
  const autoRows = await db.all("SELECT timestamp FROM traffic_logs WHERE tool IN ('SCANNER', 'INTRUDER') AND timestamp >= ? ORDER BY timestamp ASC", [thirtyDaysAgo]);

  const totalActiveMinutes = calculateActiveMinutes(allRows.map(r => r.timestamp));
  const manualActiveMinutes = calculateActiveMinutes(manualRows.map(r => r.timestamp));
  const automatedActiveMinutes = calculateActiveMinutes(autoRows.map(r => r.timestamp));

  const tools = await db.all(`
    SELECT tool, COUNT(*) AS count
    FROM traffic_logs
    GROUP BY tool
    ORDER BY count DESC
  `);

  const statusCodes = await db.all(`
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
  `);

  const activeEngagements = await db.all("SELECT ritm, allocated_hours FROM engagements WHERE status = 'ACTIVE'");
  let totalPendingMinutes = 0;
  for (const eng of activeEngagements) {
    const engRows = await db.all('SELECT timestamp FROM traffic_logs WHERE ritm = ? ORDER BY timestamp ASC', [eng.ritm]);
    const activeMins = calculateActiveMinutes(engRows.map(r => r.timestamp));
    const allocatedMins = (eng.allocated_hours || 40) * 60;
    const pendingMins = Math.max(0, allocatedMins - activeMins);
    totalPendingMinutes += pendingMins;
  }
  const totalPendingHours = (totalPendingMinutes / 60).toFixed(1);

  return {
    summary: {
      current_pentesters: pentestersCount,
      pentests_in_progress: inProgressCount,
      hours_current_month: currentMonthHours,
      total_pending_hours: totalPendingHours,
      total_requests: parseInt(stats.total_requests || 0, 10),
      total_engagements: parseInt(stats.total_engagements || 0, 10),
      total_applications: parseInt(stats.total_applications || 0, 10),
      unique_endpoints: parseInt(stats.unique_endpoints || 0, 10),
      total_active_hours: (totalActiveMinutes / 60).toFixed(1),
      manual_active_hours: (manualActiveMinutes / 60).toFixed(1),
      automated_active_hours: (automatedActiveMinutes / 60).toFixed(1)
    },
    tools,
    status_codes: statusCodes
  };
}

async function getEngagementMetrics() {
  const engagements = await db.all('SELECT id, ritm, application_id, client_name, allocated_hours, status, created_at FROM engagements ORDER BY created_at DESC');

  const results = [];
  for (const eng of engagements) {
    const rows = await db.all('SELECT timestamp, tool FROM traffic_logs WHERE ritm = ? ORDER BY timestamp ASC', [eng.ritm]);
    const allTimestamps = rows.map(r => r.timestamp);
    const manualTimestamps = rows.filter(r => r.tool === 'REPEATER' || r.tool === 'PROXY').map(r => r.timestamp);
    const autoTimestamps = rows.filter(r => r.tool === 'SCANNER' || r.tool === 'INTRUDER').map(r => r.timestamp);

    const activeMins = calculateActiveMinutes(allTimestamps);
    const manualMins = calculateActiveMinutes(manualTimestamps);
    const autoMins = calculateActiveMinutes(autoTimestamps);

    const stats = (await db.get(`
      SELECT 
        COUNT(*) AS total_requests,
        COUNT(DISTINCT host || path) AS unique_endpoints,
        MIN(timestamp) AS started_at,
        MAX(timestamp) AS last_activity_at
      FROM traffic_logs
      WHERE ritm = ?
    `, [eng.ritm])) || {};

    const testerRows = await db.all('SELECT DISTINCT tester_username FROM traffic_logs WHERE ritm = ?', [eng.ritm]);
    const testers = testerRows.map(t => t.tester_username);

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

    results.push({
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
      total_requests: parseInt(stats.total_requests || 0, 10),
      testers,
      unique_endpoints: parseInt(stats.unique_endpoints || 0, 10),
      started_at: stats.started_at || eng.created_at,
      last_activity_at: stats.last_activity_at || eng.created_at
    });
  }

  return results;
}

async function getEngagementDetail(ritm) {
  const eng = await db.get('SELECT * FROM engagements WHERE ritm = ?', [ritm.toUpperCase()]);
  if (!eng) return null;

  const rows = await db.all('SELECT timestamp, tool FROM traffic_logs WHERE ritm = ? ORDER BY timestamp ASC', [eng.ritm]);
  const timestamps = rows.map(r => r.timestamp);
  const manualTimestamps = rows.filter(r => r.tool === 'REPEATER' || r.tool === 'PROXY').map(r => r.timestamp);
  const autoTimestamps = rows.filter(r => r.tool === 'SCANNER' || r.tool === 'INTRUDER').map(r => r.timestamp);

  const activeMins = calculateActiveMinutes(timestamps);
  const manualMins = calculateActiveMinutes(manualTimestamps);
  const autoMins = calculateActiveMinutes(autoTimestamps);

  const activeHours = Number((activeMins / 60).toFixed(1));
  const allocated = Number(eng.allocated_hours || 40.0);
  const pendingHours = Math.max(0, allocated - activeHours).toFixed(1);
  const completionPct = allocated > 0 ? Math.round((activeHours / allocated) * 100) : 0;

  const testerSummaryRows = await db.all(`
    SELECT tester_username, COUNT(*) as request_count, MIN(timestamp) as first_seen, MAX(timestamp) as last_seen
    FROM traffic_logs
    WHERE ritm = ?
    GROUP BY tester_username
  `, [eng.ritm]);

  const testerStats = [];
  for (const ts of testerSummaryRows) {
    const tRows = await db.all('SELECT timestamp FROM traffic_logs WHERE ritm = ? AND tester_username = ? ORDER BY timestamp ASC', [eng.ritm, ts.tester_username]);
    const tActiveMins = calculateActiveMinutes(tRows.map(r => r.timestamp));
    testerStats.push({
      username: ts.tester_username,
      request_count: parseInt(ts.request_count, 10),
      active_hours: (tActiveMins / 60).toFixed(1),
      first_seen: ts.first_seen,
      last_seen: ts.last_seen
    });
  }

  const endpoints = await db.all(`
    SELECT method, host, path, status_code, COUNT(*) as hits, MAX(timestamp) as last_hit
    FROM traffic_logs
    WHERE ritm = ?
    GROUP BY method, host, path, status_code
    ORDER BY hits DESC
    LIMIT 100
  `, [eng.ritm]);

  const tools = await db.all(`
    SELECT tool, COUNT(*) as count FROM traffic_logs WHERE ritm = ? GROUP BY tool
  `, [eng.ritm]);

  const latestLog = await db.get(`
    SELECT MAX(timestamp) as last_collected_at
    FROM traffic_logs
    WHERE ritm = ?
  `, [eng.ritm]);

  const dailyTimeline = await db.all(`
    SELECT SUBSTR(timestamp, 1, 10) as log_date, COUNT(*) as request_count
    FROM traffic_logs
    WHERE ritm = ?
    GROUP BY SUBSTR(timestamp, 1, 10)
    ORDER BY log_date ASC
  `, [eng.ritm]);

  const hourlyTimeline = await db.all(`
    SELECT SUBSTR(timestamp, 1, 13) as log_hour, COUNT(*) as request_count
    FROM traffic_logs
    WHERE ritm = ?
    GROUP BY SUBSTR(timestamp, 1, 13)
    ORDER BY log_hour ASC
  `, [eng.ritm]);

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
      created_at: eng.created_at,
      last_collected_at: latestLog?.last_collected_at || eng.created_at
    },
    testers: testerStats,
    tools,
    endpoints,
    timeline: {
      daily: dailyTimeline.map(d => ({ date: d.log_date, count: parseInt(d.request_count, 10) })),
      hourly: hourlyTimeline.map(h => ({ hour: h.log_hour, count: parseInt(h.request_count, 10) })),
      last_collected_at: latestLog?.last_collected_at || null
    }
  };
}

module.exports = {
  calculateActiveMinutes,
  getOverview,
  getEngagementMetrics,
  getEngagementDetail
};
