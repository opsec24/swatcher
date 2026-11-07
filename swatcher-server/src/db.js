const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || 
  `postgres://${process.env.DB_USER || 'swatcher'}:${process.env.DB_PASSWORD || 'swatcher_password'}@${process.env.DB_HOST || '127.0.0.1'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'swatcher_db'}`;

console.log('[swatcher-db] Initializing Enterprise PostgreSQL Connection Pool...');

const pgPool = new Pool({
  connectionString,
  max: parseInt(process.env.DB_POOL_MAX || '25', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

pgPool.on('error', (err) => {
  console.error('[swatcher-db] Unexpected PostgreSQL client pool error:', err.message);
});

/**
 * Normalizes SQL queries and placeholders:
 * - Transforms ? into $1, $2, $3...
 * - Replaces 'INSERT OR IGNORE' with 'ON CONFLICT DO NOTHING'
 */
function prepareSql(sql) {
  let index = 1;
  let normalized = sql.replace(/\?/g, () => `$${index++}`);
  if (normalized.includes('INSERT OR IGNORE INTO')) {
    normalized = normalized.replace('INSERT OR IGNORE INTO', 'INSERT INTO') + ' ON CONFLICT DO NOTHING';
  }
  return normalized;
}

const db = {
  isPostgres: true,
  pool: pgPool,

  async get(sql, params = []) {
    const res = await pgPool.query(prepareSql(sql), params);
    return res.rows[0] || null;
  },

  async all(sql, params = []) {
    const res = await pgPool.query(prepareSql(sql), params);
    return res.rows;
  },

  async run(sql, params = []) {
    const res = await pgPool.query(prepareSql(sql), params);
    return { changes: res.rowCount };
  },

  async insertBatch(table, columns, rows, onConflict = 'ON CONFLICT (event_id) DO NOTHING') {
    if (!rows || rows.length === 0) return { changes: 0 };
    const colList = columns.join(', ');
    const valuePlaceholders = [];
    const params = [];
    let pIndex = 1;

    for (const row of rows) {
      const rowPlaceholders = [];
      for (const col of columns) {
        rowPlaceholders.push(`$${pIndex++}`);
        let val = row[col];
        if (typeof val === 'string' && val.includes('\0')) {
          val = val.replace(/\0/g, '');
        }
        params.push(val);
      }
      valuePlaceholders.push(`(${rowPlaceholders.join(', ')})`);
    }

    const sql = `INSERT INTO ${table} (${colList}) VALUES ${valuePlaceholders.join(', ')} ${onConflict}`;
    const res = await pgPool.query(sql, params);
    return { changes: res.rowCount };
  },

  async exec(sql) {
    await pgPool.query(sql);
  },

  async initSchema() {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS leadership_users (
        id VARCHAR(64) PRIMARY KEY,
        username VARCHAR(64) NOT NULL UNIQUE,
        full_name VARCHAR(128) NOT NULL,
        email VARCHAR(128) DEFAULT '',
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        role VARCHAR(32) DEFAULT 'LEADER',
        is_active INT DEFAULT 1,
        failed_login_attempts INT DEFAULT 0,
        is_locked INT DEFAULT 0,
        locked_at VARCHAR(64),
        created_at VARCHAR(64) NOT NULL,
        last_login_at VARCHAR(64)
      );

      -- Idempotent schema migration for account lockout
      ALTER TABLE leadership_users ADD COLUMN IF NOT EXISTS failed_login_attempts INT DEFAULT 0;
      ALTER TABLE leadership_users ADD COLUMN IF NOT EXISTS is_locked INT DEFAULT 0;
      ALTER TABLE leadership_users ADD COLUMN IF NOT EXISTS locked_at VARCHAR(64);

      CREATE TABLE IF NOT EXISTS leadership_sessions (
        id VARCHAR(128) PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        username VARCHAR(64) NOT NULL,
        ip_address VARCHAR(64),
        user_agent TEXT,
        created_at VARCHAR(64) NOT NULL,
        last_activity_at VARCHAR(64) NOT NULL,
        duration_seconds INT DEFAULT 0,
        ended_at VARCHAR(64)
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        session_id VARCHAR(128),
        user_id VARCHAR(64) DEFAULT 'SYSTEM',
        username VARCHAR(64) NOT NULL,
        action_type VARCHAR(64) NOT NULL,
        target_id VARCHAR(128) DEFAULT '',
        target_name VARCHAR(128) DEFAULT '',
        description TEXT NOT NULL,
        details_json TEXT,
        ip_address VARCHAR(64),
        created_at VARCHAR(64) NOT NULL
      );

      -- Idempotent schema migration to allow system-level unauthenticated audit events
      ALTER TABLE audit_logs ALTER COLUMN user_id DROP NOT NULL;

      CREATE TABLE IF NOT EXISTS pentesters (
        id VARCHAR(64) PRIMARY KEY,
        username VARCHAR(64) NOT NULL UNIQUE,
        full_name VARCHAR(128) NOT NULL,
        email VARCHAR(128) DEFAULT '',
        api_key VARCHAR(128) NOT NULL UNIQUE,
        is_active INT DEFAULT 1,
        created_at VARCHAR(64) NOT NULL,
        last_active_at VARCHAR(64)
      );

      CREATE TABLE IF NOT EXISTS engagements (
        id VARCHAR(64) PRIMARY KEY,
        ritm VARCHAR(64) NOT NULL UNIQUE,
        application_id VARCHAR(64) NOT NULL,
        client_name VARCHAR(128) DEFAULT '',
        allocated_hours DOUBLE PRECISION DEFAULT 40.0,
        status VARCHAR(32) DEFAULT 'ACTIVE',
        created_at VARCHAR(64) NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id VARCHAR(128) PRIMARY KEY,
        ritm VARCHAR(64) NOT NULL,
        application_id VARCHAR(64) NOT NULL,
        tester_id VARCHAR(64) NOT NULL,
        tester_username VARCHAR(64) NOT NULL,
        tester_machine VARCHAR(128) DEFAULT '',
        started_at VARCHAR(64) NOT NULL,
        last_active_at VARCHAR(64) NOT NULL,
        ended_at VARCHAR(64),
        request_count INT DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS traffic_logs (
        id SERIAL PRIMARY KEY,
        event_id VARCHAR(128) UNIQUE,
        session_id VARCHAR(128),
        ritm VARCHAR(64) NOT NULL,
        application_id VARCHAR(64) NOT NULL,
        tester_id VARCHAR(64) NOT NULL,
        tester_username VARCHAR(64) NOT NULL,
        tester_machine VARCHAR(128) DEFAULT '',
        tool VARCHAR(32) NOT NULL,
        timestamp VARCHAR(64) NOT NULL,
        method VARCHAR(16) NOT NULL,
        url TEXT NOT NULL,
        host VARCHAR(256) NOT NULL,
        port INT DEFAULT 443,
        path TEXT NOT NULL,
        query TEXT DEFAULT '',
        request_headers TEXT,
        request_body TEXT,
        request_body_length INT DEFAULT 0,
        status_code INT DEFAULT 0,
        response_headers TEXT,
        response_body TEXT,
        response_body_length INT DEFAULT 0,
        duration_ms INT DEFAULT 0,
        created_at VARCHAR(64) NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_traffic_ritm ON traffic_logs(ritm);
      CREATE INDEX IF NOT EXISTS idx_traffic_appid ON traffic_logs(application_id);
      CREATE INDEX IF NOT EXISTS idx_traffic_tester ON traffic_logs(tester_username);
      CREATE INDEX IF NOT EXISTS idx_traffic_tool ON traffic_logs(tool);
      CREATE INDEX IF NOT EXISTS idx_traffic_timestamp ON traffic_logs(timestamp);
      CREATE INDEX IF NOT EXISTS idx_traffic_host ON traffic_logs(host);

      -- High-Performance Composite Indexes for Enterprise Scale (150+ pentests / 50 testers)
      CREATE INDEX IF NOT EXISTS idx_traffic_ritm_time ON traffic_logs(ritm, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_traffic_tool_time ON traffic_logs(tool, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_traffic_tester_ritm ON traffic_logs(tester_username, ritm);
      CREATE INDEX IF NOT EXISTS idx_traffic_status ON traffic_logs(status_code);

      CREATE INDEX IF NOT EXISTS idx_pentesters_apikey ON pentesters(api_key);
      CREATE INDEX IF NOT EXISTS idx_engagements_ritm ON engagements(ritm);
      CREATE INDEX IF NOT EXISTS idx_engagements_appid ON engagements(application_id);
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON leadership_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_ended ON leadership_sessions(ended_at);

      -- Idempotent schema migrations for scale, large bodies, long hosts, and custom methods
      ALTER TABLE traffic_logs ALTER COLUMN host TYPE TEXT;
      ALTER TABLE traffic_logs ALTER COLUMN method TYPE VARCHAR(64);
      ALTER TABLE traffic_logs ALTER COLUMN duration_ms TYPE BIGINT;
      ALTER TABLE traffic_logs ALTER COLUMN ritm TYPE VARCHAR(128);
      ALTER TABLE traffic_logs ALTER COLUMN application_id TYPE VARCHAR(128);
      ALTER TABLE traffic_logs ALTER COLUMN request_body_length TYPE BIGINT;
      ALTER TABLE traffic_logs ALTER COLUMN response_body_length TYPE BIGINT;
    `);
    console.log('[swatcher-db] PostgreSQL Schema and Indexes verified successfully.');
  },

  async close() {
    if (pgPool) {
      console.log('[swatcher-db] Closing PostgreSQL connection pool...');
      await pgPool.end();
    }
  }
};

module.exports = db;
