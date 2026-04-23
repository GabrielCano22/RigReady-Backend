import { Router, type Request, type Response } from "express";

export const steamRouter: Router = Router();

const STEAM_SEARCH_URL = "https://store.steampowered.com/api/storesearch/";
const STEAM_DETAILS_URL = "https://store.steampowered.com/api/appdetails";
const CACHE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5_000;
const MIN_QUERY_LEN = 2;
const MAX_QUERY_LEN = 100;
const MAX_RESULTS = 10;
const USER_AGENT =
  "Mozilla/5.0 (compatible; RigReady/0.1; +https://rigready.local)";

const CONTROL_CHAR_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202f]/g;

const NUMERIC_SLUG_PATTERN = /^\d+$/;

/**
 * Removes ASCII control characters and zero-width codepoints so the query
 * cannot smuggle CR/LF or direction-override bytes into the upstream URL.
 */
function sanitizeQuery(raw: string): string {
  return raw.replace(CONTROL_CHAR_PATTERN, "").trim();
}

interface CacheEntry<T = unknown> {
  expiresAt: number;
  data: T;
}

/**
 * Tiny single-process TTL cache. Good enough for a single-node deployment;
 * swap for Redis if the service is ever scaled horizontally.
 */
class TtlCache {
  private readonly store = new Map<string, CacheEntry>();

  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.data as T;
  }

  set(key: string, data: unknown, ttlMs: number): void {
    this.store.set(key, { expiresAt: Date.now() + ttlMs, data });
  }
}

const cache = new TtlCache();

/**
 * GETs a JSON resource from Steam with a hard timeout and a private cache.
 * Never forwards raw upstream error text to the caller; the caller decides
 * how to translate failures into API responses.
 */
async function fetchSteamJson<T>(url: string): Promise<T> {
  const cached = cache.get<T>(url);
  if (cached !== null) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Steam upstream ${res.status}`);
    const data = (await res.json()) as T;
    cache.set(url, data, CACHE_TTL_MS);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

interface SteamSearchItem {
  id: number;
  name: string;
  tiny_image?: string;
  price?: { final?: number; currency?: string };
  platforms?: { windows?: boolean; mac?: boolean; linux?: boolean };
}
interface SteamSearchResponse {
  items?: SteamSearchItem[];
  total?: number;
}

interface SteamDetailsEntry {
  success: boolean;
  data?: {
    name: string;
    steam_appid: number;
    short_description?: string;
    header_image?: string;
    release_date?: { date?: string };
    genres?: Array<{ description: string }>;
    platforms?: { windows?: boolean };
    pc_requirements?: { minimum?: string; recommended?: string } | [];
  };
}

interface TrimmedSearchItem {
  id: number;
  slug: string;
  name: string;
  released: string | null;
  background_image: string | null;
  rating: number;
  genres: string[];
}

/**
 * Projects the raw Steam search shape onto the minimal subset the frontend
 * consumes. Non-Windows-only titles are filtered out because RigReady only
 * evaluates PC (Windows) rigs.
 */
function toTrimmedSearchItems(
  raw: SteamSearchResponse,
): TrimmedSearchItem[] {
  return (raw.items ?? [])
    .filter((item) => !item.platforms || item.platforms.windows !== false)
    .slice(0, MAX_RESULTS)
    .map((item) => ({
      id: item.id,
      slug: String(item.id),
      name: item.name,
      released: null,
      background_image: item.tiny_image ?? null,
      rating: 0,
      genres: [],
    }));
}

function respondUpstreamError(res: Response, err: unknown): Response {
  const message = err instanceof Error ? err.message : "unknown error";
  console.error("[steam]", message);
  return res
    .status(502)
    .json({ error: "steam_upstream_error", code: "UPSTREAM_ERROR" });
}

/**
 * `GET /api/steam/search?q=<term>`
 *
 * Validates the query, forwards to Steam's storesearch, and returns a trimmed
 * result list. The outbound URL is built from a hardcoded host and an
 * encoded, sanitized query, so this endpoint cannot be used for SSRF.
 */
steamRouter.get("/search", async (req: Request, res: Response) => {
  const rawQ = req.query.q;
  const q = typeof rawQ === "string" ? sanitizeQuery(rawQ) : "";

  if (q.length < MIN_QUERY_LEN || q.length > MAX_QUERY_LEN) {
    return res.status(400).json({
      error: "invalid_query",
      message: `Query parameter 'q' must be ${MIN_QUERY_LEN}-${MAX_QUERY_LEN} characters.`,
      code: "INVALID_QUERY",
    });
  }

  const url = `${STEAM_SEARCH_URL}?term=${encodeURIComponent(q)}&cc=us&l=en`;
  try {
    const data = await fetchSteamJson<SteamSearchResponse>(url);
    return res.json({ results: toTrimmedSearchItems(data) });
  } catch (err) {
    return respondUpstreamError(res, err);
  }
});

/**
 * `GET /api/steam/game/:slug`
 *
 * The slug must match a numeric Steam appid to lock down the upstream URL
 * shape; any other input is rejected before a network call is made.
 */
steamRouter.get("/game/:slug", async (req: Request, res: Response) => {
  const slug = req.params.slug?.trim() ?? "";
  if (!NUMERIC_SLUG_PATTERN.test(slug)) {
    return res.status(400).json({
      error: "invalid_slug",
      message: "Slug must be a numeric Steam appid.",
    });
  }

  const url = `${STEAM_DETAILS_URL}?appids=${encodeURIComponent(slug)}&cc=us&l=en`;
  try {
    const raw = await fetchSteamJson<Record<string, SteamDetailsEntry>>(url);
    const entry = raw[slug];
    if (!entry?.success || !entry.data) {
      return res.status(404).json({ error: "not_found" });
    }
    const d = entry.data;
    return res.json({
      slug: String(d.steam_appid),
      name: d.name,
      released: d.release_date?.date ?? null,
      background_image: d.header_image ?? null,
      rating: 0,
      genres: (d.genres ?? []).map((g) => g.description),
      description_raw: d.short_description,
    });
  } catch (err) {
    return respondUpstreamError(res, err);
  }
});
