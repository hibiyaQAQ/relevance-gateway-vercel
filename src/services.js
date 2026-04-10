import crypto from "node:crypto";

import { settings } from "./config.js";
import { nowUtc, normalizeBool, parseJson } from "./db.js";
import { RelevanceError, RelevanceRestClient, extractCostAndCredits } from "./relevance-rest.js";
import { generateGatewayKey } from "./security.js";

const DEPLOYMENT_FIELDS = ["public_model_name", "display_name", "upstream_model"];

function truncate(value, maxLength = 4000) {
  const text = String(value || "");
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function boolToInt(value) {
  return value ? 1 : 0;
}

function requestLogStatusCode(status) {
  return (
    {
      started: 102,
      streaming: 206,
      completed: 200,
      failed: 502,
    }[status] || 500
  );
}

function getMaterial(upstreamKey) {
  return {
    project: upstreamKey.project,
    region: upstreamKey.region,
    apiKey: upstreamKey.api_key,
  };
}

function listDeploymentsForUpstreamKey(db, upstreamKeyId) {
  return db
    .prepare(
      `
        SELECT *
        FROM model_deployments
        WHERE upstream_key_id = ?
        ORDER BY display_name COLLATE NOCASE ASC, id ASC
      `,
    )
    .all(upstreamKeyId);
}

function getUpstreamKey(db, upstreamKeyId) {
  return db.prepare("SELECT * FROM upstream_keys WHERE id = ?").get(upstreamKeyId) || null;
}

function getGatewayKey(db, gatewayKeyId) {
  return db
    .prepare("SELECT * FROM gateway_api_keys WHERE id = ?")
    .get(gatewayKeyId) || null;
}

function getDeployment(db, deploymentId) {
  return db
    .prepare(
      `
        SELECT d.*, u.project, u.region, u.api_key, u.name AS upstream_key_name, u.enabled AS upstream_key_enabled
        FROM model_deployments d
        JOIN upstream_keys u ON u.id = d.upstream_key_id
        WHERE d.id = ?
      `,
    )
    .get(deploymentId) || null;
}

function serializeDeployment(row) {
  return {
    id: row.id,
    upstream_key_id: row.upstream_key_id,
    public_model_name: row.public_model_name,
    display_name: row.display_name,
    upstream_model: row.upstream_model,
    agent_id: row.agent_id,
    agent_name: row.agent_name,
    enabled: normalizeBool(row.enabled),
    status: row.status,
    last_error: row.last_error,
    last_used_at: row.last_used_at,
    last_latency_ms: row.last_latency_ms,
    consecutive_failures: row.consecutive_failures,
    cooldown_until: row.cooldown_until,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function serializeUpstreamKey(row, deployments = []) {
  return {
    id: row.id,
    name: row.name,
    project: row.project,
    region: row.region,
    api_key: row.api_key,
    enabled: normalizeBool(row.enabled),
    status: row.status || "unknown",
    last_error: row.last_error,
    last_check_at: row.last_check_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deployments: deployments.map(serializeDeployment),
  };
}

function serializeGatewayKey(row) {
  return {
    id: row.id,
    name: row.name,
    raw_key: row.raw_key,
    enabled: normalizeBool(row.enabled),
    created_at: row.created_at,
  };
}

function serializeModelCatalog(row) {
  const refreshedAt = row.last_refreshed_at;
  let isStale = true;
  if (refreshedAt) {
    const ageSeconds = (Date.now() - new Date(refreshedAt).getTime()) / 1000;
    isStale = ageSeconds > settings.modelCatalogTtlSeconds;
  }

  return {
    id: row.id,
    project: row.project,
    region: row.region,
    model_subset: row.model_subset,
    source_upstream_key_id: row.source_upstream_key_id,
    source_upstream_key_name: row.source_upstream_key_name,
    model_count: row.model_count,
    models: parseJson(row.models_json, []),
    last_error: row.last_error,
    last_refreshed_at: row.last_refreshed_at,
    is_stale: isStale,
  };
}

function serializeRequestLog(row) {
  return {
    id: row.id,
    request_id: row.request_id,
    model: row.public_model_name,
    gateway_key_name: row.gateway_key_name || "anonymous",
    deployment_id: row.deployment_id,
    stream: normalizeBool(row.stream),
    status: row.status,
    status_code: requestLogStatusCode(row.status),
    latency_ms: row.latency_ms || 0,
    first_token_ms: row.first_token_ms,
    prompt_tokens: row.prompt_tokens,
    completion_tokens: row.completion_tokens,
    total_tokens: row.total_tokens,
    cost: row.cost,
    credits_used: parseJson(row.credits_used_json, null),
    transport: row.transport,
    upstream_conversation_id: row.upstream_conversation_id,
    request_preview: row.request_preview,
    response_preview: row.response_preview,
    thinking_preview: row.thinking_preview,
    emitted_content_chars: row.emitted_content_chars,
    emitted_thinking_chars: row.emitted_thinking_chars,
    error_message: row.error_message,
    created_at: row.created_at,
  };
}

function clampPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

export function normalizePagination({ page, pageSize, defaultPageSize = 20, maxPageSize = 100 } = {}) {
  const currentPage = clampPositiveInt(page, 1);
  const normalizedPageSize = Math.min(
    clampPositiveInt(pageSize, defaultPageSize),
    maxPageSize,
  );
  return {
    page: currentPage,
    pageSize: normalizedPageSize,
    offset: (currentPage - 1) * normalizedPageSize,
  };
}

export function buildPaginatedResponse(items, total, page, pageSize) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return {
    items,
    pagination: {
      page,
      page_size: pageSize,
      total,
      total_pages: totalPages,
    },
  };
}

export function normalizeMessageContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item || typeof item !== "object") {
          throw new Error("Only text content blocks are supported.");
        }
        if (item.type !== "text" || typeof item.text !== "string") {
          throw new Error("Only text content blocks are supported.");
        }
        return item.text;
      })
      .join("");
  }
  throw new Error("Message content must be a string or an array of text blocks.");
}

export function normalizeMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) {
    throw new Error("messages must be a non-empty array.");
  }
  return messages.map((item) => {
    if (!item || typeof item !== "object") {
      throw new Error("Each message must be an object.");
    }
    if (typeof item.role !== "string" || !item.role.trim()) {
      throw new Error("Each message must include a role.");
    }
    return {
      role: item.role.trim(),
      content: normalizeMessageContent(item.content),
    };
  });
}

export function buildPrompt(messages) {
  const lines = [
    "<System>",
    "Treat the transcript below as the full conversation context from the gateway.",
    "Answer the final user message directly and naturally.",
    "</System>",
    "",
    "<Transcript>",
  ];

  for (const item of messages) {
    lines.push(`[${item.role}]`);
    lines.push(item.content);
    lines.push(`[/${item.role}]`);
    lines.push("");
  }

  lines.push("</Transcript>");
  return lines.join("\n");
}

export function getBootstrapData(db) {
  const upstreamKeys = db
    .prepare("SELECT * FROM upstream_keys ORDER BY id ASC")
    .all()
    .map((row) => serializeUpstreamKey(row, listDeploymentsForUpstreamKey(db, row.id)));

  const gatewayKeys = db
    .prepare("SELECT * FROM gateway_api_keys ORDER BY id ASC")
    .all()
    .map(serializeGatewayKey);

  const requestLogs = db
    .prepare("SELECT * FROM request_logs ORDER BY created_at DESC, id DESC LIMIT 50")
    .all()
    .map(serializeRequestLog);

  return {
    settings: {
      app_name: settings.appName,
      buffered_stream_enabled: settings.enableBufferedStreamCompat,
      runtime: "node-sdk-agent",
    },
    upstream_keys: upstreamKeys,
    gateway_keys: gatewayKeys,
    request_logs: requestLogs,
  };
}

export function listRequestLogsPage(db, { page, pageSize }) {
  const pagination = normalizePagination({
    page,
    pageSize,
    defaultPageSize: 20,
    maxPageSize: 100,
  });
  const total = db.prepare("SELECT COUNT(*) AS count FROM request_logs").get().count;
  const items = db
    .prepare(
      `
        SELECT *
        FROM request_logs
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?
      `,
    )
    .all(pagination.pageSize, pagination.offset)
    .map(serializeRequestLog);

  return buildPaginatedResponse(items, total, pagination.page, pagination.pageSize);
}

export function authenticateGatewayKey(db, rawKey) {
  if (!rawKey) return null;
  return (
    db
      .prepare(
        "SELECT * FROM gateway_api_keys WHERE raw_key = ? AND enabled = 1",
      )
      .get(rawKey) || null
  );
}

export async function validateRelevanceCredentials({ project, region, apiKey }) {
  const client = new RelevanceRestClient(
    {
      project: project.trim(),
      region: region.trim(),
      apiKey: apiKey.trim(),
    },
    settings.modelCatalogRefreshTimeoutSeconds,
  );
  const agents = await client.listAgents();
  return { status: "active", agentCount: agents.length };
}

export async function createUpstreamKey(db, payload) {
  const result = await validateRelevanceCredentials({
    project: payload.project,
    region: payload.region,
    apiKey: payload.api_key,
  });
  const now = nowUtc();
  const statement = db.prepare(`
    INSERT INTO upstream_keys(name, project, region, api_key, enabled, status, last_error, last_check_at, created_at, updated_at)
    VALUES (@name, @project, @region, @api_key, 1, @status, NULL, @last_check_at, @created_at, @updated_at)
  `);
  const info = statement.run({
    name: payload.name.trim(),
    project: payload.project.trim(),
    region: payload.region.trim(),
    api_key: payload.api_key.trim(),
    status: result.status,
    last_check_at: now,
    created_at: now,
    updated_at: now,
  });
  return getUpstreamKey(db, Number(info.lastInsertRowid));
}

export async function updateUpstreamKey(db, upstreamKeyId, payload) {
  const current = getUpstreamKey(db, upstreamKeyId);
  if (!current) {
    throw new Error("Upstream key not found.");
  }

  const nextValue = {
    name: (payload.name ?? current.name).trim(),
    project: (payload.project ?? current.project).trim(),
    region: (payload.region ?? current.region).trim(),
    api_key: (payload.api_key ?? current.api_key).trim(),
    enabled: payload.enabled == null ? normalizeBool(current.enabled) : Boolean(payload.enabled),
  };

  const credentialsChanged =
    nextValue.project !== current.project ||
    nextValue.region !== current.region ||
    nextValue.api_key !== current.api_key;
  const shouldValidate = credentialsChanged || (nextValue.enabled && !normalizeBool(current.enabled));

  let status = current.status;
  let lastError = current.last_error;
  let lastCheckAt = current.last_check_at;

  if (shouldValidate) {
    const result = await validateRelevanceCredentials({
      project: nextValue.project,
      region: nextValue.region,
      apiKey: nextValue.api_key,
    });
    status = result.status;
    lastError = null;
    lastCheckAt = nowUtc();
  }

  db.prepare(`
    UPDATE upstream_keys
    SET name = @name,
        project = @project,
        region = @region,
        api_key = @api_key,
        enabled = @enabled,
        status = @status,
        last_error = @last_error,
        last_check_at = @last_check_at,
        updated_at = @updated_at
    WHERE id = @id
  `).run({
    id: upstreamKeyId,
    name: nextValue.name,
    project: nextValue.project,
    region: nextValue.region,
    api_key: nextValue.api_key,
    enabled: boolToInt(nextValue.enabled),
    status,
    last_error: lastError,
    last_check_at: lastCheckAt,
    updated_at: nowUtc(),
  });

  return getUpstreamKey(db, upstreamKeyId);
}

export async function verifyUpstreamKey(db, upstreamKeyId) {
  const upstreamKey = getUpstreamKey(db, upstreamKeyId);
  if (!upstreamKey) {
    throw new Error("Upstream key not found.");
  }

  try {
    const client = new RelevanceRestClient(getMaterial(upstreamKey));
    const agents = await client.listAgents();
    const now = nowUtc();
    db.prepare(`
      UPDATE upstream_keys
      SET status = 'active',
          last_error = NULL,
          last_check_at = @last_check_at,
          updated_at = @updated_at
      WHERE id = @id
    `).run({
      id: upstreamKeyId,
      last_check_at: now,
      updated_at: now,
    });
    return { status: "active", agent_count: agents.length };
  } catch (error) {
    const now = nowUtc();
    db.prepare(`
      UPDATE upstream_keys
      SET status = 'invalid',
          last_error = @last_error,
          last_check_at = @last_check_at,
          updated_at = @updated_at
      WHERE id = @id
    `).run({
      id: upstreamKeyId,
      last_error: String(error.message || error),
      last_check_at: now,
      updated_at: now,
    });
    throw error;
  }
}

export function findModelCatalogCache(db, { project, region, modelSubset = "AGENT" }) {
  const row =
    db
      .prepare(
        `
          SELECT *
          FROM model_catalog_cache
          WHERE project = ? AND region = ? AND model_subset = ?
        `,
      )
      .get(project, region, modelSubset) || null;
  return row;
}

export function pickCatalogSourceKey(db, upstreamKeyId = null) {
  if (upstreamKeyId != null) {
    const key = getUpstreamKey(db, upstreamKeyId);
    return key && normalizeBool(key.enabled) ? key : null;
  }

  const keys = db
    .prepare("SELECT * FROM upstream_keys WHERE enabled = 1 ORDER BY id ASC")
    .all();
  if (!keys.length) return null;
  const active = keys.filter((item) => item.status === "active");
  const pool = active.length ? active : keys;
  return pool[Math.floor(Math.random() * pool.length)];
}

export async function refreshModelCatalog(db, upstreamKey) {
  const client = new RelevanceRestClient(
    getMaterial(upstreamKey),
    settings.modelCatalogRefreshTimeoutSeconds,
  );
  const models = await client.listAgentModels("AGENT");
  const existing = findModelCatalogCache(db, {
    project: upstreamKey.project,
    region: upstreamKey.region,
    modelSubset: "AGENT",
  });
  const now = nowUtc();

  if (existing) {
    db.prepare(`
      UPDATE model_catalog_cache
      SET source_upstream_key_id = @source_upstream_key_id,
          source_upstream_key_name = @source_upstream_key_name,
          models_json = @models_json,
          model_count = @model_count,
          last_error = NULL,
          last_refreshed_at = @last_refreshed_at,
          updated_at = @updated_at
      WHERE id = @id
    `).run({
      id: existing.id,
      source_upstream_key_id: upstreamKey.id,
      source_upstream_key_name: upstreamKey.name,
      models_json: JSON.stringify(models),
      model_count: models.length,
      last_refreshed_at: now,
      updated_at: now,
    });
    return findModelCatalogCache(db, {
      project: upstreamKey.project,
      region: upstreamKey.region,
      modelSubset: "AGENT",
    });
  }

  const info = db.prepare(`
    INSERT INTO model_catalog_cache(
      project,
      region,
      model_subset,
      source_upstream_key_id,
      source_upstream_key_name,
      models_json,
      model_count,
      last_error,
      last_refreshed_at,
      created_at,
      updated_at
    )
    VALUES (
      @project,
      @region,
      'AGENT',
      @source_upstream_key_id,
      @source_upstream_key_name,
      @models_json,
      @model_count,
      NULL,
      @last_refreshed_at,
      @created_at,
      @updated_at
    )
  `).run({
    project: upstreamKey.project,
    region: upstreamKey.region,
    source_upstream_key_id: upstreamKey.id,
    source_upstream_key_name: upstreamKey.name,
    models_json: JSON.stringify(models),
    model_count: models.length,
    last_refreshed_at: now,
    created_at: now,
    updated_at: now,
  });

  return db.prepare("SELECT * FROM model_catalog_cache WHERE id = ?").get(info.lastInsertRowid);
}

function findMatchingCatalogModel(models, upstreamModel) {
  return models.find(
    (item) =>
      item &&
      typeof item === "object" &&
      String(item.value || "").trim() === upstreamModel,
  );
}

export async function resolveModelIdentity(db, upstreamKey, upstreamModel) {
  const normalized = String(upstreamModel || "").trim();
  if (!normalized) throw new Error("Upstream model is required.");

  let cache = findModelCatalogCache(db, {
    project: upstreamKey.project,
    region: upstreamKey.region,
    modelSubset: "AGENT",
  });
  let models = cache ? parseJson(cache.models_json, []) : [];
  let matched = findMatchingCatalogModel(models, normalized);
  if (!matched) {
    cache = await refreshModelCatalog(db, upstreamKey);
    models = parseJson(cache.models_json, []);
    matched = findMatchingCatalogModel(models, normalized);
  }

  const displayName = String(matched?.label || normalized).trim() || normalized;
  const maxOutputTokens = Number(matched?.max_output_tokens || 0);
  return {
    public_model_name: normalized,
    display_name: displayName,
    upstream_model: normalized,
    max_output_tokens: Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
      ? maxOutputTokens
      : null,
  };
}

export function ensureNoConflictingDeploymentDefinition(
  db,
  { publicModelName, upstreamModel, excludeDeploymentId = null },
) {
  const rows = db
    .prepare(
      "SELECT * FROM model_deployments WHERE public_model_name = ? ORDER BY id ASC",
    )
    .all(publicModelName.trim());

  for (const row of rows) {
    if (excludeDeploymentId != null && row.id === excludeDeploymentId) continue;
    if (row.upstream_model !== upstreamModel.trim()) {
      throw new Error(
        `Public model name '${publicModelName.trim()}' is already used by another deployment with different settings.`,
      );
    }
  }
}

function buildAgentName(publicModelName, upstreamKeyName) {
  return `gw-${publicModelName}-${upstreamKeyName}-${Math.random().toString(16).slice(2, 10)}`;
}

async function createOrUpdateUpstreamAgent({
  upstreamKey,
  deploymentId = null,
  agentId = null,
  agentName,
  upstreamModel,
  maxOutputTokens = null,
}) {
  const client = new RelevanceRestClient(getMaterial(upstreamKey));
  const resolvedAgentId = await client.upsertAgent({
    ...(agentId ? { agent_id: agentId } : {}),
    name: agentName,
    model: upstreamModel,
    ...(maxOutputTokens ? { model_options: { max_output_tokens: maxOutputTokens } } : {}),
    suggest_replies: false,
    actions: [],
    knowledge: [],
  });
  const agent = await client.getAgent(resolvedAgentId);
  const toolListing = await client.listAgentTools(resolvedAgentId);

  if (agent?.model !== upstreamModel) {
    throw new RelevanceError("Upstream model did not persist as expected.");
  }
  if (Array.isArray(agent?.actions) && agent.actions.length) {
    throw new RelevanceError("Upstream agent unexpectedly persisted actions.");
  }
  if (Array.isArray(agent?.knowledge) && agent.knowledge.length) {
    throw new RelevanceError("Upstream agent unexpectedly persisted knowledge.");
  }
  if (Array.isArray(toolListing?.results) && toolListing.results.length) {
    throw new RelevanceError("Upstream agent unexpectedly exposes tools.");
  }

  return {
    agentId: resolvedAgentId,
    agentName: agent?.name || agentName,
  };
}

export async function createDeployment(db, upstreamKeyId, payload) {
  const upstreamKey = getUpstreamKey(db, upstreamKeyId);
  if (!upstreamKey) throw new Error("Upstream key not found.");

  const values = await resolveModelIdentity(db, upstreamKey, payload.upstream_model);
  ensureNoConflictingDeploymentDefinition(db, {
    publicModelName: values.public_model_name,
    upstreamModel: values.upstream_model,
  });

  const existing = db
    .prepare(
      `
        SELECT *
        FROM model_deployments
        WHERE upstream_key_id = ? AND public_model_name = ?
      `,
    )
    .get(upstreamKey.id, values.public_model_name);
  if (existing) {
    throw new Error(
      `Deployment '${values.public_model_name}' already exists on upstream key '${upstreamKey.name}'.`,
    );
  }

  const agentName = buildAgentName(values.public_model_name, upstreamKey.name);
  const upstreamAgent = await createOrUpdateUpstreamAgent({
    upstreamKey,
    agentName,
    upstreamModel: values.upstream_model,
    maxOutputTokens: values.max_output_tokens,
  });

  const now = nowUtc();
  const info = db.prepare(`
    INSERT INTO model_deployments(
      upstream_key_id,
      public_model_name,
      display_name,
      upstream_model,
      agent_id,
      agent_name,
      enabled,
      status,
      last_error,
      last_used_at,
      last_latency_ms,
      consecutive_failures,
      cooldown_until,
      created_at,
      updated_at
    )
    VALUES (
      @upstream_key_id,
      @public_model_name,
      @display_name,
      @upstream_model,
      @agent_id,
      @agent_name,
      1,
      'active',
      NULL,
      NULL,
      NULL,
      0,
      NULL,
      @created_at,
      @updated_at
    )
  `).run({
    upstream_key_id: upstreamKey.id,
    public_model_name: values.public_model_name,
    display_name: values.display_name,
    upstream_model: values.upstream_model,
    agent_id: upstreamAgent.agentId,
    agent_name: upstreamAgent.agentName,
    created_at: now,
    updated_at: now,
  });

  return getDeployment(db, Number(info.lastInsertRowid));
}

export async function createDeploymentsBatch(db, upstreamKeyId, upstreamModels) {
  const upstreamKey = getUpstreamKey(db, upstreamKeyId);
  if (!upstreamKey) throw new Error("Upstream key not found.");

  const created = [];
  const skipped = [];
  const failed = [];
  const seen = new Set();

  for (const rawModel of upstreamModels || []) {
    const upstreamModel = String(rawModel || "").trim();
    if (!upstreamModel || seen.has(upstreamModel)) continue;
    seen.add(upstreamModel);

    const existing = db
      .prepare(
        `
          SELECT *
          FROM model_deployments
          WHERE upstream_key_id = ? AND upstream_model = ?
        `,
      )
      .get(upstreamKey.id, upstreamModel);

    if (existing) {
      skipped.push({
        upstream_model: upstreamModel,
        reason: "deployment already exists on this key",
        deployment: serializeDeployment(existing),
      });
      continue;
    }

    try {
      const deployment = await createDeployment(db, upstreamKey.id, {
        upstream_model: upstreamModel,
      });
      created.push(serializeDeployment(deployment));
    } catch (error) {
      failed.push({
        upstream_model: upstreamModel,
        reason: String(error.message || error),
      });
    }
  }

  return { created, skipped, failed };
}

export async function updateDeployment(db, upstreamKeyId, deploymentId, payload) {
  const deployment = getDeployment(db, deploymentId);
  if (!deployment || deployment.upstream_key_id !== upstreamKeyId) {
    throw new Error("Deployment not found.");
  }

  const upstreamKey = getUpstreamKey(db, deployment.upstream_key_id);
  const nextValues = await resolveModelIdentity(
    db,
    upstreamKey,
    payload.upstream_model || deployment.upstream_model,
  );

  ensureNoConflictingDeploymentDefinition(db, {
    publicModelName: nextValues.public_model_name,
    upstreamModel: nextValues.upstream_model,
    excludeDeploymentId: deployment.id,
  });

  const nextEnabled =
    payload.enabled == null ? normalizeBool(deployment.enabled) : Boolean(payload.enabled);
  const definitionChanged = DEPLOYMENT_FIELDS.some(
    (field) => deployment[field] !== nextValues[field],
  );

  if (definitionChanged) {
    await createOrUpdateUpstreamAgent({
      upstreamKey,
      deploymentId: deployment.id,
      agentId: deployment.agent_id,
      agentName: deployment.agent_name,
      upstreamModel: nextValues.upstream_model,
      maxOutputTokens: nextValues.max_output_tokens,
    });
  }

  db.prepare(`
    UPDATE model_deployments
    SET public_model_name = @public_model_name,
        display_name = @display_name,
        upstream_model = @upstream_model,
        enabled = @enabled,
        updated_at = @updated_at
    WHERE id = @id
  `).run({
    id: deployment.id,
    public_model_name: nextValues.public_model_name,
    display_name: nextValues.display_name,
    upstream_model: nextValues.upstream_model,
    enabled: boolToInt(nextEnabled),
    updated_at: nowUtc(),
  });

  return getDeployment(db, deployment.id);
}

export async function deleteDeployment(db, upstreamKeyId, deploymentId) {
  const deployment = getDeployment(db, deploymentId);
  if (!deployment || deployment.upstream_key_id !== upstreamKeyId) {
    throw new Error("Deployment not found.");
  }

  const warnings = [];
  try {
    const client = new RelevanceRestClient(getMaterial(deployment));
    await client.deleteAgent(deployment.agent_id);
  } catch (error) {
    warnings.push(`Failed to delete upstream agent ${deployment.agent_id}: ${error.message || error}`);
  }

  db.prepare("DELETE FROM model_deployments WHERE id = ?").run(deployment.id);
  return { deleted: true, warnings };
}

export async function deleteUpstreamKey(db, upstreamKeyId) {
  const upstreamKey = getUpstreamKey(db, upstreamKeyId);
  if (!upstreamKey) throw new Error("Upstream key not found.");

  const deployments = listDeploymentsForUpstreamKey(db, upstreamKeyId);
  const warnings = [];
  for (const deployment of deployments) {
    const result = await deleteDeployment(db, upstreamKeyId, deployment.id);
    warnings.push(...(result.warnings || []));
  }

  db.prepare("DELETE FROM upstream_keys WHERE id = ?").run(upstreamKeyId);
  return { deleted: true, warnings };
}

export async function syncDeploymentsToKeys(
  db,
  sourceUpstreamKeyId,
  { target_upstream_key_ids = [], public_model_names = [] },
) {
  const sourceKey = getUpstreamKey(db, sourceUpstreamKeyId);
  if (!sourceKey) throw new Error("Source upstream key not found.");

  const targetIds = target_upstream_key_ids.length
    ? target_upstream_key_ids
    : db
        .prepare("SELECT id FROM upstream_keys WHERE id != ? ORDER BY id ASC")
        .all(sourceUpstreamKeyId)
        .map((item) => item.id);

  let sourceDeployments = listDeploymentsForUpstreamKey(db, sourceUpstreamKeyId);
  if (public_model_names.length) {
    const allowed = new Set(public_model_names);
    sourceDeployments = sourceDeployments.filter((item) => allowed.has(item.public_model_name));
  }

  const created = [];
  const skipped = [];
  const failed = [];

  for (const targetId of targetIds) {
    const targetKey = getUpstreamKey(db, targetId);
    if (!targetKey || targetKey.id === sourceKey.id) continue;

    for (const sourceDeployment of sourceDeployments) {
      const existing = db
        .prepare(
          `
            SELECT *
            FROM model_deployments
            WHERE upstream_key_id = ? AND public_model_name = ?
          `,
        )
        .get(targetKey.id, sourceDeployment.public_model_name);

      if (existing) {
        skipped.push({
          target_upstream_key_id: targetKey.id,
          target_upstream_key_name: targetKey.name,
          public_model_name: sourceDeployment.public_model_name,
          reason: "deployment already exists",
        });
        continue;
      }

      try {
        const deployment = await createDeployment(db, targetKey.id, {
          upstream_model: sourceDeployment.upstream_model,
        });
        created.push({
          target_upstream_key_id: targetKey.id,
          target_upstream_key_name: targetKey.name,
          deployment: serializeDeployment(deployment),
        });
      } catch (error) {
        failed.push({
          target_upstream_key_id: targetKey.id,
          target_upstream_key_name: targetKey.name,
          public_model_name: sourceDeployment.public_model_name,
          reason: String(error.message || error),
        });
      }
    }
  }

  return { created, skipped, failed };
}

export function listUpstreamAgents(db, upstreamKeyId) {
  const upstreamKey = getUpstreamKey(db, upstreamKeyId);
  if (!upstreamKey) throw new Error("Upstream key not found.");
  return { upstreamKey };
}

export async function fetchUpstreamAgents(db, upstreamKeyId) {
  const upstreamKey = getUpstreamKey(db, upstreamKeyId);
  if (!upstreamKey) throw new Error("Upstream key not found.");

  const client = new RelevanceRestClient(getMaterial(upstreamKey));
  const agents = await client.listAgents();
  const deployments = db.prepare("SELECT * FROM model_deployments").all();
  const deploymentByAgentId = new Map(deployments.map((item) => [item.agent_id, item]));
  const keyById = new Map(
    db.prepare("SELECT id, name FROM upstream_keys ORDER BY id ASC").all().map((item) => [item.id, item.name]),
  );

  const items = agents
    .map((agent) => {
      const agentId = agent.agent_id || agent._id;
      if (!agentId) return null;
      const deployment = deploymentByAgentId.get(agentId) || null;
      return {
        agent_id: agentId,
        agent_name: agent.name || "Unnamed agent",
        upstream_model: agent.model || null,
        managed_by_gateway: Boolean(deployment),
        deployment_id: deployment?.id ?? null,
        public_model_name: deployment?.public_model_name ?? null,
        display_name: deployment?.display_name ?? null,
        enabled: deployment ? normalizeBool(deployment.enabled) : null,
        owner_upstream_key_id: deployment?.upstream_key_id ?? null,
        owner_upstream_key_name: deployment ? keyById.get(deployment.upstream_key_id) : null,
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      const leftManaged = left.managed_by_gateway ? 0 : 1;
      const rightManaged = right.managed_by_gateway ? 0 : 1;
      if (leftManaged !== rightManaged) return leftManaged - rightManaged;
      return String(left.public_model_name || left.agent_name).localeCompare(
        String(right.public_model_name || right.agent_name),
      );
    });

  return items;
}

export async function deleteUpstreamAgents(db, upstreamKeyId, agentIds) {
  const upstreamKey = getUpstreamKey(db, upstreamKeyId);
  if (!upstreamKey) throw new Error("Upstream key not found.");

  const client = new RelevanceRestClient(getMaterial(upstreamKey));
  const deleted = [];
  const failed = [];
  const lookup = new Map(
    db
      .prepare(
        "SELECT * FROM model_deployments WHERE agent_id IN (" +
          agentIds.map(() => "?").join(",") +
          ")",
      )
      .all(...agentIds)
      .map((item) => [item.agent_id, item]),
  );

  for (const agentId of agentIds) {
    const deployment = lookup.get(agentId) || null;
    try {
      await client.deleteAgent(agentId);
      if (deployment) {
        db.prepare("DELETE FROM model_deployments WHERE id = ?").run(deployment.id);
      }
      deleted.push({
        agent_id: agentId,
        managed_by_gateway: Boolean(deployment),
        public_model_name: deployment?.public_model_name ?? null,
      });
    } catch (error) {
      failed.push({ agent_id: agentId, reason: String(error.message || error) });
    }
  }

  return { deleted, failed };
}

export function createGatewayApiKey(db, payload) {
  const rawKey = generateGatewayKey();
  const now = nowUtc();
  const info = db.prepare(`
    INSERT INTO gateway_api_keys(name, raw_key, enabled, created_at)
    VALUES (?, ?, 1, ?)
  `).run(payload.name.trim(), rawKey, now);
  return {
    gatewayKey: getGatewayKey(db, Number(info.lastInsertRowid)),
    rawKey,
  };
}

export function deleteGatewayApiKey(db, gatewayKeyId) {
  const key = getGatewayKey(db, gatewayKeyId);
  if (!key) throw new Error("Gateway API key not found.");
  db.prepare("DELETE FROM gateway_api_keys WHERE id = ?").run(gatewayKeyId);
  return { deleted: true };
}

export function selectDeploymentForModel(db, publicModelName) {
  const selected = db
    .prepare(
      `
        SELECT d.*, u.project, u.region, u.api_key, u.name AS upstream_key_name, u.enabled AS upstream_key_enabled
        FROM model_deployments d
        JOIN upstream_keys u ON u.id = d.upstream_key_id
        WHERE d.enabled = 1
          AND d.status = 'active'
          AND u.enabled = 1
          AND d.public_model_name = ?
        ORDER BY
          CASE WHEN d.last_used_at IS NOT NULL THEN 1 ELSE 0 END ASC,
          d.last_used_at ASC,
          d.id ASC
      `,
    )
    .get(publicModelName);
  if (!selected) return null;

  db.prepare(
    "UPDATE model_deployments SET last_used_at = ?, updated_at = ? WHERE id = ?",
  ).run(nowUtc(), nowUtc(), selected.id);

  return getDeployment(db, selected.id);
}

export function beginGatewayRequest(db, { deployment, gatewayKeyName, stream, prompt }) {
  const requestId = `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`;
  db.prepare(`
    INSERT INTO request_logs(
      request_id,
      gateway_key_name,
      public_model_name,
      deployment_id,
      stream,
      status,
      request_preview,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, 'started', ?, ?)
  `).run(
    requestId,
    gatewayKeyName || null,
    deployment.public_model_name,
    deployment.id,
    boolToInt(stream),
    truncate(prompt, 5000),
    nowUtc(),
  );
  return requestId;
}

export function markRequestStreaming(db, requestId, conversationId = null) {
  db.prepare(`
    UPDATE request_logs
    SET status = 'streaming',
        upstream_conversation_id = COALESCE(?, upstream_conversation_id)
    WHERE request_id = ? AND status != 'streaming'
  `).run(conversationId, requestId);
}

export function completeGatewayRequest(
  db,
  {
    requestId,
    deploymentId,
    conversationId,
    usage,
    latencyMs,
    firstTokenMs,
    cost,
    creditsUsed,
    transport,
    content,
    thinking,
    emittedContentChars,
    emittedThinkingChars,
  },
) {
  const deployment = getDeployment(db, deploymentId);
  if (deployment) {
    db.prepare(`
      UPDATE model_deployments
      SET last_latency_ms = ?,
          last_error = NULL,
          consecutive_failures = 0,
          cooldown_until = NULL,
          updated_at = ?
      WHERE id = ?
    `).run(latencyMs, nowUtc(), deploymentId);
  }

  db.prepare(`
    UPDATE request_logs
    SET status = 'completed',
        latency_ms = @latency_ms,
        first_token_ms = @first_token_ms,
        prompt_tokens = @prompt_tokens,
        completion_tokens = @completion_tokens,
        total_tokens = @total_tokens,
        cost = @cost,
        credits_used_json = @credits_used_json,
        transport = @transport,
        upstream_conversation_id = @upstream_conversation_id,
        response_preview = @response_preview,
        thinking_preview = @thinking_preview,
        emitted_content_chars = @emitted_content_chars,
        emitted_thinking_chars = @emitted_thinking_chars,
        error_message = NULL
    WHERE request_id = @request_id
  `).run({
    request_id: requestId,
    latency_ms: latencyMs,
    first_token_ms: firstTokenMs,
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    cost,
    credits_used_json: creditsUsed ? JSON.stringify(creditsUsed) : null,
    transport,
    upstream_conversation_id: conversationId,
    response_preview: truncate(content, 5000),
    thinking_preview: truncate(thinking, 5000),
    emitted_content_chars: emittedContentChars,
    emitted_thinking_chars: emittedThinkingChars,
  });
}

export function failGatewayRequest(
  db,
  {
    requestId,
    deploymentId,
    conversationId = null,
    transport = null,
    errorMessage,
  },
) {
  const deployment = getDeployment(db, deploymentId);
  if (deployment) {
    db.prepare(`
      UPDATE model_deployments
      SET consecutive_failures = consecutive_failures + 1,
          last_error = ?,
          cooldown_until = NULL,
          updated_at = ?
      WHERE id = ?
    `).run(String(errorMessage), nowUtc(), deploymentId);
  }

  db.prepare(`
    UPDATE request_logs
    SET status = 'failed',
        transport = COALESCE(@transport, transport),
        upstream_conversation_id = COALESCE(@upstream_conversation_id, upstream_conversation_id),
        error_message = @error_message
    WHERE request_id = @request_id
  `).run({
    request_id: requestId,
    transport,
    upstream_conversation_id: conversationId,
    error_message: truncate(String(errorMessage), 5000),
  });
}

export function serializeForAdmin(db, type, id) {
  if (type === "upstream-key") {
    const row = getUpstreamKey(db, id);
    return row ? serializeUpstreamKey(row, listDeploymentsForUpstreamKey(db, row.id)) : null;
  }
  if (type === "deployment") {
    const row = getDeployment(db, id);
    return row ? serializeDeployment(row) : null;
  }
  if (type === "gateway-key") {
    const row = getGatewayKey(db, id);
    return row ? serializeGatewayKey(row) : null;
  }
  if (type === "catalog") {
    const row = db.prepare("SELECT * FROM model_catalog_cache WHERE id = ?").get(id);
    return row ? serializeModelCatalog(row) : null;
  }
  return null;
}

export { serializeDeployment, serializeGatewayKey, serializeModelCatalog, serializeRequestLog, serializeUpstreamKey };
