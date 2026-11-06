const db = require('./db');
const crypto = require('node:crypto');

async function seed() {
  console.log('Seeding enterprise swatcher pentest team & engagement data...');

  await db.initSchema();

  // Clean existing traffic data for clean demo
  await db.exec(`
    DELETE FROM traffic_logs;
    DELETE FROM sessions;
    DELETE FROM engagements;
    DELETE FROM pentesters;
  `);

  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  const oneDay = 24 * oneHour;

  // 1. Seed Pentesters with API Keys
  const pentesters = [
    { id: 'usr_sarah', username: 'sarah.chen', full_name: 'Sarah Chen', email: 'sarah.chen@corp.internal', key: 'sw_live_sarah_chen_key_881923' },
    { id: 'usr_alex', username: 'alex.miller', full_name: 'Alex Miller', email: 'alex.miller@corp.internal', key: 'sw_live_alex_miller_key_771920' },
    { id: 'usr_marcus', username: 'marcus.vance', full_name: 'Marcus Vance', email: 'marcus.vance@corp.internal', key: 'sw_live_marcus_vance_key_661911' },
    { id: 'usr_priya', username: 'priya.patel', full_name: 'Priya Patel', email: 'priya.patel@corp.internal', key: 'sw_live_priya_patel_key_551900' }
  ];

  for (const p of pentesters) {
    await db.run(
      'INSERT INTO pentesters (id, username, full_name, email, api_key, is_active, created_at, last_active_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
      [p.id, p.username, p.full_name, p.email, p.key, new Date(now - 7 * oneDay).toISOString(), new Date(now - 30 * 60 * 1000).toISOString()]
    );
  }

  // 2. Seed Engagements
  await db.run(
    'INSERT INTO engagements (id, ritm, application_id, client_name, allocated_hours, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['eng_1', 'RITM0049281', 'APP-PAYMENTS-V2', 'Core Payments & Billing Team', 40.0, 'ACTIVE', new Date(now - 6 * oneDay).toISOString()]
  );
  await db.run(
    'INSERT INTO engagements (id, ritm, application_id, client_name, allocated_hours, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['eng_2', 'RITM0049305', 'APP-PORTAL-UAT', 'Customer Experience Eng', 30.0, 'ACTIVE', new Date(now - 3 * oneDay).toISOString()]
  );
  await db.run(
    'INSERT INTO engagements (id, ritm, application_id, client_name, allocated_hours, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['eng_3', 'RITM0048990', 'APP-PAYMENTS-V2', 'Core Payments (Q3 Cycle)', 40.0, 'COMPLETED', new Date(now - 45 * oneDay).toISOString()]
  );

  // 3. Seed Traffic Logs
  const paymentEndpoints = [
    { method: 'POST', path: '/v1/auth/login', body: '{"username":"admin","password":"Password123!"}', status: 200, res: '{"token":"eyJhbGciOi...","expires_in":3600}' },
    { method: 'GET', path: '/v1/accounts/me', body: '', status: 200, res: '{"account_id":"acc_8841","balance":4520.50,"currency":"USD"}' },
    { method: 'GET', path: '/v1/accounts/acc_9901/statements', body: '', status: 403, res: '{"error":"Unauthorized access to account statement"}' },
    { method: 'POST', path: '/v1/transfers/initiate', body: '{"recipient":"ACC-4491","amount":50000.00,"memo":"Test BOLA"}', status: 201, res: '{"transfer_id":"tr_9918","status":"PENDING_APPROVAL"}' },
    { method: 'PUT', path: '/v1/users/profile', body: '{"role":"SUPERADMIN","email":"tester@corp.internal"}', status: 400, res: '{"error":"Invalid property role for unprivileged user"}' },
    { method: 'DELETE', path: '/v1/webhooks/hook_99', body: '', status: 204, res: '' },
    { method: 'POST', path: '/v1/disputes/file', body: '{"transaction_id":"tx_1","reason":"SQLi \' OR 1=1 --"}', status: 500, res: '{"error":"Unhandled Database Exception at query execution"}' }
  ];

  let totalLogs = 0;

  // Spread logs across 5 days (Nov 2, Nov 3, Nov 4, Nov 5, Nov 6)
  for (let dayOffset = 5; dayOffset >= 0; dayOffset--) {
    const dayBase = now - dayOffset * oneDay;
    const reqsPerDay = 25 + Math.floor(Math.random() * 30);

    for (let i = 0; i < reqsPerDay; i++) {
      const ep = paymentEndpoints[i % paymentEndpoints.length];
      const reqTime = new Date(dayBase + i * 15 * 60 * 1000).toISOString();

      await db.run(`
        INSERT INTO traffic_logs (
          event_id, session_id, ritm, application_id, tester_id, tester_username, tester_machine,
          tool, timestamp, method, url, host, port, path, query,
          request_headers, request_body, request_body_length,
          status_code, response_headers, response_body, response_body_length,
          duration_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        crypto.randomUUID(),
        'sess_sarah_1',
        'RITM0049281',
        'APP-PAYMENTS-V2',
        'usr_sarah',
        'sarah.chen',
        'mbp-sarah.corp',
        i % 4 === 0 ? 'PROXY' : 'REPEATER',
        reqTime,
        ep.method,
        `https://api.payments.internal${ep.path}`,
        'api.payments.internal',
        443,
        ep.path,
        '',
        JSON.stringify({ 'Host': 'api.payments.internal', 'Authorization': 'Bearer [REDACTED]' }),
        ep.body,
        ep.body.length,
        ep.status,
        JSON.stringify({ 'Content-Type': 'application/json' }),
        ep.res,
        ep.res.length,
        Math.floor(120 + Math.random() * 200),
        reqTime
      ]);
      totalLogs++;
    }
  }

  console.log(`Successfully seeded ${pentesters.length} registered pentesters and ${totalLogs} traffic logs across shared RITMs!`);
  await db.close();
}

seed().catch(console.error);
