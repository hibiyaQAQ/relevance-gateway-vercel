import crypto from "node:crypto";

const EXT_TO_MIME = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

function extFromMime(mediaType) {
  const sub = String(mediaType || "").split("/")[1] || "jpg";
  return sub === "jpeg" ? "jpg" : sub;
}

function mimeFromExt(ext) {
  return EXT_TO_MIME[String(ext).toLowerCase()] || "image/jpeg";
}

function extFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    return path.split(".").pop().split("?")[0].toLowerCase() || "jpg";
  } catch {
    return "jpg";
  }
}

/**
 * Upload a base64-encoded image to Relevance AI temporary storage.
 * Returns { fileName, fileUrl }.
 */
export async function uploadBase64ToRelevance(material, base64Data, mediaType) {
  const ext = extFromMime(mediaType);
  const filename = `img_${crypto.randomBytes(8).toString("hex")}.${ext}`;
  const baseUrl = `https://api-${material.region}.stack.tryrelevance.com/latest`;
  const auth = `${material.project}:${material.apiKey}`;

  const urlRes = await fetch(`${baseUrl}/services/get_temporary_file_upload_url`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ filename, extension: ext }),
  });
  if (!urlRes.ok) {
    throw new Error(`Failed to get image upload URL: ${urlRes.statusText}`);
  }
  const { upload_url: uploadUrl, download_url: downloadUrl } = await urlRes.json();

  const imageBuffer = Buffer.from(base64Data, "base64");
  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    body: imageBuffer,
    headers: {
      "content-type": mediaType || "image/jpeg",
      "x-amz-tagging": "Expire=true",
    },
  });
  if (!putRes.ok) {
    throw new Error(`Failed to upload image: ${putRes.statusText}`);
  }

  return { fileName: filename, fileUrl: downloadUrl };
}

/**
 * Parse an OpenAI image_url block value (string or {url}) into an internal pending image.
 * Returns { type: "image_pending", sourceType, base64Data?, mediaType, url?, fileName }
 */
export function parseOpenAIImageUrl(imageUrl) {
  const raw = typeof imageUrl === "string" ? imageUrl : (imageUrl?.url || "");
  if (raw.startsWith("data:")) {
    const match = raw.match(/^data:([^;]+);base64,(.+)$/s);
    if (!match) throw new Error("Invalid base64 image data URL.");
    const mediaType = match[1];
    return {
      type: "image_pending",
      sourceType: "base64",
      base64Data: match[2],
      mediaType,
      fileName: `image.${extFromMime(mediaType)}`,
    };
  }
  const ext = extFromUrl(raw);
  return {
    type: "image_pending",
    sourceType: "url",
    url: raw,
    mediaType: mimeFromExt(ext),
    fileName: `image.${ext}`,
  };
}

/**
 * Parse an Anthropic image block source into an internal pending image.
 */
export function parseAnthropicImageSource(source) {
  if (!source) throw new Error("Image source is required.");
  if (source.type === "base64") {
    return {
      type: "image_pending",
      sourceType: "base64",
      base64Data: source.data,
      mediaType: source.media_type || "image/jpeg",
      fileName: `image.${extFromMime(source.media_type)}`,
    };
  }
  if (source.type === "url") {
    const ext = extFromUrl(source.url || "");
    return {
      type: "image_pending",
      sourceType: "url",
      url: source.url,
      mediaType: mimeFromExt(ext),
      fileName: `image.${ext}`,
    };
  }
  throw new Error(`Unsupported Anthropic image source type: ${source.type}`);
}

/**
 * Resolve all image_pending blocks in messages:
 * - base64 → upload to Relevance AI, get fileUrl
 * - url   → use directly as fileUrl
 *
 * Returns { messages (image blocks now have fileUrl), attachments (from last user message) }
 */
export async function resolveImageAttachments(messages, material) {
  const resolved = [];

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) {
      resolved.push(msg);
      continue;
    }

    const newContent = [];
    for (const block of msg.content) {
      if (block.type !== "image_pending") {
        newContent.push(block);
        continue;
      }

      let fileUrl, fileName;
      if (block.sourceType === "base64") {
        const uploaded = await uploadBase64ToRelevance(
          material,
          block.base64Data,
          block.mediaType,
        );
        fileUrl = uploaded.fileUrl;
        fileName = uploaded.fileName;
      } else {
        fileUrl = block.url;
        fileName = block.fileName;
      }

      newContent.push({ type: "image", fileUrl, fileName });
    }

    resolved.push({ ...msg, content: newContent });
  }

  // Collect attachments from the final user message for agent.sendMessage
  const attachments = [];
  for (let i = resolved.length - 1; i >= 0; i--) {
    if (resolved[i].role !== "user") continue;
    const content = resolved[i].content;
    if (!Array.isArray(content)) break;
    for (const block of content) {
      if (block.type === "image") {
        attachments.push({ fileUrl: block.fileUrl, fileName: block.fileName });
      }
    }
    break;
  }

  return { messages: resolved, attachments };
}
