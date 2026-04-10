import fs from "node:fs";
import path from "node:path";

import { createClient as createLibsqlClient } from "@libsql/client";
import postgres from "postgres";

const SCHEMA_VERSION = "gateway-db-v3";
const POSTGRES_PROTOCOL = /^(postgres|postgresql):\/\//i;

function nowIso() {
  return new Date().toISOString();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toStatementArgs(args) {
  if (!args.length) return [];
  if (args.length === 1 && isPlainObject(args[0])) {
    return args[0];
  }
  return args;
}

function splitSqlStatements(sql) {
  const statements = [];
  let current = "";
  let quote = null;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if (!quote && char === "-" && next === "-") {
      while (index < sql.length && sql[index] !== "\n") {
        index += 1;
      }
      continue;
    }

    if (!quote && char === "/" && next === "*") {
      index += 2;
      while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) {
        index += 1;
      }
      index += 1;
      continue;
    }

    if (quote) {
      current += char;
      if (char === quote) {
        if (quote === "'" && next === "'") {
          current += next;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      current += char;
      continue;
    }

    if (char === ";") {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = "";
      continue;
    }

    current += char;
  }

  const trimmed = current.trim();
  if (trimmed) statements.push(trimmed);
  return statements;
}

function normalizeRow(row) {
  if (!row || typeof row !== "object") return row;
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeFieldValue(key, value)]),
  );
}

function normalizeRows(rows) {
  return Array.isArray(rows) ? rows.map(normalizeRow) : [];
}

function shouldCoerceIntegerField(key) {
  return /(^id$|_id$|^enabled$|^stream$|^count$|_count$|_tokens$|_ms$|_chars$|^consecutive_failures$)/.test(key);
}

function normalizeFieldValue(key, value) {
  if (typeof value === "bigint") {
    const normalized = Number(value);
    return Number.isSafeInteger(normalized) ? normalized : value.toString();
  }

  if (
    typeof value === "string" &&
    shouldCoerceIntegerField(key) &&
    /^-?\d+$/.test(value.trim())
  ) {
    const normalized = Number(value);
    return Number.isSafeInteger(normalized) ? normalized : value;
  }

  return value;
}

function coerceRowId(value) {
  if (value == null) return 0;
  if (typeof value === "bigint") return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeDatabaseUrl(databasePath) {
  if (!databasePath) {
    throw new Error("DATABASE_URL or POSTGRES_URL is required.");
  }
  if (
    databasePath.startsWith("file:") ||
    databasePath.startsWith("libsql:") ||
    databasePath.startsWith("http://") ||
    databasePath.startsWith("https://") ||
    POSTGRES_PROTOCOL.test(databasePath)
  ) {
    return databasePath;
  }
  return `file:${databasePath}`;
}

function usesPostgres(url) {
  return POSTGRES_PROTOCOL.test(url);
}

function transformSqlForPostgres(sql) {
  return sql.replace(/([A-Za-z_][\w.]*)\s+COLLATE\s+NOCASE/gi, "LOWER($1)");
}

function translatePositionalParams(sql, values) {
  let quote = null;
  let index = 0;
  let output = "";

  for (let cursor = 0; cursor < sql.length; cursor += 1) {
    const char = sql[cursor];
    const next = sql[cursor + 1];

    if (!quote && char === "-" && next === "-") {
      output += char;
      while (cursor + 1 < sql.length && sql[cursor + 1] !== "\n") {
        cursor += 1;
        output += sql[cursor];
      }
      continue;
    }

    if (!quote && char === "/" && next === "*") {
      output += char;
      cursor += 1;
      output += sql[cursor];
      while (cursor + 1 < sql.length && !(sql[cursor] === "*" && sql[cursor + 1] === "/")) {
        cursor += 1;
        output += sql[cursor];
      }
      if (cursor + 1 < sql.length) {
        cursor += 1;
        output += sql[cursor];
      }
      continue;
    }

    if (quote) {
      output += char;
      if (char === quote) {
        if (quote === "'" && next === "'") {
          cursor += 1;
          output += sql[cursor];
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      output += char;
      continue;
    }

    if (char === "?") {
      index += 1;
      output += `$${index}`;
      continue;
    }

    output += char;
  }

  return { sql: output, values };
}

function translateNamedParams(sql, argsObject) {
  let quote = null;
  let output = "";
  const values = [];
  const indexByName = new Map();

  for (let cursor = 0; cursor < sql.length; cursor += 1) {
    const char = sql[cursor];
    const next = sql[cursor + 1];

    if (!quote && char === "-" && next === "-") {
      output += char;
      while (cursor + 1 < sql.length && sql[cursor + 1] !== "\n") {
        cursor += 1;
        output += sql[cursor];
      }
      continue;
    }

    if (!quote && char === "/" && next === "*") {
      output += char;
      cursor += 1;
      output += sql[cursor];
      while (cursor + 1 < sql.length && !(sql[cursor] === "*" && sql[cursor + 1] === "/")) {
        cursor += 1;
        output += sql[cursor];
      }
      if (cursor + 1 < sql.length) {
        cursor += 1;
        output += sql[cursor];
      }
      continue;
    }

    if (quote) {
      output += char;
      if (char === quote) {
        if (quote === "'" && next === "'") {
          cursor += 1;
          output += sql[cursor];
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      output += char;
      continue;
    }

    if (char === "@") {
      let name = "";
      let lookahead = cursor + 1;
      while (lookahead < sql.length && /[A-Za-z0-9_]/.test(sql[lookahead])) {
        name += sql[lookahead];
        lookahead += 1;
      }
      if (name) {
        if (!indexByName.has(name)) {
          indexByName.set(name, values.length + 1);
          values.push(argsObject[name]);
        }
        output += `$${indexByName.get(name)}`;
        cursor = lookahead - 1;
        continue;
      }
    }

    output += char;
  }

  return { sql: output, values };
}

function translatePostgresQuery(rawSql, argsInput) {
  const sql = transformSqlForPostgres(rawSql);
  if (isPlainObject(argsInput)) {
    return translateNamedParams(sql, argsInput);
  }
  const values = Array.isArray(argsInput) ? argsInput : [];
  return translatePositionalParams(sql, values);
}

async function tableNames(db) {
  const result = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  return result.map((item) => item.name);
}

async function tableNamesPostgres(db) {
  const result = await db
    .prepare(`
      SELECT table_name AS name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `)
    .all();
  return result.map((item) => item.name);
}

async function getColumns(db, tableName) {
  try {
    const result = await db.prepare(`PRAGMA table_info(${tableName})`).all();
    return result.map((item) => item.name);
  } catch {
    return [];
  }
}

async function getColumnsPostgres(db, tableName) {
  try {
    const result = await db
      .prepare(`
        SELECT column_name AS name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ?
      `)
      .all(tableName);
    return result.map((item) => item.name);
  } catch {
    return [];
  }
}

async function resetSchemaLibsql(db) {
  const statements = [
    "DROP TABLE IF EXISTS request_logs",
    "DROP TABLE IF EXISTS model_catalog_cache",
    "DROP TABLE IF EXISTS gateway_api_keys",
    "DROP TABLE IF EXISTS model_deployments",
    "DROP TABLE IF EXISTS upstream_keys",
    "DROP TABLE IF EXISTS app_meta",
  ];
  await db.batch(statements, "write");
}

async function resetSchemaPostgres(db) {
  const statements = [
    "DROP TABLE IF EXISTS request_logs CASCADE",
    "DROP TABLE IF EXISTS model_catalog_cache CASCADE",
    "DROP TABLE IF EXISTS gateway_api_keys CASCADE",
    "DROP TABLE IF EXISTS model_deployments CASCADE",
    "DROP TABLE IF EXISTS upstream_keys CASCADE",
    "DROP TABLE IF EXISTS app_meta CASCADE",
  ];
  await db.batch(statements, "write");
}

async function createSchemaLibsql(db) {
  await db.exec(`
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
}

async function createSchemaPostgres(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS upstream_keys (
      id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
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
      id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      upstream_key_id BIGINT NOT NULL REFERENCES upstream_keys(id) ON DELETE CASCADE,
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
      id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      raw_key TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS model_catalog_cache (
      id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      project TEXT NOT NULL,
      region TEXT NOT NULL,
      model_subset TEXT NOT NULL DEFAULT 'AGENT',
      source_upstream_key_id BIGINT,
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
      id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      gateway_key_name TEXT,
      public_model_name TEXT NOT NULL,
      deployment_id BIGINT REFERENCES model_deployments(id) ON DELETE SET NULL,
      stream INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      latency_ms INTEGER,
      first_token_ms INTEGER,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      cost DOUBLE PRECISION,
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
}

async function setSchemaVersion(db) {
  await db.prepare(`
    INSERT INTO app_meta(key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run("schema_version", SCHEMA_VERSION);
}

async function needsResetLibsql(db) {
  const tables = new Set(await tableNames(db));
  if (!tables.has("app_meta")) return true;

  const versionRow = await db
    .prepare("SELECT value FROM app_meta WHERE key = 'schema_version'")
    .get();
  if (!versionRow || versionRow.value !== SCHEMA_VERSION) return true;

  const deploymentColumns = new Set(await getColumns(db, "model_deployments"));
  if (deploymentColumns.has("workforce_id") || !deploymentColumns.has("agent_id")) {
    return true;
  }

  const requestLogColumns = new Set(await getColumns(db, "request_logs"));
  if (
    !requestLogColumns.has("transport") ||
    !requestLogColumns.has("upstream_conversation_id") ||
    !requestLogColumns.has("request_preview")
  ) {
    return true;
  }

  return false;
}

async function needsResetPostgres(db) {
  const tables = new Set(await tableNamesPostgres(db));
  if (!tables.has("app_meta")) return true;

  const versionRow = await db
    .prepare("SELECT value FROM app_meta WHERE key = 'schema_version'")
    .get();
  if (!versionRow || versionRow.value !== SCHEMA_VERSION) return true;

  const deploymentColumns = new Set(await getColumnsPostgres(db, "model_deployments"));
  if (deploymentColumns.has("workforce_id") || !deploymentColumns.has("agent_id")) {
    return true;
  }

  const requestLogColumns = new Set(await getColumnsPostgres(db, "request_logs"));
  if (
    !requestLogColumns.has("transport") ||
    !requestLogColumns.has("upstream_conversation_id") ||
    !requestLogColumns.has("request_preview")
  ) {
    return true;
  }

  return false;
}

async function markInflightLogsFailed(db) {
  await db.prepare(`
    UPDATE request_logs
    SET status = 'failed',
        error_message = COALESCE(error_message, 'Gateway restarted before the request finished.')
    WHERE status IN ('started', 'streaming')
  `).run();
}

function createLibsqlCompatDatabase(client) {
  return {
    kind: "libsql",
    prepare(sql) {
      return {
        async get(...args) {
          const result = await client.execute({
            sql,
            args: toStatementArgs(args),
          });
          return normalizeRow(result.rows[0]) || undefined;
        },
        async all(...args) {
          const result = await client.execute({
            sql,
            args: toStatementArgs(args),
          });
          return normalizeRows(result.rows);
        },
        async run(...args) {
          const result = await client.execute({
            sql,
            args: toStatementArgs(args),
          });
          return {
            rowsAffected: Number(result.rowsAffected || 0),
            lastInsertRowid: coerceRowId(result.lastInsertRowid ?? result.rows?.[0]?.id),
          };
        },
      };
    },
    async exec(sql) {
      const statements = splitSqlStatements(sql);
      if (!statements.length) return;
      await client.batch(statements, "write");
    },
    async batch(statements, mode = "write") {
      return client.batch(statements, mode);
    },
    async close() {
      client.close();
    },
  };
}

function createPostgresCompatDatabase(client) {
  async function execute(rawSql, argsInput, { expectSingle = false } = {}) {
    const translated = translatePostgresQuery(rawSql, argsInput);
    const result = await client.unsafe(translated.sql, translated.values);
    if (expectSingle) {
      return normalizeRow(result[0]) || undefined;
    }
    return result;
  }

  return {
    kind: "postgres",
    prepare(sql) {
      return {
        async get(...args) {
          return await execute(sql, toStatementArgs(args), { expectSingle: true });
        },
        async all(...args) {
          const result = await execute(sql, toStatementArgs(args));
          return normalizeRows(result);
        },
        async run(...args) {
          const result = await execute(sql, toStatementArgs(args));
          return {
            rowsAffected: Number(result.count || 0),
            lastInsertRowid: coerceRowId(result[0]?.id),
          };
        },
      };
    },
    async exec(sql) {
      const statements = splitSqlStatements(sql);
      if (!statements.length) return;
      await client.begin(async (tx) => {
        for (const statement of statements) {
          await tx.unsafe(statement);
        }
      });
    },
    async batch(statements) {
      return await client.begin(async (tx) => {
        const results = [];
        for (const statement of statements) {
          if (typeof statement === "string") {
            results.push(await tx.unsafe(transformSqlForPostgres(statement)));
            continue;
          }
          const translated = translatePostgresQuery(statement.sql, statement.args || []);
          results.push(await tx.unsafe(translated.sql, translated.values));
        }
        return results;
      });
    },
    async close() {
      await client.end({ timeout: 5 });
    },
  };
}

function createDatabaseClient(normalizedUrl) {
  if (usesPostgres(normalizedUrl)) {
    return createPostgresCompatDatabase(
      postgres(normalizedUrl, {
        prepare: false,
        max: 1,
        idle_timeout: 20,
        connect_timeout: 30,
        ssl: "require",
      }),
    );
  }

  if (normalizedUrl.startsWith("file:")) {
    fs.mkdirSync(path.dirname(normalizedUrl.slice("file:".length)), { recursive: true });
  }

  return createLibsqlCompatDatabase(
    createLibsqlClient({
      url: normalizedUrl,
      authToken:
        process.env.DATABASE_AUTH_TOKEN ||
        process.env.TURSO_AUTH_TOKEN ||
        process.env.LIBSQL_AUTH_TOKEN ||
        undefined,
      intMode: "number",
    }),
  );
}

export async function openDatabase(databasePath) {
  const normalizedUrl = normalizeDatabaseUrl(databasePath);
  const db = createDatabaseClient(normalizedUrl);
  const isPostgres = db.kind === "postgres";

  const reset = isPostgres ? needsResetPostgres : needsResetLibsql;
  const rebuild = isPostgres ? resetSchemaPostgres : resetSchemaLibsql;
  const create = isPostgres ? createSchemaPostgres : createSchemaLibsql;

  if (await reset(db)) {
    console.warn("legacy or incompatible schema detected; rebuilding database");
    await rebuild(db);
    await create(db);
    await setSchemaVersion(db);
  } else {
    await create(db);
    await setSchemaVersion(db);
  }

  await markInflightLogsFailed(db);
  return db;
}

export function normalizeBool(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "bigint") return value !== 0n;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return false;
    if (["0", "false", "f", "no", "off"].includes(normalized)) return false;
    if (["1", "true", "t", "yes", "on"].includes(normalized)) return true;
  }
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
