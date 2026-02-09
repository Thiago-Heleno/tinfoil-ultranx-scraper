import { load } from "cheerio";
import os from "node:os";

const BASE_URL = "https://not.ultranx.ru/";
const API_URL = "https://api.ultranx.ru";
const LIST_PATH = "en";
const GAME_PATH_PREFIX = "en/game/";

// Configuration from environment
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS ?? "300000", 10);
const MAX_PAGES = parseInt(process.env.MAX_PAGES ?? "10", 10);
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE ?? "5", 10);
const MULTI_PAGE_COUNT = parseInt(process.env.MULTI_PAGE_COUNT ?? "3", 10);
const LOG_REQUESTS = process.env.LOG_REQUESTS !== "false";
const REFERRER = process.env.REFERRER || "https://not.ultranx.ru";
const TINFOIL_MIN_VERSION = 17.0;

// Auth token for direct API downloads
const AUTH_TOKEN =
  process.env.AUTH_TOKEN ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0aWJpcyIsImV4cCI6MjY0MTUwMjI3Nn0.o2LStTlJ4f4MwuTB366KAopvYsSVAX2v_t4NPmqjTFg";

// Request logging
function log(
  level: "INFO" | "WARN" | "ERROR",
  message: string,
  data?: Record<string, unknown>,
) {
  if (!LOG_REQUESTS && level === "INFO") return;
  const timestamp = new Date().toISOString();
  const dataStr = data ? ` ${JSON.stringify(data)}` : "";
  console.log(`[${timestamp}] [${level}] ${message}${dataStr}`);
}

// Server stats
const stats = {
  startTime: Date.now(),
  requests: 0,
  errors: 0,
  cacheHits: 0,
  cacheMisses: 0,
};

type TitleCard = {
  id: string;
  title: string;
  releaseDate: string | null;
  size: string | null;
  image: string | null;
  url: string;
};

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
  downloads: {
    type: string;
    apiUrl: string;
    mirrorUrl: string | null;
    size: string | null;
  }[];
};

type CacheEntry = {
  expiresAt: number;
  data: string;
};

const cache = new Map<string, CacheEntry>();

function clampInt(
  value: string | null,
  min: number,
  max: number,
  fallback: number,
) {
  const parsed = value ? parseInt(value, 10) : NaN;
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function parseSizeToBytes(sizeStr: string | null): number {
  if (!sizeStr) return 0;
  const match = sizeStr.match(/^([\d.]+)\s*(GB|MB|KB|B)?$/i);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  const unit = (match[2] || "B").toUpperCase();
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 * 1024,
    GB: 1024 * 1024 * 1024,
  };
  return Math.round(value * (multipliers[unit] || 1));
}

function buildListUrl(params: {
  page: number;
  search: string;
  sortBy: string;
  sortOrder: string;
}) {
  const url = new URL(LIST_PATH, BASE_URL);
  url.searchParams.set("p", String(params.page));
  url.searchParams.set("s", params.search);
  url.searchParams.set("sb", params.sortBy);
  url.searchParams.set("so", params.sortOrder);
  return url.toString();
}

async function fetchHtml(url: string) {
  const cached = cache.get(url);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    stats.cacheHits++;
    return cached.data;
  }
  stats.cacheMisses++;

  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Upstream request failed: ${response.status} ${response.statusText}`,
    );
  }

  const html = await response.text();
  cache.set(url, { data: html, expiresAt: now + CACHE_TTL_MS });
  return html;
}

// Resolve download URL using auth token - follows redirects to get final Yandex.Disk URL
async function resolveDownloadUrl(
  titleId: string,
  type: string = "base",
): Promise<string | null> {
  const cacheKey = `download:${titleId}:${type}`;
  const cached = cache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.data;

  try {
    const apiUrl = `${API_URL}/games/download/${titleId}/${type}`;
    const response = await fetch(apiUrl, {
      headers: {
        Cookie: `auth_token=${AUTH_TOKEN}`,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      },
      redirect: "manual",
    });

    if (response.status === 302 || response.status === 301) {
      const location = response.headers.get("Location");
      if (location) {
        // Cache the resolved URL
        cache.set(cacheKey, { data: location, expiresAt: now + CACHE_TTL_MS });
        return location;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function parseListPage(html: string) {
  const $ = load(html);
  const items: TitleCard[] = [];

  $(".card").each((_, card) => {
    const el = $(card);
    const href = (el.attr("data-href") ?? "").trim();
    const title = el.find(".card-title").text().trim();
    const spans = el.find(".card-info span");
    const releaseDate = spans.eq(0).text().trim() || null;
    const size = spans.eq(1).text().trim() || null;
    const image = el.find("img").attr("src") ?? null;

    if (!href || !title) return;

    const url = new URL(href, BASE_URL).toString();
    const id = href.split("/").pop() ?? "";

    items.push({
      id,
      title,
      releaseDate,
      size,
      image,
      url,
    });
  });

  let pageCount: number | null = null;
  $(".pagination a").each((_, link) => {
    const text = $(link).text().trim();
    const value = parseInt(text, 10);
    if (!Number.isNaN(value)) {
      pageCount = Math.max(pageCount ?? 0, value);
    }
  });

  return { items, pageCount };
}

function parseGamePage(html: string, id: string): GameDetail {
  const $ = load(html);
  const title = $(".game-hero h1").text().trim() || null;

  const meta: Record<string, string> = {};
  $(".game-meta p").each((_, row) => {
    const label = $(row).find("strong").text().trim();
    const value = $(row).text().replace(label, "").trim();
    if (label) meta[label.replace(/:$/, "")] = value || "";
  });

  const images: string[] = [];
  $(".carousel-item img").each((_, img) => {
    const src = $(img).attr("src");
    if (src) images.push(src);
  });

  // Extract download links
  const downloads: GameDetail["downloads"] = [];
  $(".download-buttons > div, .download-buttons > a").each((_, el) => {
    const container = $(el);
    const links = container.find("a.button").toArray();
    if (links.length === 0 && container.is("a.button")) {
      links.push(el);
    }

    const apiLink = $(links[0]);
    const apiUrl = apiLink.attr("href") ?? "";
    const mirrorLink = links.length > 1 ? $(links[1]) : null;
    const mirrorUrl = mirrorLink?.attr("href") ?? null;

    // Extract type and size from text
    const text = apiLink.text().trim();
    let type = "base";
    if (text.toLowerCase().includes("update")) type = "update";
    else if (text.toLowerCase().includes("dlc")) type = "dlc";
    else if (
      text.toLowerCase().includes("everything") ||
      text.toLowerCase().includes("full")
    )
      type = "full";

    // Extract size (e.g., "4.79 GB")
    const sizeMatch = text.match(/([\d.]+\s*(?:GB|MB|KB|B))/i);
    const size = sizeMatch ? sizeMatch[1] : null;

    if (apiUrl) {
      downloads.push({ type, apiUrl, mirrorUrl, size });
    }
  });

  const url = new URL(`${GAME_PATH_PREFIX}${id}`, BASE_URL).toString();

  return {
    id,
    title,
    publisher: meta["Publisher"] ?? null,
    releaseDate: meta["Release Date"] ?? null,
    size: meta["Size"] ?? null,
    categories: meta["Categories"] ?? null,
    languages: meta["Languages"] ?? null,
    players: meta["Number of Players"] ?? null,
    images,
    url,
    downloads,
  };
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function htmlResponse(html: string, status = 200) {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

// Fetch a single page of titles
async function getTitlesPage(params: {
  page: number;
  search: string;
  sortBy: string;
  sortOrder: string;
}) {
  const url = buildListUrl(params);
  const html = await fetchHtml(url);
  const parsed = parseListPage(html);
  return { url, ...parsed };
}

// Multi-page fetching for faster loading
async function getTitlesMultiPage(params: {
  startPage: number;
  pageCount: number;
  search: string;
  sortBy: string;
  sortOrder: string;
}) {
  const allItems: TitleCard[] = [];
  let totalPageCount: number | null = null;

  // Fetch pages in parallel
  const pagePromises = [];
  for (let i = 0; i < params.pageCount; i++) {
    const page = params.startPage + i;
    pagePromises.push(
      getTitlesPage({
        page,
        search: params.search,
        sortBy: params.sortBy,
        sortOrder: params.sortOrder,
      }).catch(() => null),
    );
  }

  const results = await Promise.all(pagePromises);
  for (const result of results) {
    if (result) {
      allItems.push(...result.items);
      if (
        result.pageCount &&
        (totalPageCount === null || result.pageCount > totalPageCount)
      ) {
        totalPageCount = result.pageCount;
      }
    }
  }

  return { items: allItems, pageCount: totalPageCount };
}

// Load ALL pages at once
async function getAllTitles(params: {
  search: string;
  sortBy: string;
  sortOrder: string;
}): Promise<{ items: TitleCard[]; pageCount: number }> {
  // First, get page 1 to find total page count
  const firstPage = await getTitlesPage({
    page: 1,
    search: params.search,
    sortBy: params.sortBy,
    sortOrder: params.sortOrder,
  });

  const totalPages = firstPage.pageCount ?? 1;
  if (totalPages === 1) {
    return { items: firstPage.items, pageCount: 1 };
  }

  // Fetch remaining pages in parallel batches
  const allItems = [...firstPage.items];
  const BATCH = 5; // Fetch 5 pages at a time to not overwhelm the server

  for (let startPage = 2; startPage <= totalPages; startPage += BATCH) {
    const endPage = Math.min(startPage + BATCH - 1, totalPages);
    const pagePromises = [];

    for (let p = startPage; p <= endPage; p++) {
      pagePromises.push(
        getTitlesPage({
          page: p,
          search: params.search,
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
        }).catch(() => null),
      );
    }

    const results = await Promise.all(pagePromises);
    for (const result of results) {
      if (result) {
        allItems.push(...result.items);
      }
    }
  }

  return { items: allItems, pageCount: totalPages };
}

function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses: string[] = [];

  for (const entries of Object.values(interfaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family === "IPv4" && !entry.internal) {
        addresses.push(entry.address);
      }
    }
  }

  return Array.from(new Set(addresses));
}

const server = Bun.serve({
  port: PORT,
  async fetch(request) {
    const startTime = Date.now();
    stats.requests++;

    const url = new URL(request.url);
    const pathname =
      url.pathname.length > 1 && url.pathname.endsWith("/")
        ? url.pathname.slice(0, -1)
        : url.pathname;

    log("INFO", `${request.method} ${pathname}`, {
      query: Object.fromEntries(url.searchParams),
      ip: request.headers.get("x-forwarded-for") ?? "unknown",
    });

    if (pathname === "/" || pathname === "/health") {
      const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
      return jsonResponse({
        ok: true,
        message: "notUltraNX scraper is running",
        version: "1.0.0",
        uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s`,
        stats: {
          requests: stats.requests,
          errors: stats.errors,
          cacheHits: stats.cacheHits,
          cacheMisses: stats.cacheMisses,
          cacheSize: cache.size,
        },
        endpoints: [
          "GET /tinfoil.json - Tinfoil shop index",
          "GET /download/:id/:type - Download proxy (resolves to Yandex)",
          "GET /api/titles - List all titles",
          "GET /api/game/:id - Get game details",
          "GET /shop - HTML browser",
        ],
      });
    }

    if (pathname === "/api/titles") {
      const page = clampInt(url.searchParams.get("p"), 1, 9999, 1);
      const pages = clampInt(url.searchParams.get("pages"), 1, MAX_PAGES, 1);
      const search = url.searchParams.get("s") ?? "";
      const sortBy = url.searchParams.get("sb") ?? "release_date";
      const sortOrder = url.searchParams.get("so") ?? "desc";

      try {
        const items: TitleCard[] = [];
        let pageCount: number | null = null;

        for (let i = 0; i < pages; i += 1) {
          const currentPage = page + i;
          const result = await getTitlesPage({
            page: currentPage,
            search,
            sortBy,
            sortOrder,
          });

          if (pageCount === null) pageCount = result.pageCount ?? null;
          items.push(...result.items);
        }

        return jsonResponse({
          source: "https://not.ultranx.ru/en",
          page,
          pages,
          pageCount,
          count: items.length,
          items,
        });
      } catch (error) {
        return jsonResponse(
          {
            error: "Failed to fetch titles",
            details: error instanceof Error ? error.message : String(error),
          },
          502,
        );
      }
    }

    if (pathname.startsWith("/api/game/")) {
      const id = pathname.replace("/api/game/", "").trim();
      if (!id) return jsonResponse({ error: "Missing game id" }, 400);

      try {
        const html = await fetchHtml(
          new URL(`${GAME_PATH_PREFIX}${id}`, BASE_URL).toString(),
        );
        const details = parseGamePage(html, id);
        return jsonResponse(details);
      } catch (error) {
        return jsonResponse(
          {
            error: "Failed to fetch game details",
            details: error instanceof Error ? error.message : String(error),
          },
          502,
        );
      }
    }

    // Download proxy - resolves API redirect to Yandex URL server-side
    // This prevents Tinfoil from sending referer to Yandex which blocks it
    if (pathname.startsWith("/download/")) {
      const parts = pathname.replace("/download/", "").split("/");
      const id = parts[0];
      const type = parts[1] || "base";

      if (!id) return jsonResponse({ error: "Missing game id" }, 400);

      try {
        const apiUrl = `${API_URL}/games/download/${id}/${type}`;
        const response = await fetch(apiUrl, {
          headers: {
            Cookie: `auth_token=${AUTH_TOKEN}`,
            Referer: REFERRER,
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
          },
          redirect: "manual",
        });

        if (response.status === 302 || response.status === 301) {
          const location = response.headers.get("Location");
          if (location) {
            log("INFO", `Resolved download`, {
              id,
              type,
              redirect: location.substring(0, 80) + "...",
            });
            return new Response(null, {
              status: 302,
              headers: { Location: location },
            });
          }
        }

        log("ERROR", `Download resolution failed`, {
          id,
          type,
          status: response.status,
        });
        return jsonResponse({ error: "Download not found" }, 404);
      } catch (error) {
        log("ERROR", `Download proxy error`, {
          id,
          type,
          error: error instanceof Error ? error.message : String(error),
        });
        return jsonResponse({ error: "Failed to resolve download" }, 502);
      }
    }

    if (pathname === "/shop") {
      const page = clampInt(url.searchParams.get("p"), 1, 9999, 1);
      const search = url.searchParams.get("s") ?? "";
      const sortBy = url.searchParams.get("sb") ?? "release_date";
      const sortOrder = url.searchParams.get("so") ?? "desc";

      try {
        const result = await getTitlesPage({ page, search, sortBy, sortOrder });
        const nextPage =
          result.pageCount && page < result.pageCount ? page + 1 : null;
        const prevPage = page > 1 ? page - 1 : null;

        const links = result.items
          .map((item) => {
            const title = escapeHtml(item.title);
            const meta = [item.releaseDate, item.size]
              .filter(Boolean)
              .join(" | ");
            const metaText = meta ? ` - ${escapeHtml(meta)}` : "";
            return `<li><a href="/shop/game/${item.id}">${title}</a>${metaText}</li>`;
          })
          .join("\n");

        const navLinks = [
          prevPage ? `<a href="/shop?p=${prevPage}">Prev</a>` : "",
          nextPage ? `<a href="/shop?p=${nextPage}">Next</a>` : "",
        ]
          .filter(Boolean)
          .join(" ");

        const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>notUltraNX titles</title>
</head>
<body>
  <h1>notUltraNX titles</h1>
  <p>Page ${page}${result.pageCount ? ` of ${result.pageCount}` : ""}</p>
  ${navLinks ? `<p>${navLinks}</p>` : ""}
  <ul>
    ${links}
  </ul>
</body>
</html>`;

        return htmlResponse(html);
      } catch (error) {
        return htmlResponse(
          `<!doctype html><html><body><p>Failed to fetch titles: ${escapeHtml(
            error instanceof Error ? error.message : String(error),
          )}</p></body></html>`,
          502,
        );
      }
    }

    if (pathname.startsWith("/shop/game/")) {
      const id = pathname.replace("/shop/game/", "").trim();
      if (!id) return htmlResponse("<p>Missing game id</p>", 400);

      try {
        const html = await fetchHtml(
          new URL(`${GAME_PATH_PREFIX}${id}`, BASE_URL).toString(),
        );
        const detail = parseGamePage(html, id);
        const title = detail.title ? escapeHtml(detail.title) : id;

        const metaRows = [
          ["Publisher", detail.publisher],
          ["Release Date", detail.releaseDate],
          ["Size", detail.size],
          ["Categories", detail.categories],
          ["Languages", detail.languages],
          ["Players", detail.players],
        ]
          .filter(([, value]) => value)
          .map(
            ([label, value]) =>
              `<li><strong>${label}:</strong> ${escapeHtml(value!)}</li>`,
          )
          .join("\n");

        const images = detail.images
          .map((src) => `<li>${escapeHtml(src)}</li>`)
          .join("\n");

        const detailHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
</head>
<body>
  <h1>${title}</h1>
  <p><a href="/shop">Back to list</a></p>
  <ul>
    ${metaRows}
  </ul>
  <p>Source: <a href="${escapeHtml(detail.url)}">${escapeHtml(detail.url)}</a></p>
  ${images ? `<h2>Images</h2><ul>${images}</ul>` : ""}
</body>
</html>`;

        return htmlResponse(detailHtml);
      } catch (error) {
        return htmlResponse(
          `<!doctype html><html><body><p>Failed to fetch details: ${escapeHtml(
            error instanceof Error ? error.message : String(error),
          )}</p></body></html>`,
          502,
        );
      }
    }

    if (pathname === "/tinfoil.json") {
      try {
        const page = clampInt(url.searchParams.get("p"), 1, 9999, 1);
        const search = url.searchParams.get("s") ?? "";
        const sortBy = url.searchParams.get("sb") ?? "release_date";
        const sortOrder = url.searchParams.get("so") ?? "desc";
        const typeFilter = url.searchParams.get("type") ?? ""; // "games", "dlc", or ""
        const includeAll = url.searchParams.get("all") === "true"; // Include updates, DLC, full
        const multiPage = url.searchParams.get("multi") === "true"; // Load multiple pages at once
        const loadAll = url.searchParams.get("loadall") === "true"; // Load ALL pages at once

        // Get base URL from request for building directory links
        const host = request.headers.get("host") ?? `localhost:${PORT}`;
        const protocol = request.headers.get("x-forwarded-proto") ?? "http";
        const baseUrl = `${protocol}://${host}`;

        // Fetch titles based on mode
        let result: { items: TitleCard[]; pageCount: number | null };
        if (loadAll) {
          // Load ALL pages at once
          log("INFO", "Loading all pages...");
          result = await getAllTitles({ search, sortBy, sortOrder });
          log("INFO", `Loaded ${result.items.length} total items from ${result.pageCount} pages`);
        } else if (multiPage) {
          result = await getTitlesMultiPage({
            startPage: page,
            pageCount: MULTI_PAGE_COUNT,
            search,
            sortBy,
            sortOrder,
          });
        } else {
          const singlePage = await getTitlesPage({
            page,
            search,
            sortBy,
            sortOrder,
          });
          result = { items: singlePage.items, pageCount: singlePage.pageCount };
        }
        const pageCount = result.pageCount ?? page;

        // Filter by type (base games end in 000/800, DLC ends in 001-7FF)
        const isBaseGame = (id: string) =>
          id.endsWith("000") || id.endsWith("800");
        let filteredItems = result.items;
        if (typeFilter === "games") {
          filteredItems = result.items.filter((item) => isBaseGame(item.id));
        } else if (typeFilter === "dlc") {
          filteredItems = result.items.filter((item) => !isBaseGame(item.id));
        }
        // "all" or "" - no filter, show everything

        // If includeAll, fetch game details to get all download types and metadata
        type GameDownloads = {
          item: TitleCard;
          downloads: { type: string; apiUrl: string; size: string | null }[];
          publisher?: string | null;
          description?: string | null;
          region?: string | null;
        };
        let gamesWithDownloads: GameDownloads[] = [];

        if (includeAll) {
          // Fetch game details in parallel (limit concurrency)
          const fetchGameDownloads = async (
            item: TitleCard,
          ): Promise<GameDownloads> => {
            try {
              const html = await fetchHtml(
                new URL(`${GAME_PATH_PREFIX}${item.id}`, BASE_URL).toString(),
              );
              const details = parseGamePage(html, item.id);
              return {
                item,
                downloads: details.downloads.map((d) => ({
                  type: d.type,
                  apiUrl: d.apiUrl,
                  size: d.size,
                })),
                publisher: details.publisher,
                description: details.categories, // Use categories as description
                region: details.languages?.split(",")[0]?.trim() || "WW",
              };
            } catch {
              // Fallback to base only
              return {
                item,
                downloads: [
                  {
                    type: "base",
                    apiUrl: `${API_URL}/games/download/${item.id}/base`,
                    size: item.size,
                  },
                ],
              };
            }
          };

          // Process in batches to avoid overwhelming the server
          for (let i = 0; i < filteredItems.length; i += BATCH_SIZE) {
            const batch = filteredItems.slice(i, i + BATCH_SIZE);
            const results = await Promise.all(batch.map(fetchGameDownloads));
            gamesWithDownloads.push(...results);
          }
        } else {
          // Just use base downloads from list
          gamesWithDownloads = filteredItems.map((item) => ({
            item,
            downloads: [
              {
                type: "base",
                apiUrl: `${API_URL}/games/download/${item.id}/base`,
                size: item.size,
              },
            ],
          }));
        }

        // Build titledb for game metadata (including icon for images)
        const titledb: Record<
          string,
          {
            id: string;
            name: string;
            size: number;
            version?: number;
            releaseDate?: number;
            icon?: string;
            publisher?: string;
            description?: string;
            region?: string;
          }
        > = {};
        for (const {
          item,
          publisher,
          description,
          region,
        } of gamesWithDownloads) {
          // Convert date from "DD.MM.YYYY" to YYYYMMDD number
          let releaseDateNum: number | undefined;
          if (item.releaseDate) {
            const parts = item.releaseDate.split(".");
            if (parts.length === 3) {
              releaseDateNum = parseInt(
                `${parts[2]}${parts[1]}${parts[0]}`,
                10,
              );
            }
          }
          titledb[item.id] = {
            id: item.id,
            name: item.title,
            size: parseSizeToBytes(item.size),
            version: 0,
            releaseDate: releaseDateNum,
            // Add icon from scraped image
            ...(item.image && { icon: item.image }),
            // Add extra metadata when available (deep scan mode)
            ...(publisher && { publisher }),
            ...(description && { description }),
            ...(region && { region }),
          };
        }

        // Build files array with all download types
        // Filename format: [Title Name][Title ID][vX].nsz / .dlc.nsz
        const files: { url: string; size: number }[] = [];
        for (const { item, downloads } of gamesWithDownloads) {
          const safeName = item.title.replace(/[<>:"/\\|?*]/g, "_");

          for (const dl of downloads) {
            let filename: string;
            const size = parseSizeToBytes(dl.size);

            switch (dl.type) {
              case "update":
                // Updates use version number in filename
                filename = `${safeName} [${item.id}][v65536].nsz`;
                break;
              case "dlc":
                // DLC files
                filename = `${safeName} [DLC].nsz`;
                break;
              case "full":
                // Full pack (base + update + dlc)
                filename = `${safeName} [${item.id}][FULL].nsz`;
                break;
              default:
                // Base game
                filename = `${safeName} [${item.id}][v0].nsz`;
            }

            files.push({
              // Use proxy endpoint to avoid Yandex referer blocking
              url: `${baseUrl}/download/${item.id}/${dl.type}#${encodeURIComponent(filename)}`,
              size: size || parseSizeToBytes(item.size),
            });
          }
        }

        // Build directories for pagination and category navigation
        const directories: (string | { url: string; title: string })[] = [];

        // Add menu options on first page when not filtered (or when loadall)
        if ((page === 1 || loadAll) && !typeFilter && !search) {
          // Main browse options
          directories.push(
            {
              url: `${baseUrl}/tinfoil.json?loadall=true`,
              title: "[ ALL GAMES ]",
            },
            {
              url: `${baseUrl}/tinfoil.json?loadall=true&type=games&all=true`,
              title: "[ All Games + Updates + DLC ]",
            },
            {
              url: `${baseUrl}/tinfoil.json?loadall=true&type=dlc`,
              title: "[ All DLC Only ]",
            },
          );

          // Sort options (with loadall)
          directories.push(
            {
              url: `${baseUrl}/tinfoil.json?loadall=true&sb=name&so=asc`,
              title: "[ A-Z ]",
            },
            {
              url: `${baseUrl}/tinfoil.json?loadall=true&sb=name&so=desc`,
              title: "[ Z-A ]",
            },
            {
              url: `${baseUrl}/tinfoil.json?loadall=true&sb=size&so=desc`,
              title: "[ By Size ]",
            },
          );
        }

        // Add pagination (next page) - only when not loading all
        if (!loadAll && page < pageCount) {
          const nextParams = new URLSearchParams();
          const nextPage = multiPage ? page + MULTI_PAGE_COUNT : page + 1;
          nextParams.set("p", String(nextPage));
          if (search) nextParams.set("s", search);
          if (sortBy !== "release_date") nextParams.set("sb", sortBy);
          if (sortOrder !== "desc") nextParams.set("so", sortOrder);
          if (typeFilter) nextParams.set("type", typeFilter);
          if (includeAll) nextParams.set("all", "true");
          if (multiPage) nextParams.set("multi", "true");
          directories.push({
            url: `${baseUrl}/tinfoil.json?${nextParams.toString()}`,
            title: `[ Page ${nextPage} >> ]`,
          });
        }

        return jsonResponse({
          // Tinfoil configuration
          version: TINFOIL_MIN_VERSION,
          // No referrer or headers needed - proxy handles auth internally

          // Game data
          titledb,
          directories,
          files,
        });
      } catch (error) {
        stats.errors++;
        log("ERROR", "Failed to build tinfoil index", {
          error: error instanceof Error ? error.message : String(error),
        });
        return jsonResponse(
          {
            error: "Failed to build tinfoil index",
            details: error instanceof Error ? error.message : String(error),
            hint: "Check server logs for more details. Make sure the upstream site is accessible.",
          },
          502,
        );
      }
    }

    return jsonResponse(
      {
        error: "Not found",
        availableEndpoints: [
          "/tinfoil.json",
          "/health",
          "/api/titles",
          "/api/game/:id",
        ],
      },
      404,
    );
  },
});

console.log(`Server running on http://localhost:${PORT}`);
const lanIps = getLanAddresses();
if (lanIps.length) {
  console.log(`LAN IPs: ${lanIps.join(", ")}`);
  console.log(`Tinfoil URL: http://${lanIps[0]}:${server.port}/tinfoil.json`);
} else {
  console.log("LAN IPs: not found");
}
