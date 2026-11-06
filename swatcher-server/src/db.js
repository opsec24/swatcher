const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'swatcher.db');
const db = new DatabaseSync(dbPath);

// Initialize schema
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  -- Leadership Users (Dashboard Admins)
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

  -- Leadership User Sessions & Duration Tracking
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

  -- Comprehensive Audit Trail
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

  -- Registered Pentesters (Burp Plugin API Key Holders)
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

  -- Engagements (RITMs)
  CREATE TABLE IF NOT EXISTS engagements (
    id TEXT PRIMARY KEY,
    ritm TEXT NOT NULL UNIQUE,
    application_id TEXT NOT NULL,
    client_name TEXT DEFAULT '',
    allocated_hours REAL DEFAULT 40.0,
    status TEXT DEFAULT 'ACTIVE',
    created_at TEXT NOT NULL
  );

  -- Sessions
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

  -- Traffic Logs
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
  CREATE INDEX IF NOT EXISTS idx_engagements_appid ON engagements(application_id);
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(username);
  CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action_type);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON leadership_sessions(user_id);
`);

module.exports = db;
