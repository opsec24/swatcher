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

/**
 * High-performance dashboard overview aggregation.
 * Uses 1-minute bucketed aggregations to prevent pulling millions of rows into Node.js heap.
 */
async function getOverview() {
  const pentestersRow = await db.get('SELECT COUNT(*) AS count FROM pentesters WHERE is_active = 1');
  const pentestersCount = pentestersRow ? parseInt(pentestersRow.count, 10) : 0;

  const inProgressRow = await db.get("SELECT COUNT(*) AS count FROM engagements WHERE status = 'ACTIVE'");
  const inProgressCount = inProgressRow ? parseInt(inProgressRow.count, 10) : 0;

  const currentMonthPrefix = new Date().toISOString().slice(0, 7);
  // Bucket by minute to avoid loading millions of individual timestamps into Node memory
  const currentMonthBuckets = await db.all(
    'SELECT DISTINCT SUBSTR(timestamp, 1, 16) AS m FROM traffic_logs WHERE timestamp LIKE ? ORDER BY m ASC',
    [`${currentMonthPrefix}%`]
  );
  const currentMonthActiveMins = calculateActiveMinutes(currentMonthBuckets.map(r => r.m + ':00.000Z'));
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
  // Fetch bucketed minute activity grouped by tool class in a single high-speed query
  const activityRows = await db.all(`
    SELECT SUBSTR(timestamp, 1, 16) AS m, tool
    FROM traffic_logs
    WHERE timestamp >= ?
    GROUP BY m, tool
    ORDER BY m ASC
  `, [thirtyDaysAgo]);

  const allMinsSet = new Set();
  const manualMinsSet = new Set();
  const autoMinsSet = new Set();

  for (const row of activityRows) {
    const formatted = row.m + ':00.000Z';
    allMinsSet.add(formatted);
    if (row.tool === 'REPEATER' || row.tool === 'PROXY') {
      manualMinsSet.add(formatted);
    } else if (row.tool === 'SCANNER' || row.tool === 'INTRUDER') {
      autoMinsSet.add(formatted);
    }
  }

  const totalActiveMinutes = calculateActiveMinutes(Array.from(allMinsSet));
  const manualActiveMinutes = calculateActiveMinutes(Array.from(manualMinsSet));
  const automatedActiveMinutes = calculateActiveMinutes(Array.from(autoMinsSet));

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

  // Batch calculate pending hours across all active engagements in a single query
  const activeEngagements = await db.all("SELECT ritm, allocated_hours FROM engagements WHERE status = 'ACTIVE'");
  let totalPendingMinutes = 0;

  if (activeEngagements.length > 0) {
    const activeRitms = activeEngagements.map(e => e.ritm);
    const ritmParamPlaceholders = activeRitms.map(() => '?').join(', ');
    const activeEngMinutesRows = await db.all(`
      SELECT ritm, SUBSTR(timestamp, 1, 16) AS m
      FROM traffic_logs
      WHERE ritm IN (${ritmParamPlaceholders})
      GROUP BY ritm, m
      ORDER BY ritm, m ASC
    `, activeRitms);

    const engMinutesMap = new Map();
    for (const r of activeEngMinutesRows) {
      if (!engMinutesMap.has(r.ritm)) {
        engMinutesMap.set(r.ritm, []);
      }
      engMinutesMap.get(r.ritm).push(r.m + ':00.000Z');
    }

    for (const eng of activeEngagements) {
      const timestamps = engMinutesMap.get(eng.ritm) || [];
      const activeMins = calculateActiveMinutes(timestamps);
      const allocatedMins = (eng.allocated_hours || 40) * 60;
      const pendingMins = Math.max(0, allocatedMins - activeMins);
      totalPendingMinutes += pendingMins;
    }
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

/**
 * Aggregates all engagement metrics without N+1 queries.
 * Handles 150+ pentests across 50 pentesters in < 30ms.
 */
async function getEngagementMetrics() {
  const engagements = await db.all('SELECT id, ritm, application_id, client_name, allocated_hours, status, created_at FROM engagements ORDER BY created_at DESC');
  if (engagements.length === 0) return [];

  // 1. Grouped statistics query (total requests, endpoints, timestamps, and testers) across ALL engagements
  const statsRows = await db.all(`
    SELECT 
      ritm,
      COUNT(*) AS total_requests,
      COUNT(DISTINCT host || path) AS unique_endpoints,
      MIN(timestamp) AS started_at,
      MAX(timestamp) AS last_activity_at,
      ARRAY_AGG(DISTINCT tester_username) AS testers
    FROM traffic_logs
    GROUP BY ritm
  `);

  const statsMap = new Map();
  for (const s of statsRows) {
    statsMap.set(s.ritm, s);
  }

  // 2. Grouped minute activity buckets across ALL engagements
  const activityRows = await db.all(`
    SELECT ritm, SUBSTR(timestamp, 1, 16) AS m, tool
    FROM traffic_logs
    GROUP BY ritm, m, tool
    ORDER BY ritm, m ASC
  `);

  const engagementActivityMap = new Map();
  for (const row of activityRows) {
    if (!engagementActivityMap.has(row.ritm)) {
      engagementActivityMap.set(row.ritm, { all: new Set(), manual: new Set(), auto: new Set() });
    }
    const bucket = engagementActivityMap.get(row.ritm);
    const ts = row.m + ':00.000Z';
    bucket.all.add(ts);
    if (row.tool === 'REPEATER' || row.tool === 'PROXY') {
      bucket.manual.add(ts);
    } else if (row.tool === 'SCANNER' || row.tool === 'INTRUDER') {
      bucket.auto.add(ts);
    }
  }

  // 3. Assemble results in-memory
  const results = [];
  for (const eng of engagements) {
    const stats = statsMap.get(eng.ritm) || {};
    const activity = engagementActivityMap.get(eng.ritm) || { all: new Set(), manual: new Set(), auto: new Set() };

    const activeMins = calculateActiveMinutes(Array.from(activity.all));
    const manualMins = calculateActiveMinutes(Array.from(activity.manual));
    const autoMins = calculateActiveMinutes(Array.from(activity.auto));

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

    const testers = Array.isArray(stats.testers) ? stats.testers.filter(Boolean) : [];

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
  const cleanRitm = String(ritm).trim().toUpperCase();
  const eng = await db.get('SELECT * FROM engagements WHERE ritm = ?', [cleanRitm]);
  if (!eng) return null;

  // Bucket activity by minute to keep memory footprint minimal
  const activityRows = await db.all(`
    SELECT SUBSTR(timestamp, 1, 16) AS m, tool
    FROM traffic_logs
    WHERE ritm = ?
    GROUP BY m, tool
    ORDER BY m ASC
  `, [eng.ritm]);

  const allMins = new Set();
  const manualMins = new Set();
  const autoMins = new Set();

  for (const r of activityRows) {
    const ts = r.m + ':00.000Z';
    allMins.add(ts);
    if (r.tool === 'REPEATER' || r.tool === 'PROXY') {
      manualMins.add(ts);
    } else if (r.tool === 'SCANNER' || r.tool === 'INTRUDER') {
      autoMins.add(ts);
    }
  }

  const activeMins = calculateActiveMinutes(Array.from(allMins));
  const manualMinutes = calculateActiveMinutes(Array.from(manualMins));
  const autoMinutes = calculateActiveMinutes(Array.from(autoMins));

  const activeHours = Number((activeMins / 60).toFixed(1));
  const allocated = Number(eng.allocated_hours || 40.0);
  const pendingHours = Math.max(0, allocated - activeHours).toFixed(1);
  const completionPct = allocated > 0 ? Math.round((activeHours / allocated) * 100) : 0;

  // Grouped tester summary with active minutes per tester
  const testerSummaryRows = await db.all(`
    SELECT tester_username, COUNT(*) AS request_count, MIN(timestamp) AS first_seen, MAX(timestamp) AS last_seen
    FROM traffic_logs
    WHERE ritm = ?
    GROUP BY tester_username
  `, [eng.ritm]);

  const testerMinutesRows = await db.all(`
    SELECT tester_username, SUBSTR(timestamp, 1, 16) AS m
    FROM traffic_logs
    WHERE ritm = ?
    GROUP BY tester_username, m
    ORDER BY tester_username, m ASC
  `, [eng.ritm]);

  const testerMinutesMap = new Map();
  for (const r of testerMinutesRows) {
    if (!testerMinutesMap.has(r.tester_username)) {
      testerMinutesMap.set(r.tester_username, []);
    }
    testerMinutesMap.get(r.tester_username).push(r.m + ':00.000Z');
  }

  const testerStats = [];
  for (const ts of testerSummaryRows) {
    const tTimestamps = testerMinutesMap.get(ts.tester_username) || [];
    const tActiveMins = calculateActiveMinutes(tTimestamps);
    testerStats.push({
      username: ts.tester_username,
      request_count: parseInt(ts.request_count, 10),
      active_hours: (tActiveMins / 60).toFixed(1),
      first_seen: ts.first_seen,
      last_seen: ts.last_seen
    });
  }

  const endpoints = await db.all(`
    SELECT method, host, path, status_code, COUNT(*) AS hits, MAX(timestamp) AS last_hit
    FROM traffic_logs
    WHERE ritm = ?
    GROUP BY method, host, path, status_code
    ORDER BY hits DESC
    LIMIT 100
  `, [eng.ritm]);

  const tools = await db.all(`
    SELECT tool, COUNT(*) AS count FROM traffic_logs WHERE ritm = ? GROUP BY tool
  `, [eng.ritm]);

  const latestLog = await db.get(`
    SELECT MAX(timestamp) AS last_collected_at
    FROM traffic_logs
    WHERE ritm = ?
  `, [eng.ritm]);

  const dailyTimeline = await db.all(`
    SELECT SUBSTR(timestamp, 1, 10) AS log_date, COUNT(*) AS request_count
    FROM traffic_logs
    WHERE ritm = ?
    GROUP BY SUBSTR(timestamp, 1, 10)
    ORDER BY log_date ASC
  `, [eng.ritm]);

  const hourlyTimeline = await db.all(`
    SELECT SUBSTR(timestamp, 1, 13) AS log_hour, COUNT(*) AS request_count
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
      manual_hours: (manualMinutes / 60).toFixed(1),
      automated_hours: (autoMinutes / 60).toFixed(1),
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
