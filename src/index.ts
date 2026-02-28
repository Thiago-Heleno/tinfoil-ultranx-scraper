import { load } from "cheerio";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import { Readable } from "node:stream";

const BASE_URL = "https://not.ultranx.ru/";
const API_URL = "https://api.ultranx.ru";
const LIST_PATH = "en";
const GAME_PATH_PREFIX = "en/game/";
const LOCAL_GAMES_DIR = nodePath.resolve(process.cwd(), "games");
const TITLE_ID_RE = /^[0-9A-Fa-f]{16}$/;
const DOWNLOAD_TYPES = new Set(["base", "update", "dlc", "full"]);
const SORT_BY = new Set(["release_date", "name", "size"]);
const SORT_ORDER = new Set(["asc", "desc"]);

const config = {
  port: intEnv("PORT", 3000, 1, 65535),
  cacheTtlMs: intEnv("CACHE_TTL_MS", 300_000, 5_000, 3_600_000),
  maxPages: intEnv("MAX_PAGES", 10, 1, 100),
  batchSize: intEnv("BATCH_SIZE", 5, 1, 20),
  fetchTimeoutMs: intEnv("FETCH_TIMEOUT_MS", 15_000, 1_000, 120_000),
  logRequests: boolEnv("LOG_REQUESTS", true),
  authToken: normalizeSecretToken(process.env.AUTH_TOKEN ?? process.env.ACCESS_TOKEN ?? process.env.auth_token ?? process.env.access_token ?? ""),
  deviceId: normalizeSecretToken(process.env.DEVICE_ID ?? process.env.DEVICEID ?? process.env.device_id ?? process.env.deviceid ?? ""),
  downloadRedirectCacheTtlMs: intEnv("DOWNLOAD_REDIRECT_CACHE_TTL_MS", 0, 0, 600_000),
  downloadProxy: boolEnv("DOWNLOAD_PROXY", false),
  tinfoilFlatAll: boolEnv("TINFOIL_FLAT_ALL", true),
  tinfoilIncludeAll: boolEnv("TINFOIL_INCLUDE_ALL", false),
  referrer: (process.env.REFERRER ?? "https://not.ultranx.ru").trim(),
  tinfoilVersion: intEnv("TINFOIL_MIN_VERSION", 17, 1, 100),
};

type TitleCard = {
  id: string;
  title: string;
  releaseDate: string | null;
  size: string | null;
  image: string | null;
  url: string;
};

type GameDownload = { type: string; size: string | null; version: number | null };

type GameDetail = {
  id: string;
  title: string | null;
  publisher: string | null;
  releaseDate: string | null;
  size: string | null;
  categories: string | null;
  languages: string | null;
  players: string | null;
  images: string[];
  url: string;
  downloads: GameDownload[];
};

type CacheEntry<T> = { expiresAt: number; value: T };

const htmlCache = new Map<string, CacheEntry<string>>();
const redirectCache = new Map<string, CacheEntry<string>>();
const tinfoilCache = new Map<string, CacheEntry<unknown>>();
const stats = { start: Date.now(), requests: 0, errors: 0, cacheHits: 0, cacheMisses: 0 };

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const value = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.toLowerCase() !== "false";
}

function normalizeSecretToken(value: string): string {
  return value
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^auth_token=/i, "")
    .replace(/^bearer\s+/i, "")
    .trim();
}

function log(level: "INFO" | "WARN" | "ERROR", message: string, data?: unknown): void {
  if (level === "INFO" && !config.logRequests) return;
  const suffix = data === undefined ? "" : ` ${JSON.stringify(data)}`;
  console.log(`[${new Date().toISOString()}] [${level}] ${message}${suffix}`);
}

function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function queryBool(v: string | null): boolean {
  if (!v) return false;
  return v === "true" || v === "1" || v.toLowerCase() === "yes";
}

function queryParam(params: URLSearchParams, aliases: string[]): string | null {
  for (const key of aliases) {
    const value = params.get(key);
    if (value && value.trim()) return value.trim();
  }
  return null;
}

function queryPage(params: URLSearchParams): number {
  const pageRaw = queryParam(params, ["p", "page", "pg", "page_no"]);
  if (pageRaw) return clampInt(pageRaw, 1, 1, 9_999);

  const offsetRaw = queryParam(params, ["offset", "start"]);
  if (!offsetRaw) return 1;

  const perPageRaw = queryParam(params, ["limit", "pages", "per_page", "perpage"]);
  const offset = clampInt(offsetRaw, 0, 0, 9_999_999);
  const perPage = clampInt(perPageRaw, 1, 1, 1000);
  return Math.floor(offset / perPage) + 1;
}

function queryPages(params: URLSearchParams): number {
  const pagesRaw = queryParam(params, ["pages", "limit", "per_page", "perpage"]);
  return clampInt(pagesRaw, 1, 1, config.maxPages);
}

function querySearch(params: URLSearchParams): string {
  const aliases = ["s", "q", "query", "search", "term", "filter", "keyword", "text", "name", "title"];
  for (const key of aliases) {
    const value = params.get(key);
    if (value && value.trim()) return value.trim();
  }
  return "";
}

function sortBy(v: string | null): "release_date" | "name" | "size" {
  return SORT_BY.has(v ?? "") ? (v as "release_date" | "name" | "size") : "release_date";
}

function sortOrder(v: string | null): "asc" | "desc" {
  return SORT_ORDER.has(v ?? "") ? (v as "asc" | "desc") : "desc";
}

function cleanPath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function cacheGet<T>(map: Map<string, CacheEntry<T>>, key: string): T | null {
  const hit = map.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    map.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet<T>(map: Map<string, CacheEntry<T>>, key: string, value: T): void {
  map.set(key, { value, expiresAt: Date.now() + config.cacheTtlMs });
}

function cacheSetWithTtl<T>(map: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number): void {
  map.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function parseSizeToBytes(size: string | null): number {
  if (!size) return 0;
  const match = size.match(/^([\d.]+)\s*(GB|MB|KB|B)?$/i);
  if (!match) return 0;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return 0;
  const unit = (match[2] ?? "B").toUpperCase();
  const mul = unit === "GB" ? 1024 ** 3 : unit === "MB" ? 1024 ** 2 : unit === "KB" ? 1024 : 1;
  return Math.round(value * mul);
}

function parseReleaseDate(date: string | null): number | undefined {
  if (!date) return undefined;
  const m = date.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return undefined;
  return Number.parseInt(`${m[3]}${m[2]}${m[1]}`, 10);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeFilename(value: string): string {
  return value.replace(/[<>:"/\\|?*#\u0000-\u001F]/g, "_").replace(/\s+/g, " ").trim();
}

function titleIdForType(id: string, type: string): string {
  const normalized = id.trim().toUpperCase();
  if (type === "update" && TITLE_ID_RE.test(normalized) && normalized.endsWith("000")) {
    return `${normalized.slice(0, 13)}800`;
  }
  return normalized;
}

function formatBytes(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(2)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(2)} KB`;
  return `${value} B`;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), config.fetchTimeoutMs);
  try {
    return await fetch(url, { ...init, signal: c.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fetchHtml(url: string): Promise<string> {
  const hit = cacheGet(htmlCache, url);
  if (hit) {
    stats.cacheHits++;
    return hit;
  }
  stats.cacheMisses++;

  const response = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!response.ok) throw new Error(`Upstream request failed: ${response.status} ${response.statusText}`);
  const text = await response.text();
  cacheSet(htmlCache, url, text);
  return text;
}

function extractTitleId(rawHref: string): string {
  try {
    const pathname = new URL(rawHref, BASE_URL).pathname;
    const id = pathname.split("/").filter(Boolean).at(-1) ?? "";
    return TITLE_ID_RE.test(id) ? id.toUpperCase() : "";
  } catch {
    return "";
  }
}

function parseListPage(rawHtml: string): { items: TitleCard[]; pageCount: number | null } {
  const $ = load(rawHtml);
  const items: TitleCard[] = [];

  $(".card").each((_, node) => {
    const card = $(node);
    const href = (card.attr("data-href") ?? card.find("a").first().attr("href") ?? "").trim();
    const id = extractTitleId(href);
    const title = card.find(".card-title").first().text().trim();
    if (!id || !title) return;

    const info = card.find(".card-info span");
    const imageRaw = card.find("img").first().attr("src") ?? "";
    items.push({
      id,
      title,
      releaseDate: info.eq(0).text().trim() || null,
      size: info.eq(1).text().trim() || null,
      image: imageRaw ? new URL(imageRaw, BASE_URL).toString() : null,
      url: new URL(href, BASE_URL).toString(),
    });
  });

  let pageCount: number | null = null;
  $(".pagination a").each((_, node) => {
    const n = Number.parseInt($(node).text().trim(), 10);
    if (Number.isFinite(n)) pageCount = Math.max(pageCount ?? 0, n);
  });

  return { items, pageCount };
}

function parseGamePage(rawHtml: string, id: string): GameDetail {
  const $ = load(rawHtml);
  const meta: Record<string, string> = {};

  $(".game-meta p").each((_, node) => {
    const row = $(node);
    const label = row.find("strong").first().text().replace(/:\s*$/, "").trim();
    const clone = row.clone();
    clone.find("strong").remove();
    if (label) meta[label] = clone.text().trim();
  });

  const downloads: GameDownload[] = [];
  const seen = new Set<string>();
  $(".download-buttons a.button").each((_, node) => {
    const link = $(node);
    const href = (link.attr("href") ?? "").trim();
    if (!href) return;
    const text = link.text().trim();
    const typed = href.match(/\/download\/[^/]+\/([a-z0-9_-]+)$/i)?.[1]?.toLowerCase();
    const type = typed ?? (text.toLowerCase().includes("update") ? "update" : text.toLowerCase().includes("dlc") ? "dlc" : text.toLowerCase().includes("full") ? "full" : "base");
    if (!DOWNLOAD_TYPES.has(type) || seen.has(type)) return;
    seen.add(type);
    downloads.push({
      type,
      size: text.match(/([\d.]+\s*(?:GB|MB|KB|B))/i)?.[1] ?? null,
      version: Number.parseInt(text.match(/\bv(\d+)\b/i)?.[1] ?? "", 10) || null,
    });
  });

  if (downloads.length === 0) downloads.push({ type: "base", size: null, version: 0 });

  const images: string[] = [];
  $(".carousel-item img").each((_, node) => {
    const src = $(node).attr("src");
    if (src) images.push(new URL(src, BASE_URL).toString());
  });

  return {
    id,
    title: $(".game-hero h1").first().text().trim() || null,
    publisher: meta["Publisher"] ?? null,
    releaseDate: meta["Release Date"] ?? null,
    size: meta["Size"] ?? null,
    categories: meta["Categories"] ?? null,
    languages: meta["Languages"] ?? null,
    players: meta["Number of Players"] ?? null,
    images,
    url: new URL(`${GAME_PATH_PREFIX}${id}`, BASE_URL).toString(),
    downloads,
  };
}

async function getTitlesPage(page: number, search: string, sb: "release_date" | "name" | "size", so: "asc" | "desc"): Promise<{ items: TitleCard[]; pageCount: number | null }> {
  const u = new URL(LIST_PATH, BASE_URL);
  u.searchParams.set("p", String(page));
  if (search) u.searchParams.set("s", search);
  u.searchParams.set("sb", sb);
  u.searchParams.set("so", so);
  const raw = await fetchHtml(u.toString());
  return parseListPage(raw);
}

async function getTitlesRange(page: number, pages: number, search: string, sb: "release_date" | "name" | "size", so: "asc" | "desc") {
  const list = await Promise.all(Array.from({ length: pages }, (_, i) => getTitlesPage(page + i, search, sb, so)));
  const dedupe = new Map<string, TitleCard>();
  let pageCount: number | null = null;
  for (const r of list) {
    if (r.pageCount !== null) pageCount = Math.max(pageCount ?? 0, r.pageCount);
    for (const item of r.items) dedupe.set(item.id, item);
  }
  return { items: [...dedupe.values()], pageCount };
}

async function getAllTitles(search: string, sb: "release_date" | "name" | "size", so: "asc" | "desc") {
  const first = await getTitlesPage(1, search, sb, so);
  const total = first.pageCount ?? 1;
  const dedupe = new Map<string, TitleCard>(first.items.map((x) => [x.id, x]));
  for (let start = 2; start <= total; start += config.batchSize) {
    const end = Math.min(total, start + config.batchSize - 1);
    const batch = await Promise.all(Array.from({ length: end - start + 1 }, (_, i) => getTitlesPage(start + i, search, sb, so)));
    for (const r of batch) for (const item of r.items) dedupe.set(item.id, item);
  }
  return { items: [...dedupe.values()], pageCount: total };
}

function publicBaseUrl(request: Request): string {
  const proto = request.headers.get("x-forwarded-proto");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (proto && host) return `${proto}://${host}`;
  return new URL(request.url).origin;
}

type DownloadResolveResult =
  | { ok: true; url: string; source: string; fromCache?: boolean }
  | { ok: false; status: number; source: string; challenge?: string | null; details?: string | null };

function downloadAuthHeaders(): Record<string, string> {
  const cookieParts: string[] = [];
  if (config.authToken) cookieParts.push(`auth_token=${config.authToken}`);
  if (config.deviceId) cookieParts.push(`device_id=${config.deviceId}`);

  const headers: Record<string, string> = {
    Referer: config.referrer,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    Accept: "*/*",
  };

  if (cookieParts.length > 0) headers.Cookie = cookieParts.join("; ");
  if (config.authToken) headers.Authorization = `Bearer ${config.authToken}`;
  if (config.deviceId) {
    headers.DeviceID = config.deviceId;
    headers["X-Device-ID"] = config.deviceId;
  }

  return headers;
}

function candidateUrlsFromPayload(payload: unknown, endpoint: string): string[] {
  if (!payload || typeof payload !== "object") return [];

  const obj = payload as Record<string, unknown>;
  const nested = obj.data && typeof obj.data === "object" ? (obj.data as Record<string, unknown>) : null;
  const candidates = [
    obj.url,
    obj.location,
    obj.download,
    obj.download_url,
    obj.link,
    nested?.url,
    nested?.location,
    nested?.download,
    nested?.download_url,
    nested?.link,
  ];

  return candidates
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((raw) => {
      try {
        return new URL(raw, endpoint).toString();
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

async function resolveDownloadEndpoint(endpoint: string): Promise<DownloadResolveResult> {
  const response = await fetchWithTimeout(endpoint, {
    headers: downloadAuthHeaders(),
    redirect: "manual",
  });

  const location = response.headers.get("location");
  if ([301, 302, 303, 307, 308].includes(response.status) && location) {
    const absolute = new URL(location, endpoint).toString();
    return { ok: true, url: absolute, source: endpoint };
  }

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (response.ok && contentType.includes("application/json")) {
    try {
      const payload = await response.clone().json();
      const url = candidateUrlsFromPayload(payload, endpoint)[0];
      if (url) return { ok: true, url, source: endpoint };
    } catch {
      // Ignore JSON parse errors and return detailed upstream info below.
    }
  }

  let details: string | null = null;
  try {
    const body = (await response.text()).trim();
    if (body) details = body.slice(0, 500);
  } catch {
    // Ignore body read errors and return status-only info.
  }

  return {
    ok: false,
    status: response.status,
    source: endpoint,
    challenge: response.headers.get("www-authenticate"),
    details,
  };
}

async function resolveDownload(id: string, type: string): Promise<DownloadResolveResult> {
  const key = `${id}:${type}`;
  const cached = cacheGet(redirectCache, key);
  if (cached) return { ok: true, url: cached, source: "cache", fromCache: true };
  if (!config.authToken) {
    return { ok: false, status: 503, source: "local", details: "AUTH_TOKEN is not configured" };
  }

  const endpoints = [
    `${API_URL}/games/download/${id}/${type}`,
    new URL(`download/${id}/${type}`, BASE_URL).toString(),
  ];

  let lastFailure: DownloadResolveResult | null = null;
  for (const endpoint of endpoints) {
    const resolved = await resolveDownloadEndpoint(endpoint);
    if (resolved.ok) {
      if (config.downloadRedirectCacheTtlMs > 0) {
        cacheSetWithTtl(redirectCache, key, resolved.url, config.downloadRedirectCacheTtlMs);
      }
      return resolved;
    }
    lastFailure = resolved;
  }

  return lastFailure ?? { ok: false, status: 404, source: "resolver", details: "No download URL returned by upstream" };
}

function downloadFilenameFromUrl(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    const fromQuery = u.searchParams.get("filename");
    if (fromQuery && fromQuery.trim()) return sanitizeFilename(decodeURIComponent(fromQuery).trim());
  } catch {
    // Ignore URL parse/decode issues and use upstream header fallback.
  }
  return null;
}

function copyDownloadHeaders(input: Headers, fallbackFileName: string | null): Headers {
  const out = new Headers();
  const passthrough = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
    "cache-control",
    "content-disposition",
  ];

  for (const name of passthrough) {
    const value = input.get(name);
    if (value) out.set(name, value);
  }

  if (!out.get("content-type")) out.set("content-type", "application/octet-stream");
  if (!out.get("cache-control")) out.set("cache-control", "no-store");
  if (!out.get("content-disposition") && fallbackFileName) {
    out.set("content-disposition", `attachment; filename="${fallbackFileName}"; filename*=UTF-8''${encodeURIComponent(fallbackFileName)}`);
  }

  return out;
}

type LocalGameFile = {
  relPath: string;
  absPath: string;
  size: number;
  name: string;
};

async function listLocalGameFiles(): Promise<LocalGameFile[]> {
  const out: LocalGameFile[] = [];
  const allowed = new Set([".nsp", ".nsz", ".xci"]);

  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(
      entries.map(async (entry) => {
        const abs = nodePath.join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(abs);
          return;
        }
        if (!entry.isFile()) return;

        const ext = nodePath.extname(entry.name).toLowerCase();
        if (!allowed.has(ext)) return;

        let size = 0;
        try {
          size = (await stat(abs)).size;
        } catch {
          return;
        }
        const rel = nodePath.relative(LOCAL_GAMES_DIR, abs).replaceAll("\\", "/");
        out.push({ relPath: rel, absPath: abs, size, name: entry.name });
      }),
    );
  }

  await walk(LOCAL_GAMES_DIR);
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function safeResolveLocalPath(relPathRaw: string): string | null {
  const decoded = decodeURIComponent(relPathRaw || "").replaceAll("\\", "/");
  const abs = nodePath.resolve(LOCAL_GAMES_DIR, decoded);
  const rootWithSep = `${LOCAL_GAMES_DIR}${nodePath.sep}`;
  if (abs === LOCAL_GAMES_DIR || abs.startsWith(rootWithSep)) return abs;
  return null;
}

type ParsedRange = { start: number; end: number } | "invalid";

function fileBody(absPath: string, start?: number, end?: number): ReadableStream {
  const stream = start === undefined
    ? createReadStream(absPath)
    : createReadStream(absPath, { start, end });
  return Readable.toWeb(stream) as unknown as ReadableStream;
}

function parseByteRange(rangeHeader: string | null, totalSize: number): ParsedRange | null {
  if (!rangeHeader) return null;
  if (totalSize <= 0) return "invalid";

  // Some clients probe files with multi-range requests. We serve the first range.
  const firstRange = rangeHeader.split(",")[0]?.trim() ?? "";
  const match = firstRange.match(/^bytes\s*=\s*(\d*)\s*-\s*(\d*)$/i);
  if (!match) return "invalid";

  const startRaw = match[1] ?? "";
  const endRaw = match[2] ?? "";
  if (!startRaw && !endRaw) return "invalid";

  if (startRaw) {
    const start = Number.parseInt(startRaw, 10);
    const parsedEnd = endRaw ? Number.parseInt(endRaw, 10) : totalSize - 1;
    if (!Number.isFinite(start) || !Number.isFinite(parsedEnd)) return "invalid";
    if (start < 0 || parsedEnd < 0 || start >= totalSize) return "invalid";
    const end = Math.min(parsedEnd, totalSize - 1);
    if (end < start) return "invalid";
    return { start, end };
  }

  const suffixLength = Number.parseInt(endRaw, 10);
  if (!Number.isFinite(suffixLength) || suffixLength <= 0) return "invalid";
  const length = Math.min(suffixLength, totalSize);
  return { start: totalSize - length, end: totalSize - 1 };
}

function lanIps(): string[] {
  const ips: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    if (!entries) continue;
    for (const e of entries) if (e.family === "IPv4" && !e.internal) ips.push(e.address);
  }
  return [...new Set(ips)];
}

const server = Bun.serve({
  port: config.port,
  async fetch(request: Request): Promise<Response> {
    const started = Date.now();
    stats.requests++;

    const url = new URL(request.url);
    const path = cleanPath(url.pathname);

    log("INFO", `${request.method} ${path}`, { query: Object.fromEntries(url.searchParams.entries()) });

    try {
      if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "Method not allowed" }, 405);

      if (path === "/" || path === "/health") {
        return json({
          ok: true,
          uptimeSec: Math.floor((Date.now() - stats.start) / 1000),
          authConfigured: Boolean(config.authToken),
          stats: { ...stats, htmlCache: htmlCache.size, redirects: redirectCache.size, tinfoilCache: tinfoilCache.size },
          endpoints: [
            "/tinfoil.json",
            "/tinfoil",
            "/tinfoil/page/:n",
            "/tinfoil/mode/:mode",
            "/local-test.json",
            "/local-files",
            "/local-file?path=...",
            "/health",
          ],
        });
      }

      if (path === "/test") {
        const r = await fetchWithTimeout(`${BASE_URL}en`, { headers: { "User-Agent": "Mozilla/5.0" } });
        return json({ ok: r.ok, status: r.status });
      }

      if (path === "/local-test.json") {
        const base = publicBaseUrl(request);
        const filesOnDisk = await listLocalGameFiles();
        const files = filesOnDisk.map((f) => ({
          url: `${base}/local-file?path=${encodeURIComponent(f.relPath)}#${sanitizeFilename(f.name)}`,
          size: f.size,
        }));

        return json({
          version: config.tinfoilVersion,
          titledb: {},
          directories: [],
          files,
          source: "local-games-folder",
          count: files.length,
          totalSize: filesOnDisk.reduce((sum, f) => sum + f.size, 0),
        });
      }

      if (path === "/local-files") {
        const files = await listLocalGameFiles();
        return json({
          count: files.length,
          files: files.map((f) => ({
            path: f.relPath,
            name: f.name,
            size: f.size,
            sizeText: formatBytes(f.size),
            url: `/local-file?path=${encodeURIComponent(f.relPath)}`,
          })),
        });
      }

      if (path === "/local-file") {
        const relPath = url.searchParams.get("path") ?? "";
        const abs = safeResolveLocalPath(relPath);
        if (!abs) return json({ error: "Invalid file path" }, 400);

        const fileStat = await stat(abs).catch(() => null);
        if (!fileStat || !fileStat.isFile()) return json({ error: "File not found" }, 404);

        const filename = nodePath.basename(abs);
        const totalSize = fileStat.size || 0;
        const safeName = sanitizeFilename(filename) || "download.bin";
        const baseHeaders: Record<string, string> = {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
        };

        const range = parseByteRange(request.headers.get("range"), totalSize);
        if (range === "invalid") {
          return new Response(null, {
            status: 416,
            headers: {
              ...baseHeaders,
              "Content-Range": `bytes */${totalSize}`,
              "Content-Length": "0",
            },
          });
        }

        if (range) {
          const chunkLength = range.end - range.start + 1;
          const body = request.method === "HEAD" ? null : fileBody(abs, range.start, range.end);
          return new Response(body, {
            status: 206,
            headers: {
              ...baseHeaders,
              "Content-Range": `bytes ${range.start}-${range.end}/${totalSize}`,
              "Content-Length": String(chunkLength),
            },
          });
        }

        if (request.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: {
              ...baseHeaders,
              "Content-Length": String(totalSize),
            },
          });
        }

        return new Response(fileBody(abs), {
          status: 200,
          headers: {
            ...baseHeaders,
            "Content-Length": String(totalSize),
          },
        });
      }

      if (path === "/api/titles") {
        const p = queryPage(url.searchParams);
        const pages = queryPages(url.searchParams);
        const s = querySearch(url.searchParams);
        const sb = sortBy(queryParam(url.searchParams, ["sb", "sort", "sort_by"]));
        const so = sortOrder(queryParam(url.searchParams, ["so", "order", "sort_order"]));
        const data = await getTitlesRange(p, pages, s, sb, so);
        return json({ source: `${BASE_URL}${LIST_PATH}`, page: p, pages, pageCount: data.pageCount, count: data.items.length, items: data.items });
      }

      if (path.startsWith("/api/game/")) {
        const id = path.replace("/api/game/", "").trim().toUpperCase();
        if (!TITLE_ID_RE.test(id)) return json({ error: "Invalid or missing game id" }, 400);
        const raw = await fetchHtml(new URL(`${GAME_PATH_PREFIX}${id}`, BASE_URL).toString());
        return json(parseGamePage(raw, id));
      }

      if (path.startsWith("/download/")) {
        const [, , rawId, rawType] = path.split("/");
        const id = (rawId ?? "").toUpperCase();
        const type = (rawType ?? "base").toLowerCase();
        if (!TITLE_ID_RE.test(id)) return json({ error: "Invalid or missing game id" }, 400);
        if (!DOWNLOAD_TYPES.has(type)) return json({ error: "Invalid download type" }, 400);
        if (!config.authToken) {
          log("WARN", "Download blocked: AUTH_TOKEN missing", { id, type });
          return json({ error: "AUTH_TOKEN is not configured", hint: "Set AUTH_TOKEN (or ACCESS_TOKEN) in environment variables." }, 503);
        }

        const resolved = await resolveDownload(id, type);
        if (!resolved.ok) {
          log("WARN", "Download resolve failed", {
            id,
            type,
            status: resolved.status,
            source: resolved.source,
            challenge: resolved.challenge ?? undefined,
          });
          const isDeviceChallenge = (resolved.challenge ?? "").toLowerCase().includes("deviceid");
          const hint = isDeviceChallenge && !config.deviceId
            ? "Upstream requested DeviceID. Set DEVICE_ID from a logged-in browser session."
            : undefined;
          return json(
            {
              error: "Download not found or unauthorized",
              upstreamStatus: resolved.status,
              upstreamSource: resolved.source,
              ...(resolved.challenge ? { upstreamChallenge: resolved.challenge } : {}),
              ...(resolved.details ? { upstreamDetails: resolved.details } : {}),
              ...(hint ? { hint } : {}),
            },
            resolved.status === 503 ? 503 : 404,
          );
        }

        log("INFO", "Download resolved", {
          id,
          type,
          source: resolved.source,
          proxy: config.downloadProxy,
          host: (() => {
            try {
              return new URL(resolved.url).host;
            } catch {
              return "invalid-url";
            }
          })(),
        });

        if (!config.downloadProxy) {
          return new Response(null, { status: 302, headers: { Location: resolved.url, "Cache-Control": "no-store" } });
        }

        const upstreamHeaders: Record<string, string> = {};
        const range = request.headers.get("range");
        if (range) upstreamHeaders.Range = range;

        const upstream = await fetchWithTimeout(resolved.url, {
          method: request.method === "HEAD" ? "HEAD" : "GET",
          headers: upstreamHeaders,
          redirect: "follow",
        });

        if (!upstream.ok && upstream.status !== 206) {
          log("WARN", "Download proxy failed", { id, type, upstreamStatus: upstream.status });
          const details = await upstream.text().then((x) => x.trim().slice(0, 500)).catch(() => "");
          return json(
            {
              error: "Mirror download failed",
              upstreamStatus: upstream.status,
              ...(details ? { upstreamDetails: details } : {}),
            },
            502,
          );
        }

        const fileName = downloadFilenameFromUrl(resolved.url);
        const headers = copyDownloadHeaders(upstream.headers, fileName);
        log("INFO", "Download proxied", { id, type, upstreamStatus: upstream.status, range: range ?? undefined });
        return new Response(request.method === "HEAD" ? null : upstream.body, {
          status: upstream.status,
          headers,
        });
      }

      if (path === "/shop") {
        const p = queryPage(url.searchParams);
        const s = querySearch(url.searchParams);
        const sb = sortBy(queryParam(url.searchParams, ["sb", "sort", "sort_by"]));
        const so = sortOrder(queryParam(url.searchParams, ["so", "order", "sort_order"]));
        const data = await getTitlesRange(p, 1, s, sb, so);

        const prev = p > 1 ? `<a href="/shop?p=${p - 1}">Prev</a>` : "";
        const next = data.pageCount && p < data.pageCount ? `<a href="/shop?p=${p + 1}">Next</a>` : "";
        const rows = data.items
          .map((item) => `<li><a href="/shop/game/${item.id}">${escapeHtml(item.title)}</a>${item.size ? ` - ${escapeHtml(item.size)}` : ""}</li>`)
          .join("\n");

        return html(`<!doctype html><html><body><h1>notUltraNX titles</h1><p>${prev} ${next}</p><ul>${rows}</ul></body></html>`);
      }

      if (path.startsWith("/shop/game/")) {
        const id = path.replace("/shop/game/", "").trim().toUpperCase();
        if (!TITLE_ID_RE.test(id)) return html("<p>Invalid game id</p>", 400);
        const raw = await fetchHtml(new URL(`${GAME_PATH_PREFIX}${id}`, BASE_URL).toString());
        const g = parseGamePage(raw, id);
        const title = escapeHtml(g.title ?? id);
        return html(`<!doctype html><html><body><h1>${title}</h1><p><a href="/shop">Back</a></p></body></html>`);
      }

      const tinfoilPageMatch = path.match(/^\/tinfoil\/page\/(\d+)$/);
      const tinfoilModeMatch = path.match(/^\/tinfoil\/mode\/([a-z0-9_-]+)$/);
      if (path === "/tinfoil.json" || path === "/tinfoil" || tinfoilPageMatch || tinfoilModeMatch) {
        const isRootIndex = path === "/tinfoil.json" || path === "/tinfoil";
        const forcedPage = tinfoilPageMatch ? clampInt(tinfoilPageMatch[1] ?? "1", 1, 1, 9_999) : null;
        const mode = (tinfoilModeMatch?.[1] ?? "").toLowerCase();

        const p = forcedPage ?? queryPage(url.searchParams);
        const pages = queryPages(url.searchParams);
        const s = querySearch(url.searchParams);
        const sb = sortBy(queryParam(url.searchParams, ["sb", "sort", "sort_by"]));
        const so = sortOrder(queryParam(url.searchParams, ["so", "order", "sort_order"]));
        const loadAllRequested = mode === "all" || mode === "games-all" || mode === "dlc" || queryBool(queryParam(url.searchParams, ["loadall", "all_pages", "allpages"]));
        const flatAllRoot = config.tinfoilFlatAll && isRootIndex && !tinfoilPageMatch && !tinfoilModeMatch;
        const loadAll = loadAllRequested || flatAllRoot;
        const includeAllRequested = mode === "games-all" || queryBool(queryParam(url.searchParams, ["all", "full", "details"]));
        const includeAll = includeAllRequested || (flatAllRoot && config.tinfoilIncludeAll);
        const filterFromMode = mode === "games-all" ? "games" : mode === "dlc" ? "dlc" : "";
        const filter = (filterFromMode || (queryParam(url.searchParams, ["type", "content_type", "filter_type"]) ?? "")).trim().toLowerCase();
        const base = publicBaseUrl(request);
        const tinfoilCacheKey = `${base}|${path}|${url.search}`;
        const tinfoilCached = cacheGet(tinfoilCache, tinfoilCacheKey);
        if (tinfoilCached) return json(tinfoilCached);

        const data = loadAll ? await getAllTitles(s, sb, so) : await getTitlesRange(p, pages, s, sb, so);
        const isGameFamily = (id: string) => id.endsWith("000") || id.endsWith("800");
        const filtered = data.items.filter((item) => (filter === "games" ? isGameFamily(item.id) : filter === "dlc" ? !isGameFamily(item.id) : true));

        const entries = [] as Array<{ item: TitleCard; downloads: GameDownload[]; publisher: string | null; description: string | null; region: string | null }>;
        if (includeAll) {
          for (let i = 0; i < filtered.length; i += config.batchSize) {
            const batch = filtered.slice(i, i + config.batchSize);
            const batchData = await Promise.all(
              batch.map(async (item) => {
                try {
                  const raw = await fetchHtml(new URL(`${GAME_PATH_PREFIX}${item.id}`, BASE_URL).toString());
                  const detail = parseGamePage(raw, item.id);
                  return { item, downloads: detail.downloads, publisher: detail.publisher, description: detail.categories, region: detail.languages?.split(",")[0]?.trim().toUpperCase() ?? "WW" };
                } catch {
                  return { item, downloads: [{ type: "base", size: item.size, version: 0 }], publisher: null, description: null, region: null };
                }
              }),
            );
            entries.push(...batchData);
          }
        } else {
          entries.push(...filtered.map((item) => ({ item, downloads: [{ type: "base", size: item.size, version: 0 }], publisher: null, description: null, region: null })));
        }

        const titledb: Record<string, { id: string; name: string; size: number; version: number; releaseDate?: number; icon?: string; publisher?: string; description?: string; region?: string }> = {};
        const files: Array<{ url: string; size: number }> = [];

        for (const e of entries) {
          const release = parseReleaseDate(e.item.releaseDate);
          titledb[e.item.id] = {
            id: e.item.id,
            name: e.item.title,
            size: parseSizeToBytes(e.item.size),
            version: 0,
            ...(release ? { releaseDate: release } : {}),
            ...(e.item.image ? { icon: e.item.image } : {}),
            ...(e.publisher ? { publisher: e.publisher } : {}),
            ...(e.description ? { description: e.description } : {}),
            ...(e.region ? { region: e.region } : {}),
          };

          for (const d of e.downloads) {
            if (!DOWNLOAD_TYPES.has(d.type)) continue;
            const nameTitleId = titleIdForType(e.item.id, d.type);
            const name = sanitizeFilename(e.item.title);
            const fileName = d.type === "update"
              ? `${name} [${nameTitleId}][v${d.version ?? 0}].nsz`
              : d.type === "dlc"
                ? `${name} [${nameTitleId}][DLC].nsz`
                : d.type === "full"
                  ? `${name} [${nameTitleId}][FULL].nsz`
                  : `${name} [${nameTitleId}][v0].nsz`;
            files.push({
              url: `${base}/download/${e.item.id}/${d.type}#${fileName}`,
              size: parseSizeToBytes(d.size) || parseSizeToBytes(e.item.size),
            });
          }
        }

        const directories: string[] = [];
        const payload = {
          version: config.tinfoilVersion,
          success: "Connected to tinfoil-ultranx-scraper",
          titledb,
          directories,
          files,
          ...(config.authToken ? {} : { warnings: ["AUTH_TOKEN is missing. /download links will fail."] }),
        };
        cacheSet(tinfoilCache, tinfoilCacheKey, payload);
        return json(payload);
      }

      return json({ error: "Not found", endpoints: ["/tinfoil.json", "/tinfoil", "/tinfoil/page/:n", "/tinfoil/mode/:mode", "/local-test.json", "/health", "/api/titles", "/api/game/:id", "/shop"] }, 404);
    } catch (error) {
      stats.errors++;
      return json({ error: "Internal server error", details: error instanceof Error ? error.message : String(error) }, 500);
    } finally {
      log("INFO", `${request.method} ${path} completed`, { ms: Date.now() - started });
    }
  },
});

console.log(`Server running on http://localhost:${config.port}`);
const ips = lanIps();
if (ips.length > 0) {
  console.log(`LAN IPs: ${ips.join(", ")}`);
  console.log(`Tinfoil URL: http://${ips[0]}:${server.port}/tinfoil.json`);
} else {
  console.log("LAN IPs: not found");
}
