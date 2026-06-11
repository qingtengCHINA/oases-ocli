import { lookup } from "node:dns/promises";
import net from "node:net";

export function isPrivateAddress(address) {
  if (!address) return true;
  if (address === "localhost" || address.endsWith(".localhost")) return true;
  const version = net.isIP(address);
  if (version === 4) {
    const [a, b] = address.split(".").map((part) => Number(part));
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
  }
  return false;
}

export async function assertPublicFetchHost(url) {
  const hostname = url.hostname.toLowerCase();
  if (isPrivateAddress(hostname)) throw new Error("fetch_url cannot access localhost or private network hosts.");
  const records = await lookup(hostname, { all: true, verbatim: true });
  if (!records.length || records.some((record) => isPrivateAddress(record.address))) {
    throw new Error("fetch_url cannot access localhost or private network hosts.");
  }
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

export function extractHtmlMetadata(html, baseUrl) {
  const raw = String(html || "");
  const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripTags(titleMatch[1]) : "";
  const links = [];
  for (const match of raw.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (links.length >= 80) break;
    const attrs = match[1] || "";
    const hrefMatch = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const href = hrefMatch?.[1] || hrefMatch?.[2] || hrefMatch?.[3] || "";
    if (!href || href.startsWith("#") || /^javascript:/i.test(href) || /^mailto:/i.test(href)) continue;
    try {
      const url = new URL(decodeHtmlEntities(href), baseUrl).toString();
      const text = stripTags(match[2]).slice(0, 160);
      links.push({ url, ...(text ? { text } : {}) });
    } catch {
      // Ignore malformed href values.
    }
  }
  return { title, links };
}

export async function fetchUrl(body, signal) {
  const url = new URL(String(body.url || ""));
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http/https URLs are supported.");
  await assertPublicFetchHost(url);
  const response = await fetch(url, {
    signal,
    headers: { "User-Agent": "Oases ocli/0.1 (+https://www.oasesai.xyz)", Accept: "text/html,text/plain,application/json,*/*;q=0.7" },
  });
  const raw = await response.text();
  const maxChars = Number.isFinite(body.maxChars) ? Math.max(1000, Math.min(200000, Number(body.maxChars))) : 80000;
  const metadata = (response.headers.get("content-type") || "").toLowerCase().includes("html")
    ? extractHtmlMetadata(raw, response.url || url.toString())
    : { title: "", links: [] };
  return {
    url: url.toString(),
    finalUrl: response.url,
    status: response.status,
    ok: response.ok,
    contentType: response.headers.get("content-type") || "",
    title: metadata.title,
    links: metadata.links,
    truncated: raw.length > maxChars,
    text: raw.length > maxChars ? raw.slice(0, maxChars) : raw,
  };
}
