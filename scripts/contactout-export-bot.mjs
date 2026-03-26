#!/usr/bin/env node
/**
 * Opens people search (United States by default); logs in only if redirected to /login.
 * Scrapes each result page in the browser with the same DOM logic as the ContactOut
 * extension (see scripts/contactout-scrape-dom-eval.js), writes CSVs, then paginates.
 *
 * No Chrome extension required — Playwright evaluates the scrape bundle in-page.
 *
 * Env (see .env):
 *   CONTACTOUT_PASSWORD — login when needed (same for all accounts)
 *   EMAIL_USER — one account; or EMAIL_USER1, EMAIL_USER2, … (same password for all)
 *   EMAIL_USERS — optional comma/newline list alternative to numbered vars
 *   On HTTP 429 with multiple emails, the bot advances to the next email and clears
 *     session (cookies + storage-state when using proxies) before re-login.
 *   CONTACTOUT_LOCATION — default "United States"
 *   CONTACTOUT_SEARCH_URL — optional base URL (location, etc.); `page` is set by the bot
 *   START_PAGE — first `page=` in the URL (default 1)
 *   MAX_PAGES — how many pages to export (default 10). `0` = keep incrementing `page` until a scrape returns 0 rows
 *   EXPORT_DIR — default ./exports
 *   SEARCH_HISTORY_PATH — default ./data/search-history.json (tracks completed pages per search)
 *   IGNORE_SEARCH_HISTORY — set "1" to re-download every page
 *   MERGE_CSV — set "0" to skip writing one combined CSV at the end of a run
 *   STOP_ON_DUPLICATE_PAGE — if not "0"/"false", stop when page N matches page N−1
 *     (ContactOut often repeats the last page forever). Then change SEARCH_KEYWORD /
 *     CONTACTOUT_LOCATI ON / CONTACTOUT_SEARCH_URL and re-run (default: on)
 *   SEARCH_KEYWORDS_PATH — optional JSON (default ./data/search_keywords.json). With SEARCH_PROFILE,
 *     selects presets / saved_searches, or use SEARCH_RANDOM (see below)
 *   SEARCH_PROFILE — id in search_params.presets[] or saved_searches[] (when CONTACTOUT_SEARCH_URL unset)
 *   SEARCH_TITLE — optional title filter added to generated search URLs
 *   SEARCH_GENDER — optional gender filter added to generated search URLs
 *   SEARCH_RANDOM — set "1"/"true" to pick one value per key from search_params.pools (company, job_function,
 *     location, seniority, title, totalYears or total_years, years, login, …); merged with default_extra
 *   SEARCH_RANDOM_SEED — optional integer for reproducible random picks
 *
 *   CLI (npm run export -- <flags>):
 *     --random-search — same as SEARCH_RANDOM=1
 *     --search-profile=id — same as SEARCH_PROFILE
 *     --random-seed=n — same as SEARCH_RANDOM_SEED
 *     -h, --help — print options and exit
 *
 *   CONTACTOUT_SEARCH_URL always wins over profile / random when set.
 *   Merged CSV path: same folder as search history (default ./data/), not EXPORT_DIR
 *   HEADLESS — set "1" or "true" for headless Chromium (optional)
 *
 *   Proxy (optional; uses launch()+context instead of persistent profile):
 *   PROXIES — JSON / bracket list / one URL per line (merged with PROXIES_FILE if both set)
 *   PROXIES_FILE — e.g. ./ref/proxies.txt (Proxifly: one http://ip:port per line). Relative to project root
 *   PROXY_URL — single proxy
 *   PROXY_LIST — comma/newline-separated list. Or PROXY_LIST_FILE = path to .txt
 *   PROXY_ROTATE_EVERY — after N successful page exports, rotate to next proxy (0 = only on 429)
 *   PROXY_429_BACKOFF_MS — wait before retry on HTTP 429 when **no** proxy list (default 60000)
 *   PROXY_429_SLEEP_AFTER_SWAP_MS — optional ms to wait **after** switching proxy on 429 (default 0)
 *   PROXY_FAILOVER_MAX — max proxy switches per navigation on dead proxies or
 *     page.goto TimeoutError (default 50)
 *   PROXY_CLEAR_STORAGE_ON_429 — if not "0"/"false", on HTTP 429 clear cookies + delete
 *     storage-state.json before the next context (default: on)
 *
 *   SOCKS5 + login: Chromium cannot use that natively; we tunnel via proxy-chain
 *   (local HTTP → your socks5://user:pass@…).
 *
 *   PROXY_HEALTH_CHECK — set "0" to skip HTTPS reachability probe through proxy
 *     (ICMP ping cannot use HTTP proxies; we GET a small URL instead)
 *   PROXY_HEALTH_CHECK_URL — default https://www.google.com/generate_204
 *   PROXY_HEALTH_TIMEOUT_MS — default 15000
 *   PROXY_HEALTH_MAX_TRIES — max proxies to try when finding a live one (default min(200, list size))
 */
import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, request as apiRequest } from "playwright";
import ProxyChain from "proxy-chain";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SCRAPE_DOM_EVAL_PATH = path.join(
  __dirname,
  "contactout-scrape-dom-eval.js"
);
const DEFAULT_PROXIES_FILE = path.join(ROOT, "ref", "proxies.txt");

/** Same DOM scrape as `contactout_extension/content.js` (keep in sync with that file). */
let scrapeDomEvalSource = "";

function loadScrapeDomEval() {
  if (!fs.existsSync(SCRAPE_DOM_EVAL_PATH)) {
    throw new Error(`Scrape bundle missing: ${SCRAPE_DOM_EVAL_PATH}`);
  }
  scrapeDomEvalSource = fs.readFileSync(SCRAPE_DOM_EVAL_PATH, "utf8");
}

function toCsvValue(s) {
  const v = String(s ?? "");
  if (/[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function buildCsv(rows) {
  const lines = ["Full Name,Linkedin profile link,Work email domain"];
  for (const r of rows) {
    lines.push(
      `${toCsvValue(r.fullName)},${toCsvValue(r.linkedinUrl)},${toCsvValue(r.workEmailDomain)}`
    );
  }
  return "\uFEFF" + lines.join("\r\n");
}

function sanitizeFilenamePart(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function buildExportNameSuffix() {
  const keyword =
    process.env.SEARCH_KEYWORD?.trim() ||
    process.env.CONTACTOUT_LOCATION?.trim() ||
    "";
  const title = process.env.SEARCH_TITLE?.trim() || "";
  const gender = process.env.SEARCH_GENDER?.trim() || "";
  const parts = [
    sanitizeFilenamePart(keyword),
    sanitizeFilenamePart(title),
    sanitizeFilenamePart(gender),
  ].filter(Boolean);
  return parts.length ? `-${parts.join("-")}` : "";
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

/**
 * EMAIL_USERS (comma/newline), or EMAIL_USER1, EMAIL_USER2, … in numeric order,
 * or a single EMAIL_USER.
 * @returns {string[]}
 */
function parseEmailPoolFromEnv() {
  const rawList = process.env.EMAIL_USERS?.trim();
  if (rawList) {
    return [
      ...new Set(
        rawList
          .split(/[\n,]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      ),
    ];
  }
  const numbered = [];
  for (let i = 1; i <= 50; i++) {
    const v = process.env[`EMAIL_USER${i}`]?.trim();
    if (v) numbered.push({ i, v });
  }
  if (numbered.length) {
    numbered.sort((a, b) => a.i - b.i);
    return [...new Set(numbered.map((x) => x.v))];
  }
  const single = process.env.EMAIL_USER?.trim();
  if (single) return [single];
  return [];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * One proxy line/token: trim, strip `[` `]` / commas from bracket-style lists so
 * `socks5://user:pass@host:port` is parsed correctly (not `http://[socks5://...`).
 */
function cleanProxyToken(x) {
  let s = String(x).trim().replace(/^\uFEFF/, "");
  if (!s) return "";
  while (s.startsWith("[") || s.startsWith(",")) s = s.slice(1).trim();
  while (s.endsWith("]") || s.endsWith(",")) s = s.slice(0, -1).trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

/** Playwright `proxy` option from URL or host:port string. */
function toPlaywrightProxy(raw) {
  let s = cleanProxyToken(raw);
  if (!s) throw new Error("Empty proxy string");
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(s);
  if (!hasScheme) {
    s = `http://${s}`;
  }
  const u = new URL(s);
  if (!u.hostname) throw new Error(`Invalid proxy: ${raw}`);
  const port =
    u.port ||
    (String(u.protocol).startsWith("socks") ? "1080" : "80");
  const server = `${u.protocol}//${u.hostname}:${port}`;
  const out = { server };
  if (u.username) out.username = decodeURIComponent(u.username);
  if (u.password) out.password = decodeURIComponent(u.password);
  return out;
}

/**
 * One block: JSON array, bracket list, or one `http://host:port` (or schemeless) per line.
 */
function parseProxiesRawBlock(raw) {
  if (raw === undefined || !String(raw).trim()) return [];

  const s = String(raw).trim();

  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) {
      return parsed.map((x) => cleanProxyToken(x)).filter(Boolean);
    }
  } catch {
    /* not strict JSON */
  }

  let inner = s;
  if (inner.startsWith("[") && inner.endsWith("]")) {
    inner = inner.slice(1, -1).trim();
  }

  return inner
    .split(/[\n,]+/)
    .map((x) => cleanProxyToken(x))
    .filter(Boolean);
}

/**
 * Proxies from `PROXIES_FILE` (e.g. Proxifly export) and/or `PROXIES` (merged, deduped).
 */
function parseProxiesEnvArray() {
  const blocks = [];
  const pathFile = process.env.PROXIES_FILE?.trim();
  const abs = pathFile
    ? path.isAbsolute(pathFile)
      ? pathFile
      : path.resolve(ROOT, pathFile)
    : DEFAULT_PROXIES_FILE;
  if (fs.existsSync(abs)) {
    blocks.push(fs.readFileSync(abs, "utf8"));
  }
  const env = process.env.PROXIES?.trim();
  if (env) blocks.push(env);

  if (!blocks.length) return [];

  const merged = [];
  for (const b of blocks) {
    merged.push(...parseProxiesRawBlock(b));
  }
  return [...new Set(merged)];
}

function parseProxyLinesFromEnv() {
  const lines = [];
  lines.push(...parseProxiesEnvArray());
  const file = process.env.PROXY_LIST_FILE?.trim();
  if (file && fs.existsSync(file)) {
    lines.push(
      ...fs
        .readFileSync(file, "utf8")
        .split(/\r?\n/)
        .map((l) => cleanProxyToken(l))
    );
  }
  const list = process.env.PROXY_LIST?.trim();
  if (list) {
    lines.push(...list.split(/[\n,]+/).map((s) => cleanProxyToken(s)));
  }
  const single = process.env.PROXY_URL?.trim();
  if (single) lines.push(cleanProxyToken(single));
  return [...new Set(lines.filter(Boolean))];
}

/**
 * @returns {{ servers: object[], rotateEvery: number, index: number, multi: boolean } | null}
 */
function createProxyRotator() {
  const parts = parseProxyLinesFromEnv();
  if (!parts.length) return null;
  const servers = parts.map(toPlaywrightProxy);
  const rawRe = process.env.PROXY_ROTATE_EVERY;
  let rotateEvery = 0;
  if (rawRe !== undefined && String(rawRe).trim() !== "") {
    rotateEvery = parseInt(String(rawRe).trim(), 10);
    if (!Number.isFinite(rotateEvery) || rotateEvery < 0) rotateEvery = 0;
  }
  return {
    servers,
    /** Local `http://127.0.0.1:port` URLs to pass to proxy-chain on shutdown */
    anonymizedLocalUrls: /** @type {string[]} */ ([]),
    rotateEvery,
    index: 0,
    get multi() {
      return this.servers.length > 1;
    },
    current() {
      return this.servers[this.index % this.servers.length];
    },
    advance() {
      const prev = this.index % this.servers.length;
      this.index += 1;
      const next = this.index % this.servers.length;
      console.log(
        `[proxy] Switch ${prev} → ${next} (of ${this.servers.length})`
      );
    },
    peekLabel() {
      const p = this.current();
      try {
        return new URL(p.server).host;
      } catch {
        return p.server;
      }
    },
  };
}

/** Upstream URL for proxy-chain (`socks5://user:pass@host:port`). */
function playwrightProxyToUpstreamUrl(p) {
  const u = new URL(p.server);
  if (p.username) u.username = p.username;
  if (p.password) u.password = p.password;
  return u.toString();
}

const SOCKS_AUTH_RE = /^socks[45]a?:\/\//i;

/**
 * Chromium cannot use SOCKS5 with username/password. We run a local forwarder
 * (proxy-chain) per such endpoint and point Playwright at `http://127.0.0.1:…`.
 */
async function anonymizeSocksAuthProxiesForChromium(rotator) {
  const out = [];
  for (const p of rotator.servers) {
    const needsTunnel =
      SOCKS_AUTH_RE.test(p.server) && !!(p.username || p.password);
    if (needsTunnel) {
      const upstream = playwrightProxyToUpstreamUrl(p);
      const local = await ProxyChain.anonymizeProxy(upstream);
      rotator.anonymizedLocalUrls.push(local);
      out.push({ server: local });
      try {
        const h = new URL(p.server).host;
        console.log(
          `[proxy] Chromium: SOCKS auth not supported; using local forwarder for ${h} → ${local}`
        );
      } catch {
        console.log(`[proxy] SOCKS+auth → local forwarder ${local}`);
      }
    } else {
      out.push(p);
    }
  }
  rotator.servers = out;
}

async function closeProxyChainTunnels(rotator) {
  if (!rotator?.anonymizedLocalUrls?.length) return;
  for (const local of rotator.anonymizedLocalUrls) {
    try {
      await ProxyChain.closeAnonymizedProxy(local, true);
    } catch {
      /* ignore */
    }
  }
  rotator.anonymizedLocalUrls = [];
}

function isProxyHealthCheckDisabled() {
  const v = process.env.PROXY_HEALTH_CHECK;
  return v === "0" || v === "false" || v === "no";
}

function proxyHealthCheckUrl() {
  const u = process.env.PROXY_HEALTH_CHECK_URL?.trim();
  return u || "https://www.google.com/generate_204";
}

function proxyHealthMaxSkips(rotator) {
  const raw = process.env.PROXY_HEALTH_MAX_TRIES;
  let cap =
    raw !== undefined && String(raw).trim() !== ""
      ? parseInt(String(raw).trim(), 10)
      : Math.min(200, rotator.servers.length);
  if (!Number.isFinite(cap) || cap < 1) cap = Math.min(200, rotator.servers.length);
  return Math.min(rotator.servers.length, cap);
}

/**
 * True if an HTTPS request succeeds through this proxy. (Ping to 8.8.8.8 does not
 * traverse HTTP/SOCKS proxies; this is the practical equivalent.)
 */
async function proxyPassesHealthCheck(playwrightProxy) {
  if (isProxyHealthCheckDisabled()) return true;
  const url = proxyHealthCheckUrl();
  const timeout =
    parseInt(process.env.PROXY_HEALTH_TIMEOUT_MS || "15000", 10) || 15000;

  /** @type {import("playwright").APIRequestContext | null} */
  let ctx = null;
  try {
    ctx = await apiRequest.newContext({
      proxy: playwrightProxy,
      timeout,
      ignoreHTTPSErrors:
        process.env.PROXY_HEALTH_IGNORE_TLS === "1" ||
        process.env.PROXY_HEALTH_IGNORE_TLS === "true",
    });
    const res = await ctx.get(url, { timeout });
    return res.ok();
  } catch {
    return false;
  } finally {
    if (ctx) await ctx.dispose().catch(() => {});
  }
}

/**
 * Advance rotator until current proxy passes health check or max skips.
 */
async function skipUntilHealthyProxy(rotator, tag) {
  if (isProxyHealthCheckDisabled()) return;

  const max = proxyHealthMaxSkips(rotator);
  let skipped = 0;

  while (skipped < max) {
    const p = rotator.current();
    const label = rotator.peekLabel?.() || p.server;

    if (await proxyPassesHealthCheck(p)) {
      if (skipped > 0) {
        console.log(
          `[proxy] Reachable after ${skipped} dead (${tag}) → ${label}`
        );
      } else if (tag === "startup") {
        console.log(
          `[proxy] Reachability OK (HTTPS probe ${proxyHealthCheckUrl()}) → ${label}`
        );
      }
      return;
    }

    console.warn(
      `[proxy] Unreachable via ${label} — try next (${skipped + 1}/${max})`
    );
    rotator.advance();
    skipped += 1;
  }

  throw new Error(
    `[proxy] No reachable proxy after ${max} tries (${tag}). Disable with PROXY_HEALTH_CHECK=0 or fix PROXY_HEALTH_CHECK_URL`
  );
}

/** Stable id for a search (same filters → same id, ignores `page`). */
function canonicalSearchKey(baseUrl) {
  const u = new URL(baseUrl, "https://contactout.com");
  u.searchParams.delete("page");
  const keys = [...new Set([...u.searchParams.keys()])].sort();
  const pairs = [];
  for (const k of keys) {
    const vals = u.searchParams.getAll(k).sort();
    for (const v of vals) {
      pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    }
  }
  return `${u.origin}${u.pathname}${pairs.length ? `?${pairs.join("&")}` : ""}`;
}

function searchIdFromBaseUrl(baseUrl) {
  const canon = canonicalSearchKey(baseUrl);
  return crypto.createHash("sha256").update(canon).digest("hex").slice(0, 24);
}

function loadSearchHistory(historyPath) {
  try {
    const raw = fs.readFileSync(historyPath, "utf8");
    const data = JSON.parse(raw);
    if (!data.searches || typeof data.searches !== "object") {
      return { version: 1, searches: {} };
    }
    return data;
  } catch {
    return { version: 1, searches: {} };
  }
}

function saveSearchHistory(historyPath, data) {
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.writeFileSync(historyPath, JSON.stringify(data, null, 2), "utf8");
}

function isPageCompleted(history, searchId, pageNum) {
  const s = history.searches[searchId];
  if (!s?.pagesCompleted) return false;
  return s.pagesCompleted.includes(pageNum);
}

function markPageCompleted(history, searchId, searchBaseUrl, pageNum) {
  if (!history.searches[searchId]) {
    history.searches[searchId] = {
      canonicalBaseUrl: canonicalSearchKey(searchBaseUrl),
      pagesCompleted: [],
      lastUpdated: new Date().toISOString(),
    };
  }
  const entry = history.searches[searchId];
  if (!entry.pagesCompleted.includes(pageNum)) {
    entry.pagesCompleted.push(pageNum);
    entry.pagesCompleted.sort((a, b) => a - b);
  }
  entry.lastUpdated = new Date().toISOString();
}

function dedupeRowsByLinkedin(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = (r.linkedinUrl || "").trim().toLowerCase();
    if (!key) continue;
    if (!map.has(key)) map.set(key, r);
  }
  return [...map.values()].sort((a, b) =>
    (a.fullName || a.linkedinUrl).localeCompare(b.fullName || b.linkedinUrl)
  );
}

/** Stable fingerprint of a result page (detect duplicate pagination: page 101 === page 100). */
function paginationFingerprint(rows) {
  const keys = rows
    .map((r) => {
      const u = (r.linkedinUrl || "").trim().toLowerCase();
      const n = (String(r.fullName || "").trim().toLowerCase());
      const d = (String(r.workEmailDomain || "").trim().toLowerCase());
      return `${u}\t${n}\t${d}`;
    })
    .sort();
  return keys.join("\n");
}

function envStopOnDuplicatePagination() {
  const v = process.env.STOP_ON_DUPLICATE_PAGE;
  if (v === undefined || String(v).trim() === "") return true;
  return v !== "0" && v !== "false" && v !== "no";
}

/** True if URL already sets `location` (e.g. dashboard search). */
function urlHasLocationParam(urlString) {
  try {
    const u = new URL(urlString, "https://contactout.com");
    return u.searchParams.has("location");
  } catch {
    return false;
  }
}

/** Base URL for search; `page` is controlled by the loop (strip any existing `page=`). */
function normalizeSearchBaseUrl(searchUrl) {
  const u = new URL(searchUrl, "https://contactout.com");
  u.searchParams.delete("page");
  return u.toString();
}

function buildSearchUrlWithPage(baseUrl, pageNum) {
  const u = new URL(baseUrl, "https://contactout.com");
  u.searchParams.set("page", String(pageNum));
  return u.toString();
}

/**
 * First `page=` query value (default 1). Use e.g. 4 to resume at
 * ...&page=4
 */
function parseStartPageEnv() {
  const raw = process.env.START_PAGE;
  if (raw === undefined || String(raw).trim() === "") return 1;
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

/**
 * Runs the bundled IIFE in the page context (same output as the extension popup CSV).
 */
async function scrapeCurrentPageRows(page) {
  const code = scrapeDomEvalSource;
  return page.evaluate((src) => {
    return (0, eval)(src);
  }, code);
}

async function inspectSearchPageState(page) {
  return page.evaluate(() => {
    const title = String(document.title || "");
    const bodyText = String(document.body?.innerText || "");
    const combined = `${title}\n${bodyText}`.toLowerCase();
    const hasPasswordInput = Boolean(
      document.querySelector('input[type="password"]')
    );
    const noResults = /no results|0 results|no people found|try adjusting your filters|we couldn'?t find/i.test(
      combined
    );
    const blocked = /too many requests|rate limit|temporarily blocked|unusual traffic|access denied|verify you are human|captcha|security check|request unsuccessful/i.test(
      combined
    );
    return {
      title,
      noResults,
      blocked,
      hasPasswordInput,
    };
  });
}

/**
 * Reads `MAX_PAGES` from `.env`: number of result pages to export (each gets its own `page=` in the URL).
 * Default 10. `0` = keep increasing `page` until a scrape returns no rows.
 */
function parseMaxPagesEnv() {
  const raw = process.env.MAX_PAGES;
  if (raw === undefined || String(raw).trim() === "") return 10;
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 0) return 10;
  return n;
}

/**
 * @param {string} filePath
 * @returns {Record<string, unknown> | null}
 */
function loadSearchKeywordsFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.warn(`[contactout-bot] Invalid JSON in ${filePath}: ${e.message}`);
    return null;
  }
}

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @param {unknown} seedRaw */
function makeRng(seedRaw) {
  if (seedRaw === undefined || seedRaw === null || String(seedRaw).trim() === "") {
    return Math.random;
  }
  let a = parseInt(String(seedRaw), 10);
  if (!Number.isFinite(a)) a = 5381;
  return mulberry32(a >>> 0);
}

function pickRandom(arr, rng) {
  if (!Array.isArray(arr) || arr.length === 0) return undefined;
  const i = Math.min(arr.length - 1, Math.floor(rng() * arr.length));
  return arr[i];
}

function locationFromSearchUrl(urlStr) {
  try {
    const u = new URL(urlStr, "https://contactout.com");
    const loc = u.searchParams.get("location");
    return loc ? loc : "";
  } catch {
    return "";
  }
}

const PRESET_META_KEYS = new Set([
  "id",
  "label",
  "notes",
  "description",
  "role_hint",
  "contactout_search_url",
]);

/** Map JSON / preset field names to ContactOut query keys (e.g. total_years → totalYears). */
function toUrlParamKey(k) {
  if (k === "total_years") return "totalYears";
  return k;
}

/** @param {Record<string, unknown>} obj */
function presetObjectToFlatParams(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (PRESET_META_KEYS.has(k)) continue;
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s === "") continue;
    out[toUrlParamKey(k)] = s;
  }
  return out;
}

/**
 * Build dashboard search URL; strips page= (bot sets it later).
 * @param {Record<string, string>} flatParams
 * @param {string} [baseUrl]
 */
function buildContactOutSearchUrl(flatParams, baseUrl) {
  const base =
    baseUrl && String(baseUrl).trim()
      ? String(baseUrl).trim()
      : "https://contactout.com/dashboard/search";
  const u = new URL(base, "https://contactout.com");
  u.search = "";
  for (const [k, v] of Object.entries(flatParams)) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s === "") continue;
    u.searchParams.set(k, s);
  }
  u.searchParams.delete("page");
  return u.toString();
}

function envTruthy(v) {
  return v === "1" || v === "true" || v === "yes";
}

/**
 * @param {string[]} argv process.argv.slice(2)
 */
function parseCliArgs(argv) {
  const out = {
    /** @type {boolean} */
    help: false,
    /** @type {boolean} */
    randomSearch: false,
    /** @type {string} */
    profile: "",
    /** @type {string|null} */
    randomSeed: null,
  };
  for (const a of argv) {
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--random-search" || a === "--random") out.randomSearch = true;
    else if (a.startsWith("--search-profile="))
      out.profile = a.slice("--search-profile=".length).trim();
    else if (a.startsWith("--random-seed="))
      out.randomSeed = a.slice("--random-seed=".length).trim();
  }
  return out;
}

function printCliHelp() {
  console.log(`contactout-export-bot

Usage:
  node scripts/contactout-export-bot.mjs [options]
  npm run export -- [options]

Options:
  --random-search       Pick random values from search_keywords.json → search_params.pools
  --search-profile=ID   Use search_params.presets[] or saved_searches[] with this id
  --random-seed=N       Reproducible picks (SEARCH_RANDOM_SEED)
  -h, --help            Show this help

Env (when URL not set via CONTACTOUT_SEARCH_URL):
  SEARCH_RANDOM, SEARCH_RANDOM_SEED, SEARCH_PROFILE, SEARCH_KEYWORDS_PATH
`);
}

/** @param {Record<string, unknown>} pools @param {() => number} rng */
function pickRandomParamsFromPools(pools, rng) {
  const out = {};
  if (!pools || typeof pools !== "object") return out;
  for (const [rawKey, values] of Object.entries(pools)) {
    if (!Array.isArray(values) || values.length === 0) continue;
    const key = toUrlParamKey(rawKey);
    const picked = pickRandom(values, rng);
    if (picked === undefined) continue;
    const s = String(picked).trim();
    if (s === "") continue;
    out[key] = s;
  }
  return out;
}

/**
 * When CONTACTOUT_SEARCH_URL is not set, apply SEARCH_PROFILE / SEARCH_RANDOM / pools in search_keywords.json.
 * @returns {{ location: string, searchUrlRaw: string }}
 */
function resolveSearchUrlAndLocation(ROOT, cli) {
  const envUrl = process.env.CONTACTOUT_SEARCH_URL?.trim();
  const envLocation =
    process.env.CONTACTOUT_LOCATION?.trim() ||
    process.env.SEARCH_KEYWORD?.trim();
  const envTitle = process.env.SEARCH_TITLE?.trim();
  const envGender = process.env.SEARCH_GENDER?.trim();
  const defaultLocation = envLocation || "United States";
  const envFlatParams = {
    ...(envLocation ? { location: envLocation } : {}),
    ...(envTitle ? { title: envTitle } : {}),
    ...(envGender ? { gender: envGender } : {}),
  };

  if (envUrl) {
    return {
      location: locationFromSearchUrl(envUrl) || defaultLocation,
      searchUrlRaw: envUrl,
    };
  }

  const kwPath = path.resolve(
    process.env.SEARCH_KEYWORDS_PATH || path.join(ROOT, "data", "search_keywords.json")
  );
  const config = loadSearchKeywordsFile(kwPath) || {};
  const sp = config.search_params && typeof config.search_params === "object"
    ? config.search_params
    : {};
  const baseFromFile =
    typeof sp.base_url === "string" && sp.base_url.trim()
      ? sp.base_url.trim()
      : "https://contactout.com/dashboard/search";
  const defaultExtra =
    sp.default_extra && typeof sp.default_extra === "object" && !Array.isArray(sp.default_extra)
      ? presetObjectToFlatParams(
          /** @type {Record<string, unknown>} */ (sp.default_extra)
        )
      : {};

  const wantRandom =
    Boolean(cli?.randomSearch) ||
    envTruthy(process.env.SEARCH_RANDOM || "");
  const profileCli = (cli?.profile || "").trim();
  const profileEnv = (process.env.SEARCH_PROFILE || "").trim();
  /** CLI `--search-profile=` turns off random for this run; env SEARCH_PROFILE still allows random unless CLI random flag set… see below */
  const useRandom = wantRandom && !profileCli;
  const seed =
    cli?.randomSeed !== null && cli?.randomSeed !== undefined && String(cli.randomSeed).trim() !== ""
      ? cli.randomSeed
      : process.env.SEARCH_RANDOM_SEED;
  const profile = profileCli || profileEnv;

  if (useRandom) {
    const poolObj =
      sp.pools && typeof sp.pools === "object" && !Array.isArray(sp.pools)
        ? sp.pools
        : {};
    const rng = makeRng(seed);
    const picked = pickRandomParamsFromPools(poolObj, rng);
    const merged = { ...defaultExtra, ...picked, ...envFlatParams };
    if (Object.keys(merged).length === 0) {
      console.warn(
        `[contactout-bot] SEARCH_RANDOM on but search_params.pools is empty (${kwPath}); using location fallback.`
      );
    } else {
      const url = buildContactOutSearchUrl(merged, baseFromFile);
      console.log(
        `[contactout-bot] Random search:`,
        JSON.stringify(merged)
      );
      return {
        location: merged.location || defaultLocation,
        searchUrlRaw: url,
      };
    }
  }

  const presets = Array.isArray(sp.presets) ? sp.presets : [];
  if (profile && presets.length) {
    const preset = presets.find(
      (p) => p && typeof p === "object" && p.id === profile
    );
    if (preset) {
      const label = preset.label ? String(preset.label) : profile;
      console.log(`[contactout-bot] SEARCH_PROFILE=${profile} (${label}) [preset]`);
      const urlRaw =
        typeof preset.contactout_search_url === "string"
          ? preset.contactout_search_url.trim()
          : "";
      if (urlRaw) {
        return {
          location:
            (typeof preset.location === "string" && preset.location.trim()) ||
            locationFromSearchUrl(urlRaw) ||
            defaultLocation,
          searchUrlRaw: urlRaw,
        };
      }
      const merged = {
        ...defaultExtra,
        ...presetObjectToFlatParams(
          /** @type {Record<string, unknown>} */ (preset)
        ),
        ...envFlatParams,
      };
      const url = buildContactOutSearchUrl(merged, baseFromFile);
      return {
        location: merged.location || defaultLocation,
        searchUrlRaw: url,
      };
    }
  }

  const saved = Array.isArray(config?.saved_searches) ? config.saved_searches : [];

  if (profile && saved.length) {
    const entry = saved.find((s) => s && typeof s === "object" && s.id === profile);
    if (entry) {
      const label = entry.label ? String(entry.label) : profile;
      console.log(`[contactout-bot] SEARCH_PROFILE=${profile} (${label})`);
      const urlRaw =
        typeof entry.contactout_search_url === "string"
          ? entry.contactout_search_url.trim()
          : "";
      if (urlRaw) {
        return {
          location:
            (typeof entry.location === "string" && entry.location.trim()) ||
            locationFromSearchUrl(urlRaw) ||
            defaultLocation,
          searchUrlRaw: urlRaw,
        };
      }
      if (typeof entry.location === "string" && entry.location.trim()) {
        const loc = entry.location.trim();
        return {
          location: loc,
          searchUrlRaw: `https://contactout.com/dashboard/search?location=${encodeURIComponent(loc)}`,
        };
      }
    } else {
      console.warn(
        `[contactout-bot] SEARCH_PROFILE=${profile} not found in presets/saved_searches (${kwPath}); using location default.`
      );
    }
  } else if (profile) {
    console.warn(
      `[contactout-bot] SEARCH_PROFILE=${profile} set but no matching preset/saved_search in ${kwPath}.`
    );
  }

  return {
    location: defaultLocation,
    searchUrlRaw: buildContactOutSearchUrl(
      {
        location: defaultLocation,
        ...(envTitle ? { title: envTitle } : {}),
        ...(envGender ? { gender: envGender } : {}),
      },
      baseFromFile
    ),
  };
}

function pathnameLooksLikeLogin(urlString) {
  try {
    return new URL(urlString).pathname.toLowerCase().includes("/login");
  } catch {
    return false;
  }
}

function envHeadless() {
  const h = process.env.HEADLESS;
  return h === "1" || h === "true" || h === "yes";
}

async function login(page, email) {
  const password = requireEnv("CONTACTOUT_PASSWORD");
  if (!email || !String(email).trim()) {
    throw new Error("Missing login email");
  }

  if (!pathnameLooksLikeLogin(page.url())) {
    await page.goto("https://contactout.com/login", {
      waitUntil: "domcontentloaded",
    });
  }

  const emailInput = page.locator('input[type="email"], input[name="email"], input#email').first();
  const passInput = page.locator('input[type="password"]').first();
  await emailInput.waitFor({ state: "visible", timeout: 30_000 });
  await emailInput.fill(String(email).trim());
  await passInput.fill(password);

  const submit = page
    .getByRole("button", { name: /^login$/i })
    .or(page.locator('button[type="submit"]'))
    .first();
  await submit.click();

  await page
    .waitForURL(
      (url) =>
        url.hostname.includes("contactout.com") &&
        !url.pathname.toLowerCase().includes("/login"),
      { timeout: 120_000 }
    )
    .catch(() => {});

  await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
}

async function setLocationUnitedStates(page, locationLabel) {
  const loc = locationLabel || "United States";

  const candidates = [
    page.getByPlaceholder(/location|country|region/i),
    page.getByRole("textbox", { name: /location/i }),
    page.getByLabel(/location/i),
    page.locator('input[placeholder*="Location" i]'),
  ];

  let filled = false;
  for (const c of candidates) {
    const n = await c.count().catch(() => 0);
    if (n === 0) continue;
    const first = c.first();
    try {
      await first.click({ timeout: 3_000 });
      await first.fill("");
      await first.fill(loc);
      filled = true;
      await page.keyboard.press("Enter");
      await sleep(1_500);
      break;
    } catch {
      continue;
    }
  }

  if (!filled) {
    console.warn(
      "[contactout-bot] Could not find a location field; set filters manually once, then re-run."
    );
  }

  await page.waitForLoadState("networkidle", { timeout: 45_000 }).catch(() => {});
}

async function main() {
  loadScrapeDomEval();

  const cli = parseCliArgs(process.argv.slice(2));
  if (cli.help) {
    printCliHelp();
    return;
  }

  const userDataDir = path.join(ROOT, "playwright-user-data");
  const exportDir = path.resolve(
    process.env.EXPORT_DIR || path.join(ROOT, "exports")
  );
  fs.mkdirSync(exportDir, { recursive: true });

  const { location, searchUrlRaw } = resolveSearchUrlAndLocation(ROOT, cli);
  const searchBaseUrl = normalizeSearchBaseUrl(searchUrlRaw);
  const searchId = searchIdFromBaseUrl(searchBaseUrl);
  const exportNameSuffix = buildExportNameSuffix();
  const startPage = parseStartPageEnv();
  const maxPages = parseMaxPagesEnv();
  const unlimitedPages = maxPages === 0;

  const historyPath = path.resolve(
    process.env.SEARCH_HISTORY_PATH || path.join(ROOT, "data", "search-history.json")
  );
  const dataDir = path.dirname(historyPath);
  fs.mkdirSync(dataDir, { recursive: true });

  const ignoreSearchHistory =
    process.env.IGNORE_SEARCH_HISTORY === "1" ||
    process.env.IGNORE_SEARCH_HISTORY === "true";
  const mergeCsv =
    process.env.MERGE_CSV !== "0" && process.env.MERGE_CSV !== "false";

  const emailPool = parseEmailPoolFromEnv();
  if (!emailPool.length) {
    throw new Error(
      "No login email: set EMAIL_USER, EMAIL_USERS, or EMAIL_USER1, EMAIL_USER2, …"
    );
  }
  let emailIndex = 0;
  const currentEmail = () => emailPool[emailIndex % emailPool.length];
  if (emailPool.length > 1) {
    console.log(
      `[auth] ${emailPool.length} accounts (same password); on HTTP 429 the next email is used`
    );
  }

  let history = loadSearchHistory(historyPath);
  const rowsForMerge = [];

  const rotator = createProxyRotator();
  const storageStatePath = path.join(userDataDir, "storage-state.json");
  fs.mkdirSync(userDataDir, { recursive: true });
  const backoff429 =
    parseInt(process.env.PROXY_429_BACKOFF_MS || "60000", 10) || 60000;
  const emptyPageRetryMax = Math.max(
    0,
    parseInt(process.env.EMPTY_PAGE_RETRY_MAX || "2", 10) || 2
  );

  if (rotator) {
    await anonymizeSocksAuthProxiesForChromium(rotator);
  }

  let browser = null;
  /** @type {import("playwright").BrowserContext} */
  let context;
  /** @type {import("playwright").Page} */
  let page;

  if (rotator) {
    browser = await chromium.launch({ headless: envHeadless() });
    await skipUntilHealthyProxy(rotator, "startup");
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      proxy: rotator.current(),
      ...(fs.existsSync(storageStatePath)
        ? { storageState: storageStatePath }
        : {}),
    });
    page = await context.newPage();
    console.log(
      `[proxy] ${rotator.servers.length} endpoint(s); first: ${rotator.peekLabel()}; rotate every ${rotator.rotateEvery || "429 only"} exports`
    );
  } else {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: envHeadless(),
      viewport: { width: 1280, height: 800 },
    });
    page = context.pages()[0] || (await context.newPage());
  }

  let pagesSinceRotate = 0;

  async function persistSession() {
    if (!rotator || !context) return;
    try {
      await context.storageState({ path: storageStatePath });
    } catch {
      /* ignore */
    }
  }

  function envClearSessionOn429() {
    const v = process.env.PROXY_CLEAR_STORAGE_ON_429;
    if (v === undefined || String(v).trim() === "") return true;
    return v !== "0" && v !== "false" && v !== "no";
  }

  /**
   * @param {string} reason
   * @param {{ clearSession?: boolean }} [options] If clearSession, drop saved storage + cookies so the next context is clean (rate-limit / 429).
   */
  async function recreateProxyContext(reason, options = {}) {
    const clearSession = Boolean(options.clearSession);
    if (!rotator || !browser) return;

    try {
      if (clearSession) {
        await context.clearCookies();
        console.log("[proxy] Cleared browser context cookies (fresh session).");
      }
    } catch {
      /* ignore */
    }

    if (!clearSession) {
      await persistSession();
    } else {
      try {
        if (fs.existsSync(storageStatePath)) {
          fs.unlinkSync(storageStatePath);
          console.log(
            "[proxy] Deleted saved storage-state (no stale cookies after 429)."
          );
        }
      } catch {
        /* ignore */
      }
    }

    await context.close();
    rotator.advance();
    await skipUntilHealthyProxy(rotator, reason);

    const useSavedState = !clearSession && fs.existsSync(storageStatePath);
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      proxy: rotator.current(),
      storageState: useSavedState ? storageStatePath : undefined,
    });
    page = await context.newPage();
    console.log(
      `[proxy] New browser context (${reason}) → ${rotator.peekLabel()}`
    );
  }

  /** Free / bad proxies often cause these; rotate and retry. */
  function isProxyTunnelFailError(err) {
    const m = String(err?.message || err || "");
    return /net::ERR_EMPTY_RESPONSE|net::ERR_CONNECTION_CLOSED|net::ERR_CONNECTION_RESET|net::ERR_TUNNEL_CONNECTION_FAILED|net::ERR_PROXY_CONNECTION_FAILED|net::ERR_TIMED_OUT|net::ERR_NAME_NOT_RESOLVED|net::ERR_ADDRESS_UNREACHABLE|net::ERR_INTERNET_DISCONNECTED|net::ERR_ABORTED|net::ERR_SSL_PROTOCOL_ERROR|net::ERR_CERT_COMMON_NAME_INVALID|Navigation failed|Target page, context or browser has been closed/i.test(
      m
    );
  }

  /** Slow or stuck proxies: domcontentloaded never fires in time. */
  function isNavigationTimeoutError(err) {
    const name = String(err?.name || "");
    if (name === "TimeoutError") return true;
    const m = String(err?.message || err || "");
    return /Timeout \d+ms exceeded/i.test(m);
  }

  const proxyFailoverCap = rotator
    ? Math.min(
        rotator.servers.length,
        Math.max(
          1,
          parseInt(process.env.PROXY_FAILOVER_MAX || "50", 10) || 50
        )
      )
    : 0;

  async function gotoWith429Retry(targetUrl, label = "nav") {
    const max429 = 6;
    let failoversForThisNav = 0;

    for (let round = 0; round < max429; round++) {
      let resp = null;

      while (resp === null) {
        try {
          resp = await page.goto(targetUrl, {
            waitUntil: "domcontentloaded",
          });
        } catch (e) {
          const tunnelFail =
            rotator &&
            failoversForThisNav < proxyFailoverCap &&
            isProxyTunnelFailError(e);
          const navTimeout =
            rotator &&
            failoversForThisNav < proxyFailoverCap &&
            isNavigationTimeoutError(e);
          if (tunnelFail || navTimeout) {
            failoversForThisNav += 1;
            const oneLine = String(e.message || e).split("\n")[0].slice(0, 140);
            const reason = navTimeout && !tunnelFail ? "navigation timeout" : "dead or blocked proxy";
            console.warn(
              `[proxy] ${label}: ${oneLine} — ${reason}, failover ${failoversForThisNav}/${proxyFailoverCap}`
            );
            await recreateProxyContext(reason);
            continue;
          }
          throw e;
        }
      }

      const st = resp?.status();
      if (st === 429) {
        console.warn(
          `[contactout-bot] HTTP 429 on ${label} (round ${round + 1}/${max429}) — switch proxy, new context (no retry on same IP)`
        );
        const multiAccount = emailPool.length > 1;
        if (multiAccount) {
          emailIndex = (emailIndex + 1) % emailPool.length;
          console.log(
            `[auth] 429: next account ${emailIndex + 1}/${emailPool.length} → ${currentEmail()}`
          );
        }
        const clearOn429 = envClearSessionOn429() || multiAccount;
        if (rotator) {
          await recreateProxyContext("HTTP 429", {
            clearSession: clearOn429,
          });
          const afterSwap = parseInt(
            process.env.PROXY_429_SLEEP_AFTER_SWAP_MS || "0",
            10
          );
          if (Number.isFinite(afterSwap) && afterSwap > 0) {
            await sleep(afterSwap);
          }
        } else {
          if (multiAccount) {
            try {
              await context.clearCookies();
              console.log("[auth] Cleared cookies (429, next account).");
            } catch {
              /* ignore */
            }
          }
          await sleep(backoff429);
        }
        continue;
      }

      await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
      return resp;
    }

    throw new Error(`Too many HTTP 429 responses (${label})`);
  }

  try {
    const firstUrl = buildSearchUrlWithPage(searchBaseUrl, startPage);
    await gotoWith429Retry(firstUrl, "first search page");

    if (pathnameLooksLikeLogin(page.url())) {
      console.log("[contactout-bot] Not logged in; signing in…");
      await login(page, currentEmail());
      await gotoWith429Retry(firstUrl, "after login");
    } else {
      console.log("[contactout-bot] Already logged in; continuing with search.");
    }

    if (rotator) await persistSession();

    if (!urlHasLocationParam(searchBaseUrl)) {
      await setLocationUnitedStates(page, location);
      if (rotator) await persistSession();
    }

    const gotoSearchPage = async (pageNum) => {
      const urlThis = buildSearchUrlWithPage(searchBaseUrl, pageNum);
      await gotoWith429Retry(urlThis, `result page=${pageNum}`);
      if (pathnameLooksLikeLogin(page.url())) {
        console.log(
          "[contactout-bot] On login page (e.g. after 429 session reset); signing in again…"
        );
        await login(page, currentEmail());
        await gotoWith429Retry(urlThis, `after re-login page=${pageNum}`);
        if (rotator) await persistSession();
      }
    };

    let lastPaginationFingerprint = "";

    const exportPageToCsv = (pageNum, urlThis, rows) => {
      const csv = buildCsv(rows);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const outPath = path.join(
        exportDir,
        `contactout-page-${String(pageNum).padStart(4, "0")}${exportNameSuffix}-${stamp}.csv`
      );
      fs.writeFileSync(outPath, csv, "utf8");
      console.log(
        `[contactout-bot] URL page=${pageNum} (${urlThis}): wrote ${rows.length} row(s) -> ${outPath}`
      );
      return outPath;
    };

    const processPage = async (pageNum) => {
      const urlThis = buildSearchUrlWithPage(searchBaseUrl, pageNum);
      if (!ignoreSearchHistory && isPageCompleted(history, searchId, pageNum)) {
        console.log(
          `[contactout-bot] Skip page ${pageNum} (already in search history: ${path.basename(historyPath)}).`
        );
        return;
      }
      for (let attempt = 0; attempt <= emptyPageRetryMax; attempt++) {
        await gotoSearchPage(pageNum);
        await sleep(2_000);

        const rows = await scrapeCurrentPageRows(page);
        if (rows.length === 0) {
          const pageState = await inspectSearchPageState(page);
          const looksLikeLogin =
            pathnameLooksLikeLogin(page.url()) || pageState.hasPasswordInput;
          const suspiciousEmpty = pageState.blocked || looksLikeLogin || !pageState.noResults;

          if (suspiciousEmpty && attempt < emptyPageRetryMax) {
            console.warn(
              `[contactout-bot] Page ${pageNum} returned 0 rows but looks blocked/incomplete; retry ${attempt + 1}/${emptyPageRetryMax}.`
            );
            if (rotator) {
              await recreateProxyContext(
                pageState.blocked || looksLikeLogin
                  ? "blocked/empty result page"
                  : "empty/incomplete result page",
                { clearSession: pageState.blocked || looksLikeLogin }
              );
            } else {
              await sleep(backoff429);
            }
            continue;
          }

          return { empty: true, rows };
        }

        const fp = paginationFingerprint(rows);
        if (
          envStopOnDuplicatePagination() &&
          lastPaginationFingerprint &&
          fp === lastPaginationFingerprint
        ) {
          console.warn(
            `[contactout-bot] Page ${pageNum} is identical to the previous page (pagination stuck). ` +
              `Not writing CSV. Update SEARCH_KEYWORD, CONTACTOUT_LOCATION, SEARCH_PROFILE / --random-search (search_keywords.json), or CONTACTOUT_SEARCH_URL / filters for a new slice of results, then re-run (or set STOP_ON_DUPLICATE_PAGE=0 to ignore).`
          );
          return { duplicate: true, rows };
        }
        lastPaginationFingerprint = fp;

        exportPageToCsv(pageNum, urlThis, rows);
        rowsForMerge.push(...rows);
        if (!ignoreSearchHistory) {
          markPageCompleted(history, searchId, searchBaseUrl, pageNum);
          saveSearchHistory(historyPath, history);
        }
        if (
          rotator &&
          rotator.multi &&
          rotator.rotateEvery > 0
        ) {
          pagesSinceRotate += 1;
          if (pagesSinceRotate >= rotator.rotateEvery) {
            pagesSinceRotate = 0;
            await persistSession();
            await recreateProxyContext(
              `PROXY_ROTATE_EVERY=${rotator.rotateEvery} pages`
            );
          }
        }
        return { empty: false, rows };
      }
      return { empty: true, rows: [] };
    };

    if (unlimitedPages) {
      for (let pageNum = startPage; ; pageNum++) {
        const res = await processPage(pageNum);
        if (res == null) continue;
        if (res.empty) {
          console.log(
            `[contactout-bot] No rows on URL page=${pageNum}; stopping (MAX_PAGES=0).`
          );
          break;
        }
        if (res.duplicate) break;
      }
    } else {
      for (let i = 0; i < maxPages; i++) {
        const pageNum = startPage + i;
        const res = await processPage(pageNum);
        if (res == null) continue;
        if (res.empty) {
          console.log(
            `[contactout-bot] No rows on URL page=${pageNum}; stopping.`
          );
          break;
        }
        if (res.duplicate) break;
      }
      console.log(`[contactout-bot] Finished page range (MAX_PAGES=${maxPages}).`);
    }

    if (mergeCsv && rowsForMerge.length > 0) {
      const merged = dedupeRowsByLinkedin(rowsForMerge);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const mergedPath = path.join(
        dataDir,
        `contactout-merged-${searchId.slice(0, 8)}${exportNameSuffix}-${stamp}.csv`
      );
      fs.writeFileSync(mergedPath, buildCsv(merged), "utf8");
      console.log(
        `[contactout-bot] Merged ${rowsForMerge.length} row(s) from this run → ${merged.length} unique → ${mergedPath}`
      );
    } else if (mergeCsv) {
      console.log(
        "[contactout-bot] No new rows this run; merged CSV not written."
      );
    }
  } finally {
    if (rotator) {
      await persistSession().catch(() => {});
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
      await closeProxyChainTunnels(rotator);
    } else {
      await context.close().catch(() => {});
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
