import crypto from "node:crypto";

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyAdminCredentials(settings, username, password) {
  return (
    safeEqual(username, settings.adminUsername) &&
    safeEqual(password, settings.adminPassword)
  );
}

function hmac(secret, value) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

export function makeAdminSession(settings, username) {
  const expiresAt = Math.floor(Date.now() / 1000) + settings.adminCookieTtlSeconds;
  const payload = `${username}.${expiresAt}`;
  const signature = hmac(settings.appSecretKey, payload);
  return `${payload}.${signature}`;
}

export function parseAdminSession(settings, token) {
  if (!token) return null;
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  const [username, expiresAtRaw, signature] = parts;
  const payload = `${username}.${expiresAtRaw}`;
  const expected = hmac(settings.appSecretKey, payload);
  if (!safeEqual(signature, expected)) return null;
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
    return null;
  }
  return username;
}

export function generateGatewayKey() {
  return `sk-gw-${crypto.randomBytes(24).toString("base64url")}`;
}

export function readBearerToken(headerValue) {
  const header = String(headerValue || "");
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  return header.slice(7).trim() || null;
}
