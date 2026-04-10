import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const projectRoot = path.resolve(__dirname, "..");
export const dataDir = path.join(projectRoot, "data");
export const publicDir = path.join(projectRoot, "public");
export const adminStaticDir = path.join(publicDir, "admin");
export const adminAssetsDir = path.join(adminStaticDir, "assets");

function readBool(name, fallback) {
  const raw = process.env[name];
  if (raw == null) return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

function parseDatabasePath(value) {
  if (!value) return `file:${path.join(dataDir, "gateway.db")}`;
  if (
    value.startsWith("file:") ||
    value.startsWith("libsql:") ||
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("postgres://") ||
    value.startsWith("postgresql://")
  ) {
    return value;
  }
  if (value.startsWith("sqlite:////")) {
    return `file:${value.slice("sqlite:///".length)}`;
  }
  if (value.startsWith("sqlite:///")) {
    const relativePath = value.slice("sqlite:///".length);
    const absolutePath = path.isAbsolute(relativePath)
      ? relativePath
      : path.join(projectRoot, relativePath);
    return `file:${absolutePath}`;
  }
  return `file:${value}`;
}

export const settings = {
  appName: process.env.APP_NAME || "Relevance Gateway",
  appSecretKey: process.env.APP_SECRET_KEY || "change-me-super-secret",
  adminUsername: process.env.ADMIN_USERNAME || "admin",
  adminPassword: process.env.ADMIN_PASSWORD || "admin",
  databasePath: parseDatabasePath(
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_URL_NON_POOLING,
  ),
  adminCookieName: process.env.ADMIN_COOKIE_NAME || "rg_admin_session",
  adminCookieTtlSeconds: Number(process.env.ADMIN_COOKIE_TTL_SECONDS || 60 * 60 * 24 * 7),
  upstreamPollIntervalSeconds: Number(process.env.UPSTREAM_POLL_INTERVAL_SECONDS || 1.5),
  upstreamPollTimeoutSeconds: Number(process.env.UPSTREAM_POLL_TIMEOUT_SECONDS || 300),
  streamHeartbeatIntervalSeconds: Number(process.env.STREAM_HEARTBEAT_INTERVAL_SECONDS || 8),
  modelCatalogTtlSeconds: Number(process.env.MODEL_CATALOG_TTL_SECONDS || 60 * 60 * 24),
  modelCatalogRefreshTimeoutSeconds: Number(
    process.env.MODEL_CATALOG_REFRESH_TIMEOUT_SECONDS || 20,
  ),
  deploymentCooldownSeconds: Number(process.env.DEPLOYMENT_COOLDOWN_SECONDS || 30),
  taskMetadataPollIntervalSeconds: Number(
    process.env.TASK_METADATA_POLL_INTERVAL_SECONDS || 1,
  ),
  taskViewPollIntervalSeconds: Number(process.env.TASK_VIEW_POLL_INTERVAL_SECONDS || 1),
  streamFallbackInitialSilenceSeconds: Number(
    process.env.STREAM_FALLBACK_INITIAL_SILENCE_SECONDS || 10,
  ),
  streamFallbackSilenceSeconds: Number(
    process.env.STREAM_FALLBACK_SILENCE_SECONDS || 5,
  ),
  streamFallbackSmoothChunkChars: Number(
    process.env.STREAM_FALLBACK_SMOOTH_CHUNK_CHARS || 24,
  ),
  streamFallbackSmoothChunkDelayMs: Number(
    process.env.STREAM_FALLBACK_SMOOTH_CHUNK_DELAY_MS || 25,
  ),
  debugRuntime: readBool("DEBUG_RUNTIME", false),
  debugStreamPayloads: readBool("DEBUG_STREAM_PAYLOADS", false),
  debugStreamPayloadPreviewChars: Number(
    process.env.DEBUG_STREAM_PAYLOAD_PREVIEW_CHARS || 160,
  ),
  debugStreamStallWarningSeconds: Number(
    process.env.DEBUG_STREAM_STALL_WARNING_SECONDS || 15,
  ),
  debugStreamWatchdogIntervalSeconds: Number(
    process.env.DEBUG_STREAM_WATCHDOG_INTERVAL_SECONDS || 5,
  ),
  enableBufferedStreamCompat: readBool("ENABLE_BUFFERED_STREAM_COMPAT", false),
  host: process.env.HOST || "0.0.0.0",
  port: Number(process.env.PORT || 8080),
};
