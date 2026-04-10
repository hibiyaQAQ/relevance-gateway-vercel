import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

const SCHEMA_VERSION = "node-sdk-v1";

function nowIso() {
  return new Date().toISOString();
}

function tableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((item) => item.name);
}

function getColumns(db, tableName) {
  try {
    return db
      .prepare(`PRAGMA table_info(${tableName})`)
      .all()
      .map((item) => item.name);
  } catch {
    return [];
  }
}

function resetSchema(db) {
  const statements = [
    "DROP TABLE IF EXISTS request_logs",
    "DROP TABLE IF EXISTS model_catalog_cache",
    "DROP TABLE IF EXISTS gateway_api_keys",
    "DROP TABLE IF EXISTS model_deployments",
    "DROP TABLE IF EXISTS upstream_keys",
    "DROP TABLE IF EXISTS app_meta",
  ];
  const transaction = db.transaction(() => {
    db.pragma("foreign_keys = OFF");
    for (const statement of statements) {
      db.exec(statement);
    }
    db.pragma("foreign_keys = ON");
  });
  transaction();
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS upstream_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      project TEXT NOT NULL,
      region TEXT NOT NULL,
      api_key TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      status TEXT,
      last_error TEXT,
      last_check_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS model_deployments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      upstream_key_id INTEGER NOT NULL REFERENCES upstream_keys(id) ON DELETE CASCADE,
      public_model_name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      upstream_model TEXT NOT NULL,
      agent_id TEXT NOT NULL UNIQUE,
      agent_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active',
      last_error TEXT,
      last_used_at TEXT,
      last_latency_ms INTEGER,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      cooldown_until TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (upstream_key_id, public_model_name)
    );

    CREATE TABLE IF NOT EXISTS gateway_api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      raw_key TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS model_catalog_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      region TEXT NOT NULL,
      model_subset TEXT NOT NULL DEFAULT 'AGENT',
      source_upstream_key_id INTEGER,
      source_upstream_key_name TEXT,
      models_json TEXT NOT NULL DEFAULT '[]',
      model_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      last_refreshed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project, region, model_subset)
    );

    CREATE TABLE IF NOT EXISTS request_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL UNIQUE,
      gateway_key_name TEXT,
      public_model_name TEXT NOT NULL,
      deployment_id INTEGER REFERENCES model_deployments(id) ON DELETE SET NULL,
      stream INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      latency_ms INTEGER,
      first_token_ms INTEGER,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      cost REAL,
      credits_used_json TEXT,
      transport TEXT,
      upstream_conversation_id TEXT,
      request_preview TEXT,
      response_preview TEXT,
      thinking_preview TEXT,
      emitted_content_chars INTEGER,
      emitted_thinking_chars INTEGER,
      error_message TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_model_deployments_public_model_name
      ON model_deployments(public_model_name);
    CREATE INDEX IF NOT EXISTS idx_request_logs_created_at
      ON request_logs(created_at DESC);
  `);

  const upsertMeta = db.prepare(`
    INSERT INTO app_meta(key, value)
    VALUES (@key, @value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  upsertMeta.run({ key: "schema_version", value: SCHEMA_VERSION });
}

function needsReset(db) {
  const tables = new Set(tableNames(db));
  if (!tables.has("app_meta")) return true;

  const versionRow = db
    .prepare("SELECT value FROM app_meta WHERE key = 'schema_version'")
    .get();
  if (!versionRow || versionRow.value !== SCHEMA_VERSION) return true;

  const deploymentColumns = new Set(getColumns(db, "model_deployments"));
  if (deploymentColumns.has("workforce_id") || !deploymentColumns.has("agent_id")) {
    return true;
  }

  const requestLogColumns = new Set(getColumns(db, "request_logs"));
  if (
    !requestLogColumns.has("transport") ||
    !requestLogColumns.has("upstream_conversation_id") ||
    !requestLogColumns.has("request_preview")
  ) {
    return true;
  }

  return false;
}

function markInflightLogsFailed(db) {
  db.prepare(`
    UPDATE request_logs
    SET status = 'failed',
        error_message = COALESCE(error_message, 'Gateway restarted before the request finished.')
    WHERE status IN ('started', 'streaming')
  `).run();
}

export function openDatabase(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  if (needsReset(db)) {
    console.warn("legacy or incompatible schema detected; rebuilding database");
    resetSchema(db);
    createSchema(db);
  } else {
    createSchema(db);
  }

  markInflightLogsFailed(db);
  return db;
}

export function normalizeBool(value) {
  return Boolean(value);
}

export function parseJson(value, fallback) {
  if (value == null || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function toIsoOrNull(value) {
  if (!value) return null;
  return new Date(value).toISOString();
}

export function nowUtc() {
  return nowIso();
}
