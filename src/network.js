import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
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

function assertPublicUrl(url) {
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http/https URLs are supported.");
  if (isPrivateAddress(url.hostname.toLowerCase())) throw new Error("fetch_url cannot access localhost or private network hosts.");
}

function secureLookup(hostname, options, callback) {
  lookup(hostname, { ...options, verbatim: true })
    .then((result) => {
      const records = Array.isArray(result) ? result : [result];
      const normalizedRecords = records
        .map((record) => typeof record === "string" ? { address: record, family: net.isIP(record) } : record)
        .filter((record) => record?.address);
      if (!normalizedRecords.length || normalizedRecords.some((record) => isPrivateAddress(record.address))) {
        callback(new Error("fetch_url cannot access localhost or private network hosts."));
        return;
      }
      if (options?.all) {
        callback(null, normalizedRecords);
        return;
      }
      callback(null, normalizedRecords[0].address, normalizedRecords[0].family);
    })
    .catch((error) => callback(error));
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

function requestText(url, options = {}) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const maxBytes = options.maxBytes;
    let settled = false;
    let truncated = false;
    let totalBytes = 0;
    const chunks = [];
    const finish = (response) => {
      if (settled) return;
      settled = true;
      resolve({
        status: response.statusCode || 0,
        statusText: response.statusMessage || "",
        headers: response.headers || {},
        url: url.toString(),
        text: Buffer.concat(chunks).toString("utf8"),
        truncated,
      });
    };
    const request = client.request(url, {
      method: "GET",
      signal: options.signal,
      lookup: secureLookup,
      timeout: options.timeoutMs || 30000,
      headers: {
        "User-Agent": "Oases ocli/0.1 (+https://www.oasesai.xyz)",
        Accept: "text/html,text/plain,application/json,*/*;q=0.7",
        "Accept-Encoding": "identity",
      },
    }, (response) => {
      response.on("data", (chunk) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = maxBytes - totalBytes;
        if (remaining > 0) {
          chunks.push(buffer.length > remaining ? buffer.subarray(0, remaining) : buffer);
          totalBytes += Math.min(buffer.length, remaining);
        }
        if (buffer.length > remaining) {
          truncated = true;
          response.destroy();
          finish(response);
        }
      });
      response.on("end", () => finish(response));
      response.on("close", () => {
        if (truncated) finish(response);
      });
      response.on("error", (error) => {
        if (!settled) reject(error);
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error("fetch_url timed out."));
    });
    request.on("error", (error) => {
      if (!settled) reject(error);
    });
    request.end();
  });
}

function headerValue(headers, name) {
  const value = headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value || "";
}

async function fetchPublicText(initialUrl, options = {}) {
  let current = initialUrl;
  const redirects = [];
  for (let index = 0; index <= 5; index += 1) {
    assertPublicUrl(current);
    const response = await requestText(current, options);
    const location = headerValue(response.headers, "location");
    if ([301, 302, 303, 307, 308].includes(response.status) && location) {
      const next = new URL(location, current);
      assertPublicUrl(next);
      redirects.push({ from: current.toString(), to: next.toString(), status: response.status });
      current = next;
      continue;
    }
    return { ...response, finalUrl: current.toString(), redirects };
  }
  throw new Error("fetch_url followed too many redirects.");
}


export async function webSearch(body, signal) {
  const query = String(body.query || "").trim();
  if (!query) throw new Error("web_search requires a query.");
  const maxResults = Math.max(1, Math.min(20, Number(body.maxResults) || 5));
  const searchUrl = new URL("https://html.duckduckgo.com/html/");
  searchUrl.searchParams.set("q", query);
  const response = await fetchPublicText(searchUrl, { signal, maxBytes: 512 * 1024 });
  const html = response.text;
  const results = [];
  // Parse DuckDuckGo HTML results
  const resultRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*(?:<[^>]*>[^<]*)*)<\/a>(?:[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/gi;
  for (const match of html.matchAll(resultRegex)) {
    if (results.length >= maxResults) break;
    const rawHref = match[1] || "";
    const titleHtml = match[2] || "";
    const snippetHtml = match[3] || "";
    const title = stripTags(titleHtml).trim();
    const snippet = stripTags(snippetHtml).trim();
    let url = "";
    try {
      // DuckDuckGo HTML wraps real URL in a redirect; try to extract uddg param
      const hrefObj = new URL(decodeHtmlEntities(rawHref), "https://duckduckgo.com");
      const uddg = hrefObj.searchParams.get("uddg");
      url = uddg ? decodeHtmlEntities(uddg) : hrefObj.toString();
    } catch {
      url = decodeHtmlEntities(rawHref);
    }
    if (!url || !title) continue;
    results.push({ title, url, ...(snippet ? { snippet } : {}) });
  }
  return {
    query,
    resultCount: results.length,
    results,
    source: "duckduckgo",
    note: results.length === 0 ? "No results found. Try a different query or check the search terms." : undefined,
  };
}

export async function fetchUrl(body, signal) {
  const url = new URL(String(body.url || ""));
  const maxChars = Number.isFinite(body.maxChars) ? Math.max(1000, Math.min(200000, Number(body.maxChars))) : 80000;
  const maxBytes = Math.max(32768, Math.min(1024 * 1024, maxChars * 4));
  const response = await fetchPublicText(url, { signal, maxBytes });
  const raw = response.text;
  const contentType = headerValue(response.headers, "content-type");
  const metadata = contentType.toLowerCase().includes("html")
    ? extractHtmlMetadata(raw, response.finalUrl || url.toString())
    : { title: "", links: [] };
  return {
    url: url.toString(),
    finalUrl: response.finalUrl,
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    contentType,
    title: metadata.title,
    links: metadata.links,
    redirects: response.redirects,
    truncated: response.truncated || raw.length > maxChars,
    text: raw.length > maxChars ? raw.slice(0, maxChars) : raw,
  };
}
