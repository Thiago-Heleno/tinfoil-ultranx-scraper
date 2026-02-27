import { load } from "cheerio";
import os from "node:os";

const BASE_URL = "https://not.ultranx.ru/";
const API_URL = "https://api.ultranx.ru";
const LIST_PATH = "en";
const GAME_PATH_PREFIX = "en/game/";
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
  authToken: (process.env.AUTH_TOKEN ?? "").trim(),
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

function querySearch(params: URLSearchParams): string {
  const aliases = ["s", "q", "query", "search", "term"];
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
  return value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").replace(/\s+/g, " ").trim();
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

async function resolveDownload(id: string, type: string): Promise<string | null> {
  const key = `${id}:${type}`;
  const cached = cacheGet(redirectCache, key);
  if (cached) return cached;
  if (!config.authToken) return null;

  const response = await fetchWithTimeout(`${API_URL}/games/download/${id}/${type}`, {
    headers: {
      Cookie: `auth_token=${config.authToken}`,
      Referer: config.referrer,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    },
    redirect: "manual",
  });

  const location = response.headers.get("location");
  if ((response.status === 301 || response.status === 302) && location) {
    cacheSet(redirectCache, key, location);
    return location;
  }
  return null;
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
          stats: { ...stats, htmlCache: htmlCache.size, redirects: redirectCache.size },
        });
      }

      if (path === "/test") {
        const r = await fetchWithTimeout(`${BASE_URL}en`, { headers: { "User-Agent": "Mozilla/5.0" } });
        return json({ ok: r.ok, status: r.status });
      }

      if (path === "/api/titles") {
        const p = clampInt(url.searchParams.get("p"), 1, 1, 9_999);
        const pages = clampInt(url.searchParams.get("pages"), 1, 1, config.maxPages);
        const s = querySearch(url.searchParams);
        const sb = sortBy(url.searchParams.get("sb"));
        const so = sortOrder(url.searchParams.get("so"));
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
        if (!config.authToken) return json({ error: "AUTH_TOKEN is not configured" }, 503);

        const target = await resolveDownload(id, type);
        if (!target) return json({ error: "Download not found or unauthorized" }, 404);
        return new Response(null, { status: 302, headers: { Location: target } });
      }

      if (path === "/shop") {
        const p = clampInt(url.searchParams.get("p"), 1, 1, 9_999);
        const s = querySearch(url.searchParams);
        const sb = sortBy(url.searchParams.get("sb"));
        const so = sortOrder(url.searchParams.get("so"));
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

      if (path === "/tinfoil.json") {
        const p = clampInt(url.searchParams.get("p"), 1, 1, 9_999);
        const pages = clampInt(url.searchParams.get("pages"), 1, 1, config.maxPages);
        const s = querySearch(url.searchParams);
        const sb = sortBy(url.searchParams.get("sb"));
        const so = sortOrder(url.searchParams.get("so"));
        const loadAll = queryBool(url.searchParams.get("loadall"));
        const includeAll = queryBool(url.searchParams.get("all"));
        const filter = (url.searchParams.get("type") ?? "").trim().toLowerCase();
        const base = publicBaseUrl(request);

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
            const name = sanitizeFilename(e.item.title);
            const fileName = d.type === "update"
              ? `${name} [${e.item.id}][v${d.version ?? 0}].nsz`
              : d.type === "dlc"
                ? `${name} [${e.item.id}][DLC].nsz`
                : d.type === "full"
                  ? `${name} [${e.item.id}][FULL].nsz`
                  : `${name} [${e.item.id}][v0].nsz`;
            files.push({
              url: `${base}/download/${e.item.id}/${d.type}#${encodeURIComponent(fileName)}`,
              size: parseSizeToBytes(d.size) || parseSizeToBytes(e.item.size),
            });
          }
        }

        const directories: Array<string | { url: string; title: string }> = [];
        if (p === 1 && !s && !filter) {
          directories.push(
            { url: `${base}/tinfoil.json?loadall=true`, title: "[ All Titles ]" },
            { url: `${base}/tinfoil.json?loadall=true&type=games&all=true`, title: "[ Games + Updates + DLC ]" },
            { url: `${base}/tinfoil.json?loadall=true&type=dlc`, title: "[ DLC Only ]" },
          );
        }

        if (!loadAll) {
          const max = data.pageCount ?? p;
          const next = p + pages;
          if (next <= max) {
            const q = new URLSearchParams();
            q.set("p", String(next));
            q.set("pages", String(pages));
            if (s) q.set("s", s);
            if (sb !== "release_date") q.set("sb", sb);
            if (so !== "desc") q.set("so", so);
            if (includeAll) q.set("all", "true");
            if (filter) q.set("type", filter);
            directories.push({ url: `${base}/tinfoil.json?${q.toString()}`, title: `[ Page ${next} >> ]` });
          }
        }

        return json({
          version: config.tinfoilVersion,
          titledb,
          directories,
          files,
          ...(config.authToken ? {} : { warnings: ["AUTH_TOKEN is missing. /download links will fail."] }),
        });
      }

      return json({ error: "Not found", endpoints: ["/tinfoil.json", "/health", "/api/titles", "/api/game/:id", "/shop"] }, 404);
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
