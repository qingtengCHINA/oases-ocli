import { MAX_BODY_BYTES } from "./constants.js";

export function sendJson(response, status, payload, extraHeaders = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  response.end(JSON.stringify(payload));
}

export function allowedOrigin(origin) {
  if (!origin) return "*";
  try {
    const url = new URL(origin);
    if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return origin;
    if (url.hostname === "www.oasesai.xyz" || url.hostname.endsWith(".vercel.app")) return origin;
  } catch {
    return "";
  }
  return "";
}

export function corsHeaders(request) {
  const origin = allowedOrigin(request.headers.origin || "");
  return {
    ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Oases-Token",
    "Access-Control-Max-Age": "86400",
  };
}

export async function readBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
