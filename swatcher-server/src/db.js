const { Pool } = require('pg');
const path = require('node:path');
const fs = require('node:fs');

const isPostgres = Boolean(process.env.DATABASE_URL);
let pgPool = null;
let sqliteDb = null;

if (isPostgres) {
  console.log('[swatcher-db] Initializing Enterprise PostgreSQL Connection Pool...');
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: parseInt(process.env.DB_POOL_MAX || '25', 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
  });
} else {
  console.log('[swatcher-db] Using Embedded SQLite Database (Local Mode)...');
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const dbPath = path.join(dataDir, 'swatcher.db');

  let initialized = false;

  // 1. Try built-in node:sqlite (available in Node.js >= 22.5.0)
  try {
    const { DatabaseSync } = require('node:sqlite');
    sqliteDb = new DatabaseSync(dbPath);
    sqliteDb.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    initialized = true;
    console.log('[swatcher-db] Initialized via node:sqlite (Node.js built-in)');
  } catch (err) {
    // node:sqlite not supported in this Node version; fall through to better-sqlite3
  }

  // 2. Fall back to better-sqlite3 (supports Node.js 16, 18, 20, 22 on Kali, Linux, Windows, macOS)
  if (!initialized) {
    try {
      const Database = require('better-sqlite3');
      sqliteDb = new Database(dbPath);
      sqliteDb.pragma('journal_mode = WAL');
      sqliteDb.pragma('foreign_keys = ON');
      initialized = true;
      console.log('[swatcher-db] Initialized via better-sqlite3 (universal Node compatibility)');
    } catch (err) {
      console.error('\n[swatcher-db] FATAL: Could not initialize SQLite database.');
      console.error('Neither "node:sqlite" (Node 22+) nor "better-sqlite3" could be loaded.');
      console.error('Please ensure you have run "npm install" inside swatcher-server:\n');
      console.error('    cd swatcher-server && npm install\n');
      throw err;
    }
  }
}

/**
 * Normalizes SQL queries and placeholders:
 * - In Postgres: transforms ? into $1, $2, $3...
 * - Replaces SQLite-specific 'INSERT OR IGNORE' with 'ON CONFLICT DO NOTHING'
 */
function prepareSql(sql) {
  if (!isPostgres) {
    return sql;
  }
  let index = 1;
  let normalized = sql.replace(/\?/g, () => `$${index++}`);
  if (normalized.includes('INSERT OR IGNORE INTO')) {
    normalized = normalized.replace('INSERT OR IGNORE INTO', 'INSERT INTO') + ' ON CONFLICT DO NOTHING';
  }
  return normalized;
}

const db = {
  isPostgres,

  async get(sql, params = []) {
    if (isPostgres) {
      const res = await pgPool.query(prepareSql(sql), params);
      return res.rows[0] || null;
    } else {
      const stmt = sqliteDb.prepare(sql);
      return stmt.get(...params) || null;
    }
  },

  async all(sql, params = []) {
    if (isPostgres) {
      const res = await pgPool.query(prepareSql(sql), params);
      return res.rows;
    } else {
      const stmt = sqliteDb.prepare(sql);
      return stmt.all(...params);
    }
  },

  async run(sql, params = []) {
    if (isPostgres) {
      const res = await pgPool.query(prepareSql(sql), params);
      return { changes: res.rowCount };
    } else {
      const stmt = sqliteDb.prepare(sql);
      return stmt.run(...params);
    }
  },

  async exec(sql) {
    if (isPostgres) {
      await pgPool.query(sql);
    } else {
      sqliteDb.exec(sql);
    }
  },

  async initSchema() {
    if (isPostgres) {
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
          created_at VARCHAR(64) NOT NULL,
          last_login_at VARCHAR(64)
        );

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
          user_id VARCHAR(64) NOT NULL,
          username VARCHAR(64) NOT NULL,
          action_type VARCHAR(64) NOT NULL,
          target_id VARCHAR(128) DEFAULT '',
          target_name VARCHAR(128) DEFAULT '',
          description TEXT NOT NULL,
          details_json TEXT,
          ip_address VARCHAR(64),
          created_at VARCHAR(64) NOT NULL
        );

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
        CREATE INDEX IF NOT EXISTS idx_pentesters_apikey ON pentesters(api_key);
        CREATE INDEX IF NOT EXISTS idx_engagements_ritm ON engagements(ritm);
        CREATE INDEX IF NOT EXISTS idx_engagements_appid ON engagements(application_id);
        CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
      `);
      console.log('[swatcher-db] PostgreSQL Schema and Indexes verified successfully.');
    } else {
      sqliteDb.exec(`
        CREATE TABLE IF NOT EXISTS leadership_users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          full_name TEXT NOT NULL,
          email TEXT DEFAULT '',
          password_hash TEXT NOT NULL,
          password_salt TEXT NOT NULL,
          role TEXT DEFAULT 'LEADER',
          is_active INTEGER DEFAULT 1,
          created_at TEXT NOT NULL,
          last_login_at TEXT
        );

        CREATE TABLE IF NOT EXISTS leadership_sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          username TEXT NOT NULL,
          ip_address TEXT,
          user_agent TEXT,
          created_at TEXT NOT NULL,
          last_activity_at TEXT NOT NULL,
          duration_seconds INTEGER DEFAULT 0,
          ended_at TEXT
        );

        CREATE TABLE IF NOT EXISTS audit_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT,
          user_id TEXT NOT NULL,
          username TEXT NOT NULL,
          action_type TEXT NOT NULL,
          target_id TEXT DEFAULT '',
          target_name TEXT DEFAULT '',
          description TEXT NOT NULL,
          details_json TEXT,
          ip_address TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pentesters (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          full_name TEXT NOT NULL,
          email TEXT DEFAULT '',
          api_key TEXT NOT NULL UNIQUE,
          is_active INTEGER DEFAULT 1,
          created_at TEXT NOT NULL,
          last_active_at TEXT
        );

        CREATE TABLE IF NOT EXISTS engagements (
          id TEXT PRIMARY KEY,
          ritm TEXT NOT NULL UNIQUE,
          application_id TEXT NOT NULL,
          client_name TEXT DEFAULT '',
          allocated_hours REAL DEFAULT 40.0,
          status TEXT DEFAULT 'ACTIVE',
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          ritm TEXT NOT NULL,
          application_id TEXT NOT NULL,
          tester_id TEXT NOT NULL,
          tester_username TEXT NOT NULL,
          tester_machine TEXT DEFAULT '',
          started_at TEXT NOT NULL,
          last_active_at TEXT NOT NULL,
          ended_at TEXT,
          request_count INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS traffic_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT UNIQUE,
          session_id TEXT,
          ritm TEXT NOT NULL,
          application_id TEXT NOT NULL,
          tester_id TEXT NOT NULL,
          tester_username TEXT NOT NULL,
          tester_machine TEXT DEFAULT '',
          tool TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          method TEXT NOT NULL,
          url TEXT NOT NULL,
          host TEXT NOT NULL,
          port INTEGER DEFAULT 443,
          path TEXT NOT NULL,
          query TEXT DEFAULT '',
          request_headers TEXT,
          request_body TEXT,
          request_body_length INTEGER DEFAULT 0,
          status_code INTEGER DEFAULT 0,
          response_headers TEXT,
          response_body TEXT,
          response_body_length INTEGER DEFAULT 0,
          duration_ms INTEGER DEFAULT 0,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_traffic_ritm ON traffic_logs(ritm);
        CREATE INDEX IF NOT EXISTS idx_traffic_appid ON traffic_logs(application_id);
        CREATE INDEX IF NOT EXISTS idx_traffic_tester ON traffic_logs(tester_username);
        CREATE INDEX IF NOT EXISTS idx_traffic_tool ON traffic_logs(tool);
        CREATE INDEX IF NOT EXISTS idx_traffic_timestamp ON traffic_logs(timestamp);
        CREATE INDEX IF NOT EXISTS idx_traffic_host ON traffic_logs(host);
        CREATE INDEX IF NOT EXISTS idx_pentesters_apikey ON pentesters(api_key);
        CREATE INDEX IF NOT EXISTS idx_engagements_ritm ON engagements(ritm);
        CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
      `);
      console.log('[swatcher-db] SQLite Schema and Indexes verified successfully.');
    }
  },

  async close() {
    if (isPostgres && pgPool) {
      console.log('[swatcher-db] Closing PostgreSQL connection pool...');
      await pgPool.end();
    } else if (sqliteDb && sqliteDb.close) {
      console.log('[swatcher-db] Closing SQLite database...');
      sqliteDb.close();
    }
  }
};

module.exports = db;
