const db = require('./db');
const crypto = require('node:crypto');

console.log('Seeding enterprise swatcher pentest team & engagement data...');

// Clean existing data for clean demo
db.exec(`
  DELETE FROM traffic_logs;
  DELETE FROM sessions;
  DELETE FROM engagements;
  DELETE FROM pentesters;
`);

// 1. Seed Pentesters with API Keys
const insertTesterStmt = db.prepare(`
  INSERT INTO pentesters (id, username, full_name, email, api_key, is_active, created_at, last_active_at)
  VALUES (?, ?, ?, ?, ?, 1, ?, ?)
`);

const now = Date.now();
const oneHour = 60 * 60 * 1000;
const oneMin = 60 * 1000;

const pentesters = [
  { id: 'usr_sarah', username: 'sarah.chen', full_name: 'Sarah Chen', email: 'sarah.chen@corp.internal', key: 'sw_live_sarah_chen_key_881923' },
  { id: 'usr_alex', username: 'alex.miller', full_name: 'Alex Miller', email: 'alex.miller@corp.internal', key: 'sw_live_alex_miller_key_771920' },
  { id: 'usr_marcus', username: 'marcus.vance', full_name: 'Marcus Vance', email: 'marcus.vance@corp.internal', key: 'sw_live_marcus_vance_key_661911' },
  { id: 'usr_priya', username: 'priya.patel', full_name: 'Priya Patel', email: 'priya.patel@corp.internal', key: 'sw_live_priya_patel_key_551900' }
];

pentesters.forEach(p => {
  insertTesterStmt.run(p.id, p.username, p.full_name, p.email, p.key, new Date(now - 30 * 24 * oneHour).toISOString(), new Date(now - 10 * oneMin).toISOString());
});

// 2. Seed Engagements (RITMs)
// Notice APP-PAYMENTS-V2 has TWO separate RITMs (Q3 audit and Q4 re-test)!
const insertEngStmt = db.prepare(`
  INSERT INTO engagements (id, ritm, application_id, client_name, allocated_hours, status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

insertEngStmt.run('eng_1', 'RITM0049281', 'APP-PAYMENTS-V2', 'Core Payments & Billing Team', 40.0, 'ACTIVE', new Date(now - 5 * 24 * oneHour).toISOString());
insertEngStmt.run('eng_2', 'RITM0049305', 'APP-PORTAL-UAT', 'Customer Experience Eng', 30.0, 'ACTIVE', new Date(now - 3 * 24 * oneHour).toISOString());
insertEngStmt.run('eng_3', 'RITM0048990', 'APP-PAYMENTS-V2', 'Core Payments (Q3 Cycle)', 40.0, 'COMPLETED', new Date(now - 45 * 24 * oneHour).toISOString());

// 3. Seed Traffic Logs
const insertLogStmt = db.prepare(`
  INSERT INTO traffic_logs (
    event_id, session_id, ritm, application_id, tester_id, tester_username, tester_machine,
    tool, timestamp, method, url, host, port, path, query,
    request_headers, request_body, request_body_length,
    status_code, response_headers, response_body, response_body_length,
    duration_ms, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const paymentEndpoints = [
  { method: 'POST', path: '/v1/auth/login', body: '{"username":"admin","password":"Password123!"}', status: 200, res: '{"token":"eyJhbGciOi...","expires_in":3600}' },
  { method: 'GET', path: '/v1/accounts/me', body: '', status: 200, res: '{"account_id":"acc_8841","balance":4520.50,"currency":"USD"}' },
  { method: 'GET', path: '/v1/accounts/acc_9901/statements', body: '', status: 403, res: '{"error":"Unauthorized access to account statement"}' },
  { method: 'POST', path: '/v1/transfers/initiate', body: '{"recipient":"ACC-4491","amount":50000.00,"memo":"Test BOLA"}', status: 201, res: '{"transfer_id":"tr_9918","status":"PENDING_APPROVAL"}' },
  { method: 'PUT', path: '/v1/users/profile', body: '{"role":"SUPERADMIN","email":"tester@corp.internal"}', status: 400, res: '{"error":"Invalid property role for unprivileged user"}' },
  { method: 'DELETE', path: '/v1/webhooks/hook_99', body: '', status: 204, res: '' },
  { method: 'POST', path: '/v1/disputes/file', body: '{"transaction_id":"tx_1","reason":"SQLi \' OR 1=1 --"}', status: 500, res: '{"error":"Unhandled Database Exception at query execution"}' }
];

const portalEndpoints = [
  { method: 'GET', path: '/api/user/profile', body: '', status: 200, res: '{"id":102,"name":"Test User"}' },
  { method: 'POST', path: '/api/documents/upload', body: '<xml><filename>poc.svg</filename></xml>', status: 200, res: '{"file_id":"doc_441"}' },
  { method: 'GET', path: '/api/invoices/download?id=1001', body: '', status: 200, res: 'PDF_INVOICE_DATA' },
  { method: 'POST', path: '/api/feedback/submit', body: '{"message":"<script>alert(1)</script>"}', status: 200, res: '{"status":"received"}' },
  { method: 'GET', path: '/api/admin/metrics', body: '', status: 401, res: '{"error":"Bearer token missing or invalid"}' }
];

let totalLogs = 0;

// Sarah on RITM0049281: 24 active hours over several days (Manual Repeater & Proxy)
const sarahStart = now - 48 * oneHour;
for (let i = 0; i < 60; i++) {
  const ep = paymentEndpoints[i % paymentEndpoints.length];
  const reqTime = new Date(sarahStart + i * 8 * oneMin + (Math.random() * 60000)).toISOString();
  const tool = i % 4 === 0 ? 'PROXY' : 'REPEATER';

  insertLogStmt.run(
    crypto.randomUUID(),
    'sess_sarah_1',
    'RITM0049281',
    'APP-PAYMENTS-V2',
    'usr_sarah',
    'sarah.chen',
    'thinkpad-sarah-sec',
    tool,
    reqTime,
    ep.method,
    `https://api.payments.internal${ep.path}`,
    'api.payments.internal',
    443,
    ep.path,
    ep.path.includes('?') ? ep.path.split('?')[1] : '',
    JSON.stringify({ 'Host': 'api.payments.internal', 'Authorization': 'Bearer eyJhbGciOi...', 'Content-Type': 'application/json' }),
    ep.body,
    ep.body.length,
    ep.status,
    JSON.stringify({ 'Content-Type': 'application/json', 'Server': 'nginx/1.24' }),
    ep.res,
    ep.res.length,
    Math.floor(120 + Math.random() * 350),
    reqTime
  );
  totalLogs++;
}

// Marcus also on RITM0049281 (Appending traffic to the SAME RITM!): 6 hours of Intruder fuzzing + Repeater
const marcusStart = now - 8 * oneHour;
for (let i = 0; i < 90; i++) {
  const reqTime = new Date(marcusStart + i * 900).toISOString();
  insertLogStmt.run(
    crypto.randomUUID(),
    'sess_marcus_intruder',
    'RITM0049281',
    'APP-PAYMENTS-V2',
    'usr_marcus',
    'marcus.vance',
    'dell-marcus-pentest',
    i % 10 === 0 ? 'REPEATER' : 'INTRUDER',
    reqTime,
    'POST',
    'https://api.payments.internal/v1/auth/login',
    'api.payments.internal',
    443,
    '/v1/auth/login',
    '',
    JSON.stringify({ 'Host': 'api.payments.internal', 'Content-Type': 'application/json' }),
    `{"username":"admin","password":"test_pass_${i}"}`,
    40,
    401,
    JSON.stringify({ 'Content-Type': 'application/json' }),
    '{"error":"Invalid credentials"}',
    30,
    95,
    reqTime
  );
  totalLogs++;
}

// Alex on RITM0049305: Scanner + Repeater
const alexStart = now - 20 * oneHour;
for (let i = 0; i < 80; i++) {
  const ep = portalEndpoints[i % portalEndpoints.length];
  const reqTime = new Date(alexStart + i * 2000).toISOString();

  insertLogStmt.run(
    crypto.randomUUID(),
    'sess_alex_scan',
    'RITM0049305',
    'APP-PORTAL-UAT',
    'usr_alex',
    'alex.miller',
    'mbp-alex-corp',
    i % 5 === 0 ? 'REPEATER' : 'SCANNER',
    reqTime,
    ep.method,
    `https://portal.stg.corp.net${ep.path}?fuzz=${i}`,
    'portal.stg.corp.net',
    443,
    ep.path,
    `fuzz=${i}`,
    JSON.stringify({ 'Host': 'portal.stg.corp.net', 'User-Agent': 'Mozilla/5.0 BurpSuite' }),
    ep.body,
    ep.body.length,
    ep.status,
    JSON.stringify({ 'Content-Type': 'application/json' }),
    ep.res,
    ep.res.length,
    Math.floor(80 + Math.random() * 150),
    reqTime
  );
  totalLogs++;
}

console.log(`Successfully seeded ${pentesters.length} registered pentesters and ${totalLogs} traffic logs across shared RITMs!`);
