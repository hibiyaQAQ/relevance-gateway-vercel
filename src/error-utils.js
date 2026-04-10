function copyKnownFields(source) {
  if (!source || typeof source !== "object") return {};
  const result = {};
  for (const key of [
    "code",
    "errno",
    "syscall",
    "address",
    "port",
    "host",
    "hostname",
    "status",
    "statusCode",
    "type",
  ]) {
    if (source[key] != null) {
      result[key] = source[key];
    }
  }
  return result;
}

export function serializeError(error, { includeStack = true } = {}) {
  if (error instanceof Error) {
    const serialized = {
      name: error.name,
      message: error.message,
      ...copyKnownFields(error),
    };
    if (includeStack && error.stack) {
      serialized.stack = error.stack;
    }
    if (error.cause) {
      serialized.cause = serializeError(error.cause, { includeStack: false });
    }
    return serialized;
  }

  if (error && typeof error === "object") {
    return {
      message: JSON.stringify(error),
      ...copyKnownFields(error),
    };
  }

  return {
    message: String(error),
  };
}

export function formatErrorForLog(error, { includeStack = true } = {}) {
  try {
    return JSON.stringify(serializeError(error, { includeStack }));
  } catch (formattingError) {
    return JSON.stringify({
      message: String(error),
      formatting_error: String(formattingError),
    });
  }
}

export function classifyError(error) {
  const cause =
    error && typeof error === "object" && error.cause && typeof error.cause === "object"
      ? error.cause
      : null;
  const code = String(cause?.code || error?.code || "").toUpperCase();
  const name = String(error?.name || "");
  const message = String(error?.message || "");
  const causeMessage = String(cause?.message || "");
  const combined = `${name} ${message} ${causeMessage}`.toLowerCase();

  if (code === "ABORT_ERR" || combined.includes("abort")) {
    return "abort";
  }
  if (
    code === "ETIMEDOUT" ||
    code === "ECONNABORTED" ||
    combined.includes("timed out") ||
    combined.includes("timeout")
  ) {
    return "timeout";
  }
  if (
    [
      "ENOTFOUND",
      "EAI_AGAIN",
      "ECONNRESET",
      "ECONNREFUSED",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "EPIPE",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_SOCKET",
      "UND_ERR_ABORTED",
      "UND_ERR_BODY_TIMEOUT",
      "UND_ERR_RESPONSE_STATUS_CODE",
      "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH",
    ].includes(code)
  ) {
    return "network";
  }
  if (combined.includes("fetch failed")) {
    return "network";
  }
  if (typeof error?.statusCode === "number" || typeof error?.status === "number") {
    return "http";
  }
  return "unknown";
}
