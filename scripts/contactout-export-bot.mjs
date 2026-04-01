#!/usr/bin/env node
/**
 * Opens people search (United States by default); logs in only if redirected to /login.
 * Scrapes each result page in the browser with the same DOM logic as the ContactOut
 * extension (see scripts/contactout-scrape-dom-eval.js), writes JSON files, then paginates.
 *
 * No Chrome extension required — Playwright evaluates the scrape bundle in-page.
 *
 * Env (see .env):
 *   Account config — default ./ref/emails.js exporting EMAIL_USER_LIST and
 *     CONTACTOUT_PASSWORD (shared password for all accounts)
 *   CONTACTOUT_PASSWORD — fallback when account config file is absent
 *   EMAIL_USER — fallback one account; or EMAIL_USER1, EMAIL_USER2, … (same password for all)
 *   EMAIL_USERS — fallback comma/newline list alternative to numbered vars
 *   On HTTP 429 with multiple emails, the bot advances to the next email and clears
 *     session (cookies + storage-state when using proxies) before re-login.
 *   SEARCH_COUNTRY_LIST — country/location filters for generated searches
 *   CONTACTOUT_LOCATION — optional explicit location override
 *   CONTACTOUT_SEARCH_URL — optional base URL (location, etc.); `page` is set by the bot
 *   START_PAGE — first `page=` in the URL (default 1)
 *   MAX_PAGES — how many pages to export (default 10). `0` = keep incrementing `page` until a scrape returns 0 rows
 *   EXPORT_DIR — default ./exports
 *   SEARCH_HISTORY_PATH — default ./ref/search-history.json (tracks completed pages per search)
 *   IGNORE_SEARCH_HISTORY — set "1" to re-download every page
 *   MERGE_JSON — set "0" to skip writing one combined JSON file at the end of a run
 *   MERGE_CSV — legacy alias for MERGE_JSON
 *   STOP_ON_DUPLICATE_PAGE — if not "0"/"false", stop when page N matches page N−1
 *     (ContactOut often repeats the last page forever). Then change SEARCH_COUNTRY_LIST /
 *     CONTACTOUT_LOCATI ON / CONTACTOUT_SEARCH_URL and re-run (default: on)
 *   SEARCH_KEYWORDS_PATH — optional JSON (default ./data/search_keywords.json). With SEARCH_PROFILE,
 *     selects presets / saved_searches, or use SEARCH_RANDOM (see below)
 *   SEARCH_PROFILE — id in search_params.presets[] or saved_searches[] (when CONTACTOUT_SEARCH_URL unset)
 *   SEARCH_ROLE_LIST — optional role/title filters added to generated search URLs
 *   SEARCH_GENDER — optional gender filter added to generated search URLs
 *   SEARCH_GENDER_LIST — optional JSON / bracket list / comma/newline list of genders;
 *     runs one search per gender and merges all rows into one final JSON
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
 *   Merged JSON path: same folder as search history (default ./data/), not EXPORT_DIR
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
 *   PROXY_EXHAUSTED_RETRY_MS — when no healthy proxy is currently available, wait this long
 *     before retrying if no proxy cooldown is known (default 60000)
 *   PROXY_EXHAUSTED_MAX_WAIT_MS — optional total cap for waiting on proxy recovery; 0 = wait forever
 */
import "dotenv/config";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, request as apiRequest } from "playwright";
import ProxyChain from "proxy-chain";
import {
  maybeRefreshProxyFileFromLocalList,
  validateProxyLines,
} from "./proxyUtils.js";
import {
  EMAILS_CONFIG_PATH,
  LEGACY_PROXIES_FILE_PATH,
  loadEmailConfig,
  loadProxyConfig,
  normalizeWorkerSlot,
  workerSlotLabel,
  saveEmailPoolToConfigFile as persistEmailPoolToConfigFile,
} from "./workerConfig.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SCRAPE_DOM_EVAL_PATH = path.join(
  __dirname,
  "contactout-scrape-dom-eval.js"
);
const CONSTANTS_CONFIG_PATH = path.join(ROOT, "ref", "constants.js");
const DEFAULT_PROXIES_FILE = LEGACY_PROXIES_FILE_PATH;

/** Same DOM scrape as `contactout_extension/content.js` (keep in sync with that file). */
let scrapeDomEvalSource = "";

function loadScrapeDomEval() {
  if (!fs.existsSync(SCRAPE_DOM_EVAL_PATH)) {
    throw new Error(`Scrape bundle missing: ${SCRAPE_DOM_EVAL_PATH}`);
  }
  scrapeDomEvalSource = fs.readFileSync(SCRAPE_DOM_EVAL_PATH, "utf8");
}

async function loadConstantsConfigToEnv() {
  if (!fs.existsSync(CONSTANTS_CONFIG_PATH)) return;
  const mod = await import(pathToFileURL(CONSTANTS_CONFIG_PATH).href);
  const config =
    mod?.default && typeof mod.default === "object" ? mod.default : {};
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined || value === null) continue;
    process.env[key] =
      typeof value === "string" ? value : JSON.stringify(value);
  }
}

function buildJson(rows, options = {}) {
  return JSON.stringify(rows.map((row) => mapExportRow(row, options)), null, 2) + "\n";
}

function parseJsonArrayEnv(name) {
  const raw = process.env[name]?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item).trim()).filter(Boolean);
    }
  } catch {
    /* fall through */
  }
  return raw
    .split(/[\n,]+/)
    .map((item) => String(item).trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function splitNameFirstLast(fullName) {
  const tokens = String(fullName || "")
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/^[^A-Za-z]+|[^A-Za-z'-]+$/g, ""))
    .filter(Boolean);
  if (tokens.length < 2) return null;
  return {
    firstName: tokens[0],
    lastName: tokens[tokens.length - 1],
  };
}

function domainFromWebsite(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.hostname.replace(/^www\./i, "").trim().toLowerCase();
  } catch {
    return raw.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[/?#]/)[0].trim().toLowerCase();
  }
}

function toFiniteConfidence(value) {
  const n = typeof value === "number" ? value : parseFloat(String(value || "").trim());
  return Number.isFinite(n) ? n : -1;
}

function pickBestEmailFinderCandidate(payload) {
  const data = payload?.payload?.data;
  if (!data || typeof data !== "object") return null;

  const candidates = [];
  if (data.address) {
    candidates.push({
      address: String(data.address).trim(),
      confidence: toFiniteConfidence(data.confidence),
      source: "address",
    });
  }
  if (Array.isArray(data.relatedEmails)) {
    for (const item of data.relatedEmails) {
      const address = String(item?.address || "").trim();
      if (!address) continue;
      candidates.push({
        address,
        confidence: toFiniteConfidence(item?.confidence),
        source: "relatedEmails",
      });
    }
  }
  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (a.source !== b.source) return a.source === "address" ? -1 : 1;
    return a.address.localeCompare(b.address);
  });
  return candidates[0];
}

async function mapWithConcurrency(items, limit, mapper) {
  const out = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length || 1));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      out[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

function getSearchRoleValue(override = "") {
  const roleList = parseSearchRoleListEnv();
  return String(override || roleList[0] || "").trim();
}

function getSearchCountryValue(override = "") {
  const countryList = parseSearchCountryListEnv();
  return String(
    override ||
      countryList[0] ||
      process.env.CONTACTOUT_LOCATION ||
      ""
  ).trim();
}

function mapExportRow(row, options = {}) {
  const business = String(row?.business || "").trim();
  const fullName = String(row?.fullName || "").trim();
  const linkedin = String(row?.linkedinUrl || "").trim();
  const location = String(row?.location || "").trim();
  const workEmailDomain = String(row?.workEmailDomain || "").trim();
  const email = String(row?.email || "").trim();
  const facebook = String(row?.facebookUrl || "").trim();
  const website = workEmailDomain
    ? /^https?:\/\//i.test(workEmailDomain)
      ? workEmailDomain
      : `https://${workEmailDomain}`
    : "";
  const role = String(
    row?.role || options.searchRole || getSearchRoleValue()
  ).trim();
  return {
    business,
    full_name: fullName,
    email,
    linkedin,
    location,
    website,
    role,
    socials: {
      linkedin,
      ...(facebook ? { facebook } : {}),
    },
  };
}

function sanitizeFilenamePart(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function parseSearchGenderListEnv() {
  const raw = process.env.SEARCH_GENDER_LIST?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return [...new Set(parsed.map((s) => String(s).trim()).filter(Boolean))];
    }
  } catch {
    /* fall through */
  }
  return [
    ...new Set(
      raw
        .split(/[\n,]+/)
        .map((s) => String(s).trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean)
    ),
  ];
}

function parseSearchRoleListEnv() {
  const raw = process.env.SEARCH_ROLE_LIST?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return [...new Set(parsed.map((s) => String(s).trim()).filter(Boolean))];
    }
  } catch {
    /* fall through */
  }
  return [
    ...new Set(
      raw
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    ),
  ];
}

function parseSearchCountryListEnv() {
  const raw = process.env.SEARCH_COUNTRY_LIST?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return [...new Set(parsed.map((s) => String(s).trim()).filter(Boolean))];
    }
  } catch {
    /* fall through */
  }
  return [
    ...new Set(
      raw
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    ),
  ];
}

function parseSearchYearsListEnv() {
  const raw = process.env.SEARCH_YEARS?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return [...new Set(parsed.map((s) => String(s).trim()).filter(Boolean))];
    }
  } catch {
    /* fall through */
  }
  return [
    ...new Set(
      raw
        .split(/[\n,]+/)
        .map((s) => String(s).trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean)
    ),
  ];
}

function parseSearchTotalYearsListEnv() {
  const raw = process.env.SEARCH_TOTALYEARS?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return [...new Set(parsed.map((s) => String(s).trim()).filter(Boolean))];
    }
  } catch {
    /* fall through */
  }
  return [
    ...new Set(
      raw
        .split(/[\n,]+/)
        .map((s) => String(s).trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean)
    ),
  ];
}

function parseSearchEmployeeSizeListEnv() {
  const raw = process.env.SEARCH_EMPLOYEE_SIZE?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return [...new Set(parsed.map((s) => String(s).trim()).filter(Boolean))];
    }
  } catch {
    /* fall through */
  }
  return [
    ...new Set(
      raw
        .split(/[\n,]+/)
        .map((s) => String(s).trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean)
    ),
  ];
}

function parseSearchRevenueRangesEnv() {
  const raw = process.env.SEARCH_REVENUE?.trim();
  if (!raw) return [];

  const parseArray = (text) => {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === "object" && !Array.isArray(item))
      .map((item) => ({
        revenueMin:
          item.revenue_min === undefined || item.revenue_min === null
            ? ""
            : String(item.revenue_min).trim(),
        revenueMax:
          item.revenue_max === undefined || item.revenue_max === null
            ? ""
            : String(item.revenue_max).trim(),
      }))
      .filter((item) => item.revenueMin || item.revenueMax);
  };

  try {
    return parseArray(raw);
  } catch {
    /* fall through */
  }

  try {
    const normalized = raw.replace(
      /([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g,
      '$1"$2"$3'
    );
    return parseArray(normalized);
  } catch {
    return [];
  }
}

function parseSearchIndustryListEnv() {
  const raw = process.env.SEARCH_INDUSTRY?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return [...new Set(parsed.map((s) => String(s).trim()).filter(Boolean))];
    }
  } catch {
    /* fall through */
  }
  return [
    ...new Set(
      raw
        .split(/[\n,]+/)
        .map((s) => String(s).trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean)
    ),
  ];
}

function parseJsonMergeCountEnv() {
  const raw = process.env.JSON_MERGE_COUNT;
  if (raw === undefined || String(raw).trim() === "") return 0;
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 1) return 0;
  return n;
}

function normalizeGenderValue(value) {
  return String(value ?? "").trim().toLowerCase();
}

function buildExportNameSuffix(options = {}) {
  const keyword = getSearchCountryValue(options.country);
  const title = getSearchRoleValue(options.role);
  const gender =
    options.gender !== undefined
      ? normalizeGenderValue(options.gender || "")
      : normalizeGenderValue(process.env.SEARCH_GENDER?.trim() || "");
  const years =
    options.years !== undefined ? String(options.years || "").trim() : "";
  const totalYears =
    options.totalYears !== undefined
      ? String(options.totalYears || "").trim()
      : "";
  const employeeSize =
    options.employeeSize !== undefined
      ? String(options.employeeSize || "").trim()
      : "";
  const revenueMin =
    options.revenueMin !== undefined
      ? String(options.revenueMin || "").trim()
      : "";
  const revenueMax =
    options.revenueMax !== undefined
      ? String(options.revenueMax || "").trim()
      : "";
  const industry =
    options.industry !== undefined ? String(options.industry || "").trim() : "";
  const revenueLabel = revenueMin || revenueMax
    ? `revenue-${revenueMin || "min"}-${revenueMax || "plus"}`
    : "";
  const parts = [
    sanitizeFilenamePart(keyword),
    sanitizeFilenamePart(title),
    sanitizeFilenamePart(gender),
    sanitizeFilenamePart(years ? `years-${years}` : ""),
    sanitizeFilenamePart(totalYears ? `totalyears-${totalYears}` : ""),
    sanitizeFilenamePart(employeeSize ? `employee-size-${employeeSize}` : ""),
    sanitizeFilenamePart(revenueLabel),
    sanitizeFilenamePart(industry ? `industry-${industry}` : ""),
  ].filter(Boolean);
  return parts.length ? `-${parts.join("-")}` : "";
}

function buildExportFolderParts(options = {}) {
  const keyword = getSearchCountryValue(options.country);
  const title = getSearchRoleValue(options.role);
  const gender =
    options.gender !== undefined
      ? normalizeGenderValue(options.gender || "")
      : normalizeGenderValue(process.env.SEARCH_GENDER?.trim() || "");
  const years =
    options.years !== undefined ? String(options.years || "").trim() : "";
  const totalYears =
    options.totalYears !== undefined
      ? String(options.totalYears || "").trim()
      : "";
  const employeeSize =
    options.employeeSize !== undefined
      ? String(options.employeeSize || "").trim()
      : "";
  const revenueMin =
    options.revenueMin !== undefined
      ? String(options.revenueMin || "").trim()
      : "";
  const revenueMax =
    options.revenueMax !== undefined
      ? String(options.revenueMax || "").trim()
      : "";
  const industry =
    options.industry !== undefined ? String(options.industry || "").trim() : "";
  const revenueFolder =
    revenueMin || revenueMax
      ? `${revenueMin || "min"}-${revenueMax || "plus"}`
      : "";
  return [
    sanitizeFilenamePart(keyword),
    sanitizeFilenamePart(title),
    sanitizeFilenamePart(gender),
    sanitizeFilenamePart(years),
    sanitizeFilenamePart(totalYears),
    sanitizeFilenamePart(employeeSize),
    sanitizeFilenamePart(revenueFolder),
    sanitizeFilenamePart(industry),
  ].filter(Boolean);
}

function isEnvFalse(name) {
  const value = process.env[name];
  return value === "0" || value === "false";
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

async function loadAccountsConfig(options = {}) {
  const workerSlot = normalizeWorkerSlot(
    options.workerSlot ?? process.env.CONTACTOUT_WORKER_SLOT
  );
  if (fs.existsSync(EMAILS_CONFIG_PATH)) {
    const config = await loadEmailConfig({
      fresh: Boolean(options.fresh),
      workerSlot,
    });
    const emailPool = [...new Set(config.emailPool.map((s) => String(s).trim()).filter(Boolean))];
    const password = String(config.password || "").trim();
    if (!emailPool.length) {
      throw new Error(
        `Account config file is missing login emails${workerSlot ? ` for worker slot ${workerSlot}` : ""}: ${EMAILS_CONFIG_PATH}`
      );
    }
    if (!password) {
      throw new Error(
        `Account config file is missing CONTACTOUT_PASSWORD: ${EMAILS_CONFIG_PATH}`
      );
    }
    return {
      emailPool,
      password,
      source: EMAILS_CONFIG_PATH,
      workerSlot,
      bindingName: config.bindingName,
    };
  }

  const emailPool = parseEmailPoolFromEnv();
  const password = process.env.CONTACTOUT_PASSWORD?.trim() || "";
  if (!emailPool.length) {
    throw new Error(
      `No login email: create ${EMAILS_CONFIG_PATH} or set EMAIL_USER, EMAIL_USERS, or EMAIL_USER1, EMAIL_USER2, …`
    );
  }
  if (!password) {
    throw new Error(
      `No login password: create ${EMAILS_CONFIG_PATH} or set CONTACTOUT_PASSWORD`
    );
  }
  return {
    emailPool,
    password,
    source: "environment variables",
    workerSlot,
    bindingName: "EMAIL_USER_LIST",
  };
}

function saveEmailPoolToConfigFile(emailPool, options = {}) {
  persistEmailPoolToConfigFile(emailPool, {
    workerSlot: options.workerSlot,
    bindingName: options.bindingName,
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseIntWithFloor(raw, fallback, floor = 0) {
  const n = parseInt(String(raw ?? "").trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(floor, n);
}

function envInt(name, fallback, floor = 0) {
  return parseIntWithFloor(process.env[name], fallback, floor);
}

function randomIntBetween(min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

async function sleepRandom(minMs, maxMs) {
  const delay = randomIntBetween(minMs, maxMs);
  if (delay > 0) {
    await sleep(delay);
  }
}

function formatDuration(ms) {
  const totalMs = Math.max(0, Math.floor(ms));
  const totalSeconds = Math.ceil(totalMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
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
async function parseProxiesEnvArray() {
  const blocks = [];
  const workerSlot = normalizeWorkerSlot(process.env.CONTACTOUT_WORKER_SLOT);
  const pathFile = process.env.PROXIES_FILE?.trim();
  const abs = pathFile
    ? path.isAbsolute(pathFile)
      ? pathFile
      : path.resolve(ROOT, pathFile)
    : DEFAULT_PROXIES_FILE;
  if (fs.existsSync(abs)) {
    blocks.push(fs.readFileSync(abs, "utf8"));
  }
  const proxyConfig = await loadProxyConfig({
    fresh: true,
    workerSlot,
  });
  if (proxyConfig.proxyLines.length) {
    blocks.push(JSON.stringify(proxyConfig.proxyLines));
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

async function parseProxyLinesFromEnv() {
  const lines = [];
  const validatedOnly = envTruthy(
    String(process.env.CONTACTOUT_VALIDATED_PROXY_LIST || "").trim().toLowerCase()
  );
  if (!validatedOnly) {
    lines.push(...(await parseProxiesEnvArray()));
  }
  const file = process.env.PROXY_LIST_FILE?.trim();
  const resolvedFile = file
    ? path.isAbsolute(file)
      ? file
      : path.resolve(ROOT, file)
    : "";
  if (resolvedFile && fs.existsSync(resolvedFile)) {
    lines.push(
      ...fs
        .readFileSync(resolvedFile, "utf8")
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
async function createProxyRotator() {
  const parts = await parseProxyLinesFromEnv();
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
    cooldownUntilByIndex: servers.map(() => 0),
    failureCountByIndex: servers.map(() => 0),
    /** Local `http://127.0.0.1:port` URLs to pass to proxy-chain on shutdown */
    anonymizedLocalUrls: /** @type {string[]} */ ([]),
    rotateEvery,
    index: 0,
    get multi() {
      return this.servers.length > 1;
    },
    currentIndex() {
      return this.index % this.servers.length;
    },
    current() {
      return this.servers[this.currentIndex()];
    },
    cooldownMsFor(index) {
      const until = this.cooldownUntilByIndex[index] || 0;
      return Math.max(0, until - Date.now());
    },
    currentCooldownMs() {
      return this.cooldownMsFor(this.currentIndex());
    },
    shortestCooldownMs() {
      return this.cooldownUntilByIndex.reduce((min, until) => {
        const ms = Math.max(0, until - Date.now());
        return min === null || ms < min ? ms : min;
      }, null);
    },
    markCooldown(ms, reason = "") {
      const index = this.currentIndex();
      const waitMs = Math.max(0, ms);
      const nextUntil = Date.now() + waitMs;
      this.cooldownUntilByIndex[index] = Math.max(
        this.cooldownUntilByIndex[index] || 0,
        nextUntil
      );
      this.failureCountByIndex[index] =
        (this.failureCountByIndex[index] || 0) + 1;
      const strikes = this.failureCountByIndex[index];
      if (waitMs > 0) {
        console.warn(
          `[proxy] Mark bad ${this.peekLabel(index)}: strikes=${strikes}; cooldown ${formatDuration(waitMs)}${reason ? ` (${reason})` : ""}`
        );
        console.warn(
          `[proxy] Cooldown ${this.peekLabel(index)} for ${formatDuration(waitMs)}${reason ? ` (${reason})` : ""}`
        );
      } else if (reason) {
        console.warn(
          `[proxy] Mark bad ${this.peekLabel(index)}: strikes=${strikes}${reason ? ` (${reason})` : ""}`
        );
      }
    },
    advance() {
      const prev = this.currentIndex();
      this.index += 1;
      const next = this.currentIndex();
      console.log(
        `[proxy] Switch ${prev} → ${next} (of ${this.servers.length})`
      );
    },
    peekLabel(index = this.currentIndex()) {
      const p = this.servers[index];
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

function isRateLimitedHealthProbe(url, status) {
  if (status !== 403 && status !== 429) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "contactout.com" || host.endsWith(".contactout.com");
  } catch {
    return false;
  }
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

function proxyExhaustedRetryMs() {
  return envInt("PROXY_EXHAUSTED_RETRY_MS", 60_000, 1_000);
}

function proxyExhaustedMaxWaitMs() {
  return envInt("PROXY_EXHAUSTED_MAX_WAIT_MS", 0, 0);
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
    if (isRateLimitedHealthProbe(url, res.status())) {
      console.warn(
        `[proxy] Health probe ${url} returned HTTP ${res.status()}; treating proxy as reachable because the target is rate-limiting, not necessarily unreachable.`
      );
      return true;
    }
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
  const max = proxyHealthMaxSkips(rotator);
  let skipped = 0;
  const healthCheckDisabled = isProxyHealthCheckDisabled();

  while (skipped < max) {
    const p = rotator.current();
    const label = rotator.peekLabel?.() || p.server;
    const cooldownMs = rotator.currentCooldownMs?.() || 0;

    if (cooldownMs > 0) {
      console.warn(
        `[proxy] ${label} cooling down for ${formatDuration(cooldownMs)} (${tag})`
      );
      rotator.advance();
      skipped += 1;
      continue;
    }

    if (healthCheckDisabled || (await proxyPassesHealthCheck(p))) {
      rotator.exhaustedStartedAt = 0;
      rotator.exhaustedWaitCount = 0;
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
    rotator.markCooldown?.(5 * 60_000, `health check failed: ${tag}`);
    rotator.advance();
    skipped += 1;
  }

  const shortestCooldownMs = rotator.shortestCooldownMs?.() || 0;
  const exhaustedRetryMs = proxyExhaustedRetryMs();
  const exhaustedMaxWaitMs = proxyExhaustedMaxWaitMs();
  const waitMs =
    shortestCooldownMs > 0 && Number.isFinite(shortestCooldownMs)
      ? shortestCooldownMs
      : exhaustedRetryMs;
  const exhaustedStartedAt = rotator.exhaustedStartedAt || Date.now();
  rotator.exhaustedStartedAt = exhaustedStartedAt;
  if (
    exhaustedMaxWaitMs > 0 &&
    Date.now() - exhaustedStartedAt + waitMs > exhaustedMaxWaitMs
  ) {
    throw new Error(
      `[proxy] No reachable proxy after ${max} tries (${tag}) and waited ${formatDuration(
        Date.now() - exhaustedStartedAt
      )}. Disable with PROXY_HEALTH_CHECK=0, fix PROXY_HEALTH_CHECK_URL, or raise PROXY_EXHAUSTED_MAX_WAIT_MS`
    );
  }
  rotator.exhaustedWaitCount = (rotator.exhaustedWaitCount || 0) + 1;
  if (shortestCooldownMs > 0 && Number.isFinite(shortestCooldownMs)) {
    console.warn(
      `[proxy] All proxies are cooling down; waiting ${formatDuration(waitMs)} before retry ${rotator.exhaustedWaitCount} (${tag})`
    );
    await sleep(waitMs);
    return skipUntilHealthyProxy(rotator, tag);
  }

  console.warn(
    `[proxy] No healthy proxy available right now; waiting ${formatDuration(waitMs)} before retry ${rotator.exhaustedWaitCount} (${tag})`
  );
  await sleep(waitMs);
  return skipUntilHealthyProxy(rotator, tag);
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

function stringifySearchHistory(data) {
  const base = JSON.stringify(data, null, 2);
  return (
    base.replace(
      /"pagesCompleted": \[(.*?)\]/gs,
      (_match, inner) => {
        const items = [...inner.matchAll(/\d+/g)].map((m) => m[0]);
        return `"pagesCompleted": [${items.join(", ")}]`;
      }
    ) + "\n"
  );
}

function saveSearchHistory(historyPath, data) {
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.writeFileSync(historyPath, stringifySearchHistory(data), "utf8");
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

function setSearchParam(searchUrl, key, value) {
  const u = new URL(searchUrl, "https://contactout.com");
  if (value === undefined || value === null || String(value).trim() === "") {
    u.searchParams.delete(key);
  } else {
    u.searchParams.set(key, String(value).trim());
  }
  u.searchParams.delete("page");
  return u.toString();
}

function applySearchUrlOverrides(searchUrl, flatParams = {}) {
  let nextUrl = searchUrl;
  for (const [key, value] of Object.entries(flatParams)) {
    nextUrl = setSearchParam(nextUrl, key, value);
  }
  return nextUrl;
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
 * Runs the bundled IIFE in the page context (same row shape as the extension popup export).
 */
async function scrapeCurrentPageRows(page, roleHint = "") {
  const code = scrapeDomEvalSource;
  return page.evaluate(({ src, roleHint }) => {
    window.__CONTACTOUT_ROLE_HINT = roleHint || "";
    return (0, eval)(src);
  }, { src: code, roleHint: getSearchRoleValue(roleHint) });
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
    const blocked = /(^|\b)403(\b|$)|403 forbidden|forbidden|too many requests|rate limit|temporarily blocked|unusual traffic|access denied|verify you are human|captcha|security check|request unsuccessful|attention required|please enable cookies/i.test(
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

async function extractProfileCount(page) {
  return page.evaluate(() => {
    const text = String(document.body?.innerText || "");
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const normalized = lines.join(" ");
    const patterns = [
      /\b\d+\s*-\s*\d+\s+of\s+([\d,]+)\+?\s+(profiles?|results?|people)\b/i,
      /\bshowing\s+\d+\s*-\s*\d+\s+of\s+([\d,]+)\+?\s+(profiles?|results?|people)\b/i,
      /\bof\s+([\d,]+)\+?\s+(profiles?|results?|people)\b/i,
      /\b([\d,]+)\+?\s+(profiles?|results?|people)\b/i,
    ];
    const candidates = [
      ...lines.filter((line) => /\b(profiles?|results?|people)\b/i.test(line)),
      normalized,
    ];

    for (const candidate of candidates) {
      for (const pattern of patterns) {
        const match = candidate.match(pattern);
        if (!match) continue;
        const total = parseInt(String(match[1] || "").replace(/,/g, ""), 10);
        if (!Number.isFinite(total)) continue;
        return { total, summary: match[0] };
      }
    }

    return null;
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
function resolveSearchUrlAndLocation(ROOT, cli, roleOverride = "", countryOverride = "") {
  const envUrl = process.env.CONTACTOUT_SEARCH_URL?.trim();
  const envLocation = getSearchCountryValue(countryOverride);
  const envTitle = getSearchRoleValue(roleOverride);
  const envGender = normalizeGenderValue(process.env.SEARCH_GENDER?.trim());
  const defaultLocation = envLocation || "United States";
  const envFlatParams = {
    ...(envLocation ? { location: envLocation } : {}),
    ...(envTitle ? { title: envTitle } : {}),
    ...(envGender ? { gender: envGender } : {}),
  };

  if (envUrl) {
    const searchUrlRaw = applySearchUrlOverrides(envUrl, envFlatParams);
    return {
      location: locationFromSearchUrl(searchUrlRaw) || defaultLocation,
      searchUrlRaw,
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
      : { login: "success" };

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
        const searchUrlRaw = applySearchUrlOverrides(urlRaw, envFlatParams);
        return {
          location:
            (typeof preset.location === "string" && preset.location.trim()) ||
            locationFromSearchUrl(searchUrlRaw) ||
            defaultLocation,
          searchUrlRaw,
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
        const searchUrlRaw = applySearchUrlOverrides(urlRaw, envFlatParams);
        return {
          location:
            (typeof entry.location === "string" && entry.location.trim()) ||
            locationFromSearchUrl(searchUrlRaw) ||
            defaultLocation,
          searchUrlRaw,
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
        ...defaultExtra,
        location: defaultLocation,
        ...(envTitle ? { title: envTitle } : {}),
        ...(envGender ? { gender: envGender } : {}),
      },
      baseFromFile
    ),
  };
}

function buildSearchPlans(ROOT, cli) {
  const countryList = parseSearchCountryListEnv();
  const genderList = parseSearchGenderListEnv();
  const roleList = parseSearchRoleListEnv();
  const workerRole = String(process.env.CONTACTOUT_WORKER_ROLE || "").trim();
  const countries = countryList.length ? countryList : [getSearchCountryValue()].filter(Boolean);
  const effectiveCountries = countries.length ? countries : ["United States"];
  const roles = workerRole
    ? [workerRole]
    : roleList.length
      ? roleList
      : [getSearchRoleValue()].filter(Boolean);
  const effectiveRoles = roles.length ? roles : [""];
  const normalizedGenders = genderList.length
    ? [...new Set(genderList.map((gender) => normalizeGenderValue(gender)))]
    : [normalizeGenderValue(process.env.SEARCH_GENDER?.trim() || "")];
  const effectiveGenders = normalizedGenders.length ? normalizedGenders : [""];
  const multiGender = effectiveGenders.length > 1;
  const plans = [];
  const mergePlans = [];

  for (const country of effectiveCountries) {
    for (const role of effectiveRoles) {
      const basePlan = resolveSearchUrlAndLocation(ROOT, cli, role, country);
      const mergedBaseUrl = normalizeSearchBaseUrl(
        setSearchParam(basePlan.searchUrlRaw, "gender", "")
      );
      const mergeKey = `${country || "__default-country__"}::${role || "__default-role__"}`;
      const mergedFolderParts = [
        sanitizeFilenamePart(country),
        sanitizeFilenamePart(role),
      ].filter(Boolean);
      mergePlans.push({
        mergeKey,
        country,
        role,
        mergedSearchId: searchIdFromBaseUrl(mergedBaseUrl),
        mergedExportNameSuffix: buildExportNameSuffix({
          country,
          role,
          gender: multiGender ? "all-genders" : effectiveGenders[0],
        }),
        mergedDir: path.join(ROOT, "data", ...mergedFolderParts),
        mergedFolderParts,
      });

      for (const gender of effectiveGenders) {
        const normalizedGender = normalizeGenderValue(gender);
        const searchUrlRaw = normalizedGender
          ? setSearchParam(basePlan.searchUrlRaw, "gender", normalizedGender)
          : setSearchParam(basePlan.searchUrlRaw, "gender", "");
        plans.push({
          location: basePlan.location,
          country,
          role,
          mergeKey,
          searchUrlRaw,
          exportNameSuffix: buildExportNameSuffix({
            country,
            role,
            gender: normalizedGender,
          }),
          gender: normalizedGender,
          years: "",
          totalYears: "",
          employeeSize: "",
          revenueMin: "",
          revenueMax: "",
          industry: "",
        });
      }
    }
  }

  return {
    plans,
    mergePlans,
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

async function login(page, email, password) {
  if (!email || !String(email).trim()) {
    throw new Error("Missing login email");
  }
  if (!password || !String(password).trim()) {
    throw new Error("Missing login password");
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

function runtimeWorkerKey(workerSlot = 0) {
  const normalized = normalizeWorkerSlot(workerSlot);
  return normalized ? `slot-${normalized}` : "default";
}

function makeFileStamp(value = new Date()) {
  return new Date(value).toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

function workerSlotDisplay(workerSlot = 0) {
  const normalized = normalizeWorkerSlot(workerSlot);
  if (!normalized) return "default worker";
  const label = workerSlotLabel(normalized);
  return label ? `worker slot ${normalized} (${label})` : `worker slot ${normalized}`;
}

function defaultHistoryPathForWorker(rootDir, workerSlot = 0) {
  const normalized = normalizeWorkerSlot(workerSlot);
  if (!normalized) {
    return path.join(rootDir, "ref", "search-history.json");
  }
  return path.join(
    rootDir,
    "ref",
    "search-history",
    `search-history-slot-${normalized}.json`
  );
}

function rawExportRootForWorker(exportDir, workerSlot = 0) {
  return path.join(exportDir, "_raw", runtimeWorkerKey(workerSlot));
}

function parseRequestedSearchRoles() {
  const roles = parseSearchRoleListEnv();
  if (roles.length) {
    return [...new Set(roles.map((role) => String(role || "").trim()).filter(Boolean))];
  }
  const singleRole = getSearchRoleValue();
  return singleRole ? [singleRole] : [];
}

function parseMaxBrowserCount() {
  const raw = process.env.MAX_BROWSER_COUNT?.trim();
  if (!raw) return 1;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, parsed);
}

function workerDeadSlotLogIntervalMs() {
  return envInt("WORKER_DEAD_SLOT_LOG_INTERVAL_MS", 30_000, 1_000);
}

async function resolveRoleWorkerSlots(maxBrowserCount) {
  const workerCount = Math.max(1, Math.min(parseInt(String(maxBrowserCount), 10) || 1, 3));
  const slots = [];
  for (let slot = 1; slot <= workerCount; slot += 1) {
    const emailConfig = await loadEmailConfig({ fresh: true, workerSlot: slot });
    const proxyConfig = await loadProxyConfig({ fresh: true, workerSlot: slot });
    if (!emailConfig.emailPool.length) {
      throw new Error(`Missing login emails for ${workerSlotDisplay(slot)} in ref/emails.js.`);
    }
    if (!proxyConfig.proxyLines.length) {
      throw new Error(`Missing proxies for ${workerSlotDisplay(slot)} in ref/proxies.js.`);
    }
    slots.push(slot);
  }
  return slots;
}

async function runRoleWorkerChildProcess(workerSlot, workerRole, cliArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [process.argv[1], ...cliArgs], {
      cwd: ROOT,
      env: {
        ...process.env,
        CONTACTOUT_WORKER_SLOT: String(workerSlot),
        CONTACTOUT_WORKER_ROLE: workerRole,
        CONTACTOUT_ORCHESTRATED_WORKER: "1",
      },
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${workerSlotDisplay(workerSlot)} for role "${workerRole}" exited with code ${code ?? "null"}${signal ? ` (signal ${signal})` : ""}.`
        )
      );
    });
  });
}

async function maybeRunRoleWorkers() {
  if (process.env.CONTACTOUT_WORKER_ROLE?.trim()) {
    return false;
  }

  const requestedRoles = parseRequestedSearchRoles();
  const maxBrowserCount = parseMaxBrowserCount();
  if (requestedRoles.length < 2 || maxBrowserCount <= 1) {
    return false;
  }

  const workerSlots = await resolveRoleWorkerSlots(Math.min(maxBrowserCount, requestedRoles.length));
  const pendingRoles = requestedRoles.map((role) => ({ role }));
  const currentRolesBySlot = new Map();
  const liveSlots = new Set(workerSlots);
  const deadSlots = new Map();
  const slotPollMs = 1_000;

  const formatDeadSlotSummary = () =>
    [...deadSlots.values()]
      .map(
        (failure) =>
          `${workerSlotDisplay(failure.slot)} role "${failure.role}" at ${failure.failedAt}: ${failure.message}`
      )
      .join(" | ");

  const logDeadSlotStatus = (label = "[worker] Dead slot status") => {
    if (!deadSlots.size) return;
    const activeRoles = [...currentRolesBySlot.entries()]
      .map(([slot, role]) => `${workerSlotDisplay(slot)}="${role}"`)
      .join(", ");
    console.warn(
      `${label}: ${formatDeadSlotSummary()}${activeRoles ? ` | active ${activeRoles}` : ""} | live=${liveSlots.size}/${workerSlots.length} | pending=${pendingRoles.length}`
    );
  };

  const deadSlotLogTimer = setInterval(() => {
    if (deadSlots.size > 0 && liveSlots.size > 0) {
      logDeadSlotStatus();
    }
  }, workerDeadSlotLogIntervalMs());
  deadSlotLogTimer.unref?.();

  try {
    await Promise.all(
      workerSlots.map(async (slot) => {
        while (liveSlots.has(slot)) {
          const task = pendingRoles.shift();
          if (!task) {
            if (currentRolesBySlot.size === 0) {
              return;
            }
            await sleep(slotPollMs);
            continue;
          }

          const role = task.role;
          currentRolesBySlot.set(slot, role);
          console.log(`[worker] ${workerSlotDisplay(slot)} -> role "${role}"`);
          try {
            await runRoleWorkerChildProcess(slot, role, process.argv.slice(2));
          } catch (error) {
            currentRolesBySlot.delete(slot);
            liveSlots.delete(slot);
            pendingRoles.unshift(task);
            deadSlots.set(slot, {
              slot,
              role,
              failedAt: new Date().toISOString(),
              message: error?.message || String(error),
            });
            console.error(
              `[worker] ${workerSlotDisplay(slot)} died on role "${role}". ${liveSlots.size > 0 ? `Re-queued the role; ${liveSlots.size} slot(s) still alive.` : "No live slots remain."}`
            );
            logDeadSlotStatus("[worker] Dead slot");
            return;
          }
          currentRolesBySlot.delete(slot);
        }
      })
    );
  } finally {
    clearInterval(deadSlotLogTimer);
  }

  if (pendingRoles.length > 0) {
    const failedSummary = deadSlots.size
      ? formatDeadSlotSummary()
      : "No dead slot details were recorded.";
    throw new Error(
      `[worker] All live slots stopped before completing ${pendingRoles.length} role(s): ${pendingRoles
        .map((task) => `"${task.role}"`)
        .join(", ")}. ${failedSummary}`
    );
  }

  if (deadSlots.size > 0) {
    logDeadSlotStatus("[worker] Completed with dead slot(s)");
  }
  return true;
}

async function runProxyPreflight(workerSlot = 0) {
  const normalizedSlot = normalizeWorkerSlot(workerSlot);
  const workerProxyConfig = await loadProxyConfig({
    fresh: true,
    workerSlot: normalizedSlot,
  });

  if (workerProxyConfig.proxyLines.length) {
    const validation = await validateProxyLines(workerProxyConfig.proxyLines, {
      logger: console,
    });
    if (validation?.skipped) {
      console.log(`[proxy] Proxy preflight skipped: ${validation.reason}`);
      process.env.PROXY_LIST = workerProxyConfig.proxyLines.join("\n");
      process.env.CONTACTOUT_VALIDATED_PROXY_LIST = "1";
      return;
    }
    if (!validation.healthyLines.length) {
      throw new Error(
        `Proxy validation produced 0 healthy proxy endpoints${normalizedSlot ? ` for ${workerSlotDisplay(normalizedSlot)}` : ""}.`
      );
    }
    process.env.PROXY_LIST = validation.healthyLines.join("\n");
    process.env.CONTACTOUT_VALIDATED_PROXY_LIST = "1";
    return;
  }

  const proxyRefreshResult = await maybeRefreshProxyFileFromLocalList({
    rootDir: ROOT,
    logger: console,
  });
  if (proxyRefreshResult?.skipped) {
    console.log(`[proxy] Proxy preflight skipped: ${proxyRefreshResult.reason}`);
  }
}

async function main() {
  await loadConstantsConfigToEnv();
  const cli = parseCliArgs(process.argv.slice(2));
  if (cli.help) {
    printCliHelp();
    return;
  }

  if (await maybeRunRoleWorkers()) {
    return;
  }

  const workerSlot = normalizeWorkerSlot(process.env.CONTACTOUT_WORKER_SLOT);
  const workerKey = runtimeWorkerKey(workerSlot);

  try {
    await runProxyPreflight(workerSlot);
  } catch (error) {
    console.warn(
      `[proxy] Proxy preflight failed; using existing proxy sources. ${error?.message || error}`
    );
  }
  loadScrapeDomEval();

  const userDataDir = path.join(ROOT, "playwright-user-data", workerKey);
  const exportDir = path.resolve(
    process.env.EXPORT_DIR || path.join(ROOT, "exports")
  );
  fs.mkdirSync(exportDir, { recursive: true });
  const rawExportRoot = rawExportRootForWorker(exportDir, workerSlot);
  fs.mkdirSync(rawExportRoot, { recursive: true });

  const { plans: searchPlans, mergePlans } = buildSearchPlans(ROOT, cli);
  const startPage = parseStartPageEnv();
  const maxPages = parseMaxPagesEnv();
  const unlimitedPages = maxPages === 0;

  const historyPath = path.resolve(
    process.env.SEARCH_HISTORY_PATH || defaultHistoryPathForWorker(ROOT, workerSlot)
  );
  const historyDir = path.dirname(historyPath);
  fs.mkdirSync(historyDir, { recursive: true });
  for (const mergePlan of mergePlans) {
    fs.mkdirSync(mergePlan.mergedDir, { recursive: true });
  }

  const ignoreSearchHistory =
    process.env.IGNORE_SEARCH_HISTORY === "1" ||
    process.env.IGNORE_SEARCH_HISTORY === "true";
  const mergeJson =
    process.env.MERGE_JSON != null
      ? !isEnvFalse("MERGE_JSON")
      : !isEnvFalse("MERGE_CSV");
  const intermediateMergeCount = parseJsonMergeCountEnv();
  const intermediateMergeRoot = path.resolve(
    process.env.MERGED_DIRECTORY || path.join(ROOT, "data", "merged")
  );
  const writeIntermediateMerges = mergeJson && intermediateMergeCount > 0;
  if (writeIntermediateMerges) {
    fs.mkdirSync(intermediateMergeRoot, { recursive: true });
  }

  const accountConfig = await loadAccountsConfig({ workerSlot });
  const emailPool = accountConfig.emailPool;
  let accountPassword = accountConfig.password;
  const accountConfigSource = accountConfig.source;
  const canEditAccountConfig = accountConfigSource === EMAILS_CONFIG_PATH;
  const accountConfigBindingName = accountConfig.bindingName;
  const accountRotateSuccessPages = envInt(
    "ACCOUNT_ROTATE_SUCCESS_PAGES",
    20,
    1
  );
  const accountCooldownMs =
    envInt("ACCOUNT_COOLDOWN_MINUTES", 72, 0) * 60_000;
  const pageSettleDelayMinMs = envInt("PAGE_SETTLE_DELAY_MIN_MS", 1200, 0);
  const pageSettleDelayMaxMs = envInt("PAGE_SETTLE_DELAY_MAX_MS", 2600, 0);
  const pageGapDelayMinMs = envInt("PAGE_GAP_DELAY_MIN_MS", 900, 0);
  const pageGapDelayMaxMs = envInt("PAGE_GAP_DELAY_MAX_MS", 2200, 0);
  const pairSwitchDelayMinMs = envInt("PAIR_SWITCH_DELAY_MIN_MS", 2500, 0);
  const pairSwitchDelayMaxMs = envInt("PAIR_SWITCH_DELAY_MAX_MS", 5000, 0);
  const proxyBlockedCooldownMs = envInt(
    "PROXY_BLOCKED_COOLDOWN_MS",
    15 * 60_000,
    0
  );
  const proxyFailureCooldownMs = envInt(
    "PROXY_FAILURE_COOLDOWN_MS",
    10 * 60_000,
    0
  );
  console.log(`[auth] Loaded accounts from ${accountConfig.source}`);
  let accountStates = emailPool.map((email, index) => ({
    index,
    email,
    activatedAt: 0,
    cooldownUntil: 0,
    successfulPages: 0,
  }));
  let activeAccountIndex = 0;
  let successfulPagesOnCurrentAccount = 0;
  const currentAccount = () => {
    if (!accountStates.length) {
      throw new Error(
        `No active accounts remain${workerSlot ? ` for ${workerSlotDisplay(workerSlot)}` : ""}.`
      );
    }
    const safeIndex =
      ((activeAccountIndex % accountStates.length) + accountStates.length) %
      accountStates.length;
    return accountStates[safeIndex];
  };
  const currentEmail = () => currentAccount().email;
  console.log(
    `[auth] ${emailPool.length} account(s)${workerSlot ? ` for ${workerSlotDisplay(workerSlot)}` : ""}; rotate after ${accountRotateSuccessPages} successful pages, cooldown ${Math.round(accountCooldownMs / 60000)} minute(s)`
  );

  let history = loadSearchHistory(historyPath);
  const mergePlansByKey = new Map(
    mergePlans.map((mergePlan) => [mergePlan.mergeKey, mergePlan])
  );
  const rowsForMergeByKey = new Map(
    mergePlans.map((mergePlan) => [mergePlan.mergeKey, []])
  );
  const rowsForIntermediateMergeByKey = new Map(
    mergePlans.map((mergePlan) => [
      mergePlan.mergeKey,
      { rows: [], pageFileCount: 0, batchIndex: 0 },
    ])
  );

  const rotator = await createProxyRotator();
  const currentProxyLabel = () => (rotator ? rotator.peekLabel() : "direct");
  const currentSessionLabel = () =>
    `email=${currentEmail()} proxy=${currentProxyLabel()}`;
  const logBadProxyRuntime = (reason, details = "") => {
    if (!rotator) return;
    const suffix = details ? ` | ${details}` : "";
    console.warn(
      `[proxy] Bad runtime status: ${currentProxyLabel()} | ${reason} | ${currentSessionLabel()}${suffix}`
    );
  };
  const storageStatePath = path.join(userDataDir, "storage-state.json");
  fs.mkdirSync(userDataDir, { recursive: true });
  const backoff429 =
    parseInt(process.env.PROXY_429_BACKOFF_MS || "60000", 10) || 60000;
  const emptyPageRetryMax = Math.max(
    0,
    parseInt(process.env.EMPTY_PAGE_RETRY_MAX || "2", 10) || 2
  );
  const rapidApiEmailFinderKeysFromList = parseJsonArrayEnv(
    "RAPID_API_EMAIL_FINDER_LIST"
  );
  const rapidApiEmailFinderSingleKey =
    process.env.RAPID_API_EMAIL_FINDER?.trim() || "";
  const rapidApiEmailFinderKeys = [
    ...new Set(
      [
        ...rapidApiEmailFinderKeysFromList,
        ...(rapidApiEmailFinderSingleKey ? [rapidApiEmailFinderSingleKey] : []),
      ]
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    ),
  ];
  const truelistApiKeys = parseJsonArrayEnv("TRUELIST_API_KEYS");
  const bannedWebsiteDomains = new Set(
    parseJsonArrayEnv("BANNED_WEBSITE_DOMAIN").map((domain) =>
      domainFromWebsite(domain)
    ).filter(Boolean)
  );
  const truelistApiBaseUrl =
    process.env.TRUELIST_API_BASE_URL?.trim() || "https://api.truelist.io";
  const emailEnrichConcurrency = envInt("EMAIL_ENRICH_CONCURRENCY", 8, 1);
  const emailFinderTimeoutMs = envInt("EMAIL_FINDER_TIMEOUT_MS", 20000, 1000);
  const truelistTimeoutMs = envInt("TRUELIST_TIMEOUT_MS", 35000, 1000);
  const rapidApiBaseUrl =
    process.env.RAPID_API_EMAIL_FINDER_BASE_URL?.trim() ||
    "https://email-finder7.p.rapidapi.com";
  const emailFinderCache = new Map();
  const emailValidationCache = new Map();
  const rapidApiEmailFinderKeyStates = rapidApiEmailFinderKeys.map(
    (token, index) => ({
      index,
      token,
      cooldownUntil: 0,
    })
  );
  const truelistKeyStates = truelistApiKeys.map((token, index) => ({
    index,
    token,
    cooldownUntil: 0,
  }));
  let rapidApiEmailFinderKeyIndex = 0;
  let truelistKeyIndex = 0;
  console.log(
    `[email] Email finder keys=${rapidApiEmailFinderKeyStates.length}; TrueList keys=${truelistApiKeys.length}; concurrency=${emailEnrichConcurrency}; banned domains=${bannedWebsiteDomains.size}`
  );

  async function fetchJsonWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      const text = await response.text();
      let json = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      return { response, json, text };
    } finally {
      clearTimeout(timer);
    }
  }

  function nextAvailableTruelistKeyState() {
    if (!truelistKeyStates.length) return null;
    const now = Date.now();
    for (let offset = 0; offset < truelistKeyStates.length; offset++) {
      const index = (truelistKeyIndex + offset) % truelistKeyStates.length;
      const state = truelistKeyStates[index];
      if ((state.cooldownUntil || 0) <= now) {
        truelistKeyIndex = (index + 1) % truelistKeyStates.length;
        return state;
      }
    }
    return null;
  }

  function nextAvailableRapidApiEmailFinderKeyState() {
    if (!rapidApiEmailFinderKeyStates.length) return null;
    const now = Date.now();
    for (let offset = 0; offset < rapidApiEmailFinderKeyStates.length; offset++) {
      const index =
        (rapidApiEmailFinderKeyIndex + offset) % rapidApiEmailFinderKeyStates.length;
      const state = rapidApiEmailFinderKeyStates[index];
      if ((state.cooldownUntil || 0) <= now) {
        rapidApiEmailFinderKeyIndex = (index + 1) % rapidApiEmailFinderKeyStates.length;
        return state;
      }
    }
    return null;
  }

  function soonestRapidApiEmailFinderCooldownMs() {
    return rapidApiEmailFinderKeyStates.reduce((min, state) => {
      const ms = Math.max(0, (state.cooldownUntil || 0) - Date.now());
      return min === null || ms < min ? ms : min;
    }, null);
  }

  function soonestTruelistCooldownMs() {
    return truelistKeyStates.reduce((min, state) => {
      const ms = Math.max(0, (state.cooldownUntil || 0) - Date.now());
      return min === null || ms < min ? ms : min;
    }, null);
  }

  function normalizeTruelistInlineResult(payload) {
    const items = Array.isArray(payload?.emails) ? payload.emails : [];
    if (!items.length) return null;
    const first = items[0];
    if (first?.email && typeof first.email === "object") return first.email;
    if (typeof first === "object" && first) return first;
    return null;
  }

  async function findCandidateEmailForRow(row) {
    if (!rapidApiEmailFinderKeyStates.length) return null;
    const name = splitNameFirstLast(row?.fullName || "");
    const domain = domainFromWebsite(row?.workEmailDomain || row?.website || "");
    if (!name || !domain) return null;

    const cacheKey = `${name.firstName.toLowerCase()}|${name.lastName.toLowerCase()}|${domain}`;
    if (emailFinderCache.has(cacheKey)) {
      return emailFinderCache.get(cacheKey);
    }

    const url =
      `${rapidApiBaseUrl.replace(/\/+$/g, "")}/email-address/find-one/` +
      `?personFirstName=${encodeURIComponent(name.firstName)}` +
      `&personLastName=${encodeURIComponent(name.lastName)}` +
      `&domain=${encodeURIComponent(domain)}`;

    const maxAttempts = Math.max(
      1,
      Math.min(rapidApiEmailFinderKeyStates.length, 3)
    );
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let keyState = nextAvailableRapidApiEmailFinderKeyState();
      if (!keyState) {
        const waitMs = soonestRapidApiEmailFinderCooldownMs();
        if (waitMs && Number.isFinite(waitMs) && waitMs > 0) {
          await sleep(waitMs);
          keyState = nextAvailableRapidApiEmailFinderKeyState();
        }
      }
      if (!keyState) break;

      try {
        const { response, json } = await fetchJsonWithTimeout(
          url,
          {
            method: "GET",
            headers: {
              "Content-Type": "application/json",
              "x-rapidapi-host": "email-finder7.p.rapidapi.com",
              "x-rapidapi-key": keyState.token,
            },
          },
          emailFinderTimeoutMs
        );

        if (response.status === 429) {
          keyState.cooldownUntil = Date.now() + 60_000;
          continue;
        }
        if (response.status === 401 || response.status === 403) {
          keyState.cooldownUntil = Date.now() + 5 * 60_000;
          continue;
        }
        if (response.status === 408 || response.status >= 500) {
          continue;
        }
        if (!response.ok) {
          console.warn(
            `[email-finder] ${response.status} for ${name.firstName} ${name.lastName} @ ${domain}`
          );
          return null;
        }

        const candidate = pickBestEmailFinderCandidate(json);
        emailFinderCache.set(cacheKey, candidate?.address || null);
        return candidate?.address || null;
      } catch (error) {
        console.warn(
          `[email-finder] Failed for ${name.firstName} ${name.lastName} @ ${domain}: ${String(error?.message || error)}`
        );
      }
    }

    return null;
  }

  async function validateEmailWithTrueList(email) {
    const normalizedEmail = String(email || "").trim().toLowerCase();
    if (!normalizedEmail || !truelistKeyStates.length) return false;
    if (emailValidationCache.has(normalizedEmail)) {
      return emailValidationCache.get(normalizedEmail);
    }

    const maxAttempts = Math.max(1, Math.min(truelistKeyStates.length, 3));
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let keyState = nextAvailableTruelistKeyState();
      if (!keyState) {
        const waitMs = soonestTruelistCooldownMs();
        if (waitMs && Number.isFinite(waitMs) && waitMs > 0) {
          await sleep(waitMs);
          keyState = nextAvailableTruelistKeyState();
        }
      }
      if (!keyState) break;

      const url =
        `${truelistApiBaseUrl.replace(/\/+$/g, "")}/api/v1/verify_inline` +
        `?email=${encodeURIComponent(normalizedEmail)}`;

      try {
        const { response, json } = await fetchJsonWithTimeout(
          url,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${keyState.token}`,
              "Content-Type": "application/json",
            },
          },
          truelistTimeoutMs
        );

        if (response.status === 429) {
          keyState.cooldownUntil = Date.now() + 60_000;
          continue;
        }
        if (response.status === 408) {
          continue;
        }
        if (!response.ok) {
          break;
        }

        const result = normalizeTruelistInlineResult(json);
        const ok = result?.email_sub_state === "email_ok";
        emailValidationCache.set(normalizedEmail, ok);
        return ok;
      } catch (error) {
        console.warn(
          `[truelist] Failed for ${normalizedEmail}: ${String(error?.message || error)}`
        );
      }
    }

    return false;
  }

  async function enrichRowsWithValidatedEmails(rows, pageNum, plan) {
    if (!rows.length) return [];
    if (!rapidApiEmailFinderKeyStates.length || !truelistKeyStates.length) {
      console.warn(
        `[email] Missing API keys; page ${pageNum} will not save profiles because validation is required.`
      );
      return [];
    }

    const enriched = await mapWithConcurrency(
      rows,
      emailEnrichConcurrency,
      async (row) => {
        const websiteDomain = domainFromWebsite(
          row?.workEmailDomain || row?.website || ""
        );
        if (websiteDomain && bannedWebsiteDomains.has(websiteDomain)) {
          console.log(
            `[email] Skipped banned domain ${websiteDomain} for ${String(row?.fullName || "").trim()}`
          );
          return null;
        }
        const candidateEmail = await findCandidateEmailForRow(row);
        if (!candidateEmail) return null;
        const ok = await validateEmailWithTrueList(candidateEmail);
        if (!ok) return null;
        console.log(
          `[email] Validateddddddddd profile ${String(row?.fullName || "").trim()} -> ${candidateEmail}`
        );
        return {
          ...row,
          email: candidateEmail,
        };
      }
    );

    const filtered = enriched.filter(Boolean);
    console.log(
      `[email] Page ${pageNum}${plan?.role ? ` role=${plan.role}` : ""}${plan?.gender ? ` gender=${plan.gender}` : ""}: validated ${filtered.length}/${rows.length} profile(s)`
    );
    return filtered;
  }

  if (rotator) {
    await anonymizeSocksAuthProxiesForChromium(rotator);
  }

  let browser = null;
  /** @type {import("playwright").BrowserContext} */
  let context;
  /** @type {import("playwright").Page} */
  let page;

  let loggedIn = false;
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

  async function refreshAccountStatesFromSource(reason = "", preferredEmail = "") {
    const freshConfig = await loadAccountsConfig({
      fresh: true,
      workerSlot,
    });
    const previousCount = accountStates.length;
    const previousByEmail = new Map(
      accountStates.map((state) => [state.email.toLowerCase(), state])
    );
    const nextStates = freshConfig.emailPool.map((email, index) => {
      const existing = previousByEmail.get(String(email).toLowerCase());
      if (existing) {
        return {
          ...existing,
          index,
          email,
        };
      }
      return {
        index,
        email,
        activatedAt: 0,
        cooldownUntil: 0,
        successfulPages: 0,
      };
    });
    accountStates = nextStates;
    accountPassword = freshConfig.password;

    if (!accountStates.length) {
      throw new Error(
        `No login accounts remain for export${workerSlot ? ` (${workerSlotDisplay(workerSlot)})` : ""}.`
      );
    }

    const targetEmail = String(preferredEmail || "").trim().toLowerCase();
    const preferredIndex = targetEmail
      ? accountStates.findIndex(
          (state) => state.email.toLowerCase() === targetEmail
        )
      : -1;
    if (preferredIndex >= 0) {
      activeAccountIndex = preferredIndex;
    } else if (targetEmail) {
      activeAccountIndex = -1;
    } else if (activeAccountIndex >= accountStates.length) {
      activeAccountIndex = accountStates.length - 1;
    }

    if (accountStates.length !== previousCount) {
      console.log(
        `[auth] Reloaded email pool${workerSlot ? ` (${workerSlotDisplay(workerSlot)})` : ""}: ${previousCount} -> ${accountStates.length}${reason ? ` (${reason})` : ""}`
      );
    }
    return {
      preferredFound: preferredIndex >= 0,
    };
  }

  async function removeEmailFromAccountSource(email, reason = "") {
    const normalized = String(email || "").trim().toLowerCase();
    if (!normalized) return false;
    if (!canEditAccountConfig) {
      console.warn(
        `[auth] Cannot auto-remove ${email}; accounts are not sourced from ${EMAILS_CONFIG_PATH}.`
      );
      return false;
    }

    const freshConfig = await loadAccountsConfig({
      fresh: true,
      workerSlot,
    });
    const nextPool = freshConfig.emailPool.filter(
      (item) => String(item).trim().toLowerCase() !== normalized
    );
    if (nextPool.length === freshConfig.emailPool.length) {
      return false;
    }

    saveEmailPoolToConfigFile(nextPool, {
      workerSlot,
      bindingName: accountConfigBindingName,
    });
    console.warn(
      `[auth] Auto-removed ${email} from the ${workerSlot ? workerSlotDisplay(workerSlot) : "default"} email pool${reason ? ` (${reason})` : ""}.`
    );
    console.error(
      `[ALERT] Removeddddd blocked/dead account ${email} from the ${workerSlot ? workerSlotDisplay(workerSlot) : "default"} email pool${reason ? ` (${reason})` : ""}.`
    );
    return true;
  }

  function activateAccount(index, reason = "startup") {
    activeAccountIndex =
      ((index % accountStates.length) + accountStates.length) %
      accountStates.length;
    const account = currentAccount();
    account.activatedAt = Date.now();
    successfulPagesOnCurrentAccount = 0;
    console.log(
      `[auth] Active account ${activeAccountIndex + 1}/${accountStates.length}: ${account.email}${reason ? ` (${reason})` : ""}`
    );
  }

  function markCurrentAccountCoolingDown(reason = "") {
    const account = currentAccount();
    if (!account) return;
    const activatedAt = account.activatedAt || Date.now();
    const nextAvailableAt = activatedAt + accountCooldownMs;
    account.cooldownUntil = Math.max(account.cooldownUntil || 0, nextAvailableAt);
    if (accountCooldownMs > 0) {
      console.log(
        `[auth] Cooldown ${account.email} until ${new Date(account.cooldownUntil).toISOString()}${reason ? ` (${reason})` : ""}`
      );
    }
  }

  function nextAvailableAccountIndex() {
    if (!accountStates.length) return -1;
    const now = Date.now();
    for (let offset = 1; offset <= accountStates.length; offset++) {
      const index = (activeAccountIndex + offset) % accountStates.length;
      if ((accountStates[index].cooldownUntil || 0) <= now) {
        return index;
      }
    }
    return -1;
  }

  function soonestAccountCooldownMs() {
    return accountStates.reduce((min, account) => {
      const ms = Math.max(0, (account.cooldownUntil || 0) - Date.now());
      return min === null || ms < min ? ms : min;
    }, null);
  }

  /**
   * @param {string} reason
   * @param {{ clearSession?: boolean, advanceProxy?: boolean }} [options]
   */
  async function recreateProxyContext(reason, options = {}) {
    const clearSession = Boolean(options.clearSession);
    const advanceProxy = options.advanceProxy !== false;

    if (rotator) {
      if (!browser) {
        browser = await chromium.launch({ headless: envHeadless() });
      }

      try {
        if (clearSession && context) {
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
            "[proxy] Deleted saved storage-state (fresh session)."
          );
        }
      } catch {
        /* ignore */
      }
    }

    await context?.close().catch(() => {});
    if (advanceProxy) {
      rotator.advance();
    }
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

    else {
      await context?.close().catch(() => {});
      if (clearSession) {
        try {
          fs.rmSync(userDataDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
        fs.mkdirSync(userDataDir, { recursive: true });
        console.log("[auth] Cleared persistent browser profile (fresh session).");
      }
      context = await chromium.launchPersistentContext(userDataDir, {
        headless: envHeadless(),
        viewport: { width: 1280, height: 800 },
      });
      page = context.pages()[0] || (await context.newPage());
      console.log(`[auth] New browser context (${reason})`);
    }
    loggedIn = false;
  }

  async function rotateAccountProxyPair(reason, options = {}) {
    const penalizeCurrentProxyMs = Math.max(0, options.penalizeCurrentProxyMs || 0);
    const clearSession = options.clearSession !== false;
    const removeCurrentAccount = Boolean(options.removeCurrentAccount);
    const activeEmailBeforeRotation =
      accountStates.length > 0 ? currentAccount().email : "";

    if (rotator && penalizeCurrentProxyMs > 0) {
      rotator.markCooldown(penalizeCurrentProxyMs, reason);
    }

    if (removeCurrentAccount && activeEmailBeforeRotation) {
      await removeEmailFromAccountSource(activeEmailBeforeRotation, reason);
      activeAccountIndex = -1;
      await refreshAccountStatesFromSource(
        `after removing ${activeEmailBeforeRotation}`,
        ""
      );
    } else {
      const refreshResult = await refreshAccountStatesFromSource(
        `before rotation: ${reason}`,
        activeEmailBeforeRotation
      );
      if (refreshResult?.preferredFound) {
        markCurrentAccountCoolingDown(reason);
      } else if (activeEmailBeforeRotation) {
        console.log(
          `[auth] Skipping cooldown for removed account ${activeEmailBeforeRotation} (${reason}).`
        );
      }
    }

    let nextIndex = nextAvailableAccountIndex();
    if (nextIndex < 0) {
      const waitMs = soonestAccountCooldownMs();
      if (waitMs && Number.isFinite(waitMs) && waitMs > 0) {
        console.log(
          `[auth] All accounts cooling down; waiting ${formatDuration(waitMs)} before switching pairs.`
        );
        await sleep(waitMs);
      }
      nextIndex = nextAvailableAccountIndex();
    }
    if (nextIndex < 0) {
      nextIndex = (activeAccountIndex + 1) % accountStates.length;
    }

    activateAccount(nextIndex, reason);
    pagesSinceRotate = 0;
    await recreateProxyContext(reason, {
      clearSession,
      advanceProxy: Boolean(rotator),
    });
    await sleepRandom(pairSwitchDelayMinMs, pairSwitchDelayMaxMs);
  }

  async function noteSuccessfulPageExport(reason = "successful page export") {
    const account = currentAccount();
    if (account) {
      account.successfulPages += 1;
    }
    successfulPagesOnCurrentAccount += 1;
    if (successfulPagesOnCurrentAccount >= accountRotateSuccessPages) {
      await rotateAccountProxyPair(
        `${reason}: reached ${successfulPagesOnCurrentAccount}/${accountRotateSuccessPages} successful pages`
      );
      return;
    }
    await sleepRandom(pageGapDelayMinMs, pageGapDelayMaxMs);
  }

  activateAccount(activeAccountIndex, "startup");
  await recreateProxyContext("startup", {
    clearSession: false,
    advanceProxy: false,
  });
  if (rotator) {
    console.log(
      `[proxy] ${rotator.servers.length} endpoint(s); first: ${rotator.peekLabel()}; pair rotation budget ${accountRotateSuccessPages} successful pages`
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

  function isBlockedHttpStatus(status) {
    return status === 403 || status === 429;
  }

  function blockedStatusLabel(status) {
    if (status === 403) return "HTTP 403";
    if (status === 429) return "HTTP 429";
    return `HTTP ${status}`;
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
    const maxBlocked = 6;
    let failoversForThisNav = 0;
    const blockedStatuses = [];

    for (let round = 0; round < maxBlocked; round++) {
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
            logBadProxyRuntime(reason, `${label}; ${oneLine}`);
            console.warn(
              `[proxy] ${label}: ${oneLine} — ${reason}, failover ${failoversForThisNav}/${proxyFailoverCap}`
            );
            console.warn(
              `[proxy] Failover session ${currentSessionLabel()}`
            );
            rotator?.markCooldown(proxyFailureCooldownMs, reason);
            await recreateProxyContext(reason, {
              clearSession: false,
              advanceProxy: true,
            });
            continue;
          }
          throw e;
        }
      }

      const st = resp?.status();
      if (isBlockedHttpStatus(st)) {
        blockedStatuses.push(st);
        const statusLabel = blockedStatusLabel(st);
        logBadProxyRuntime(statusLabel, `${label}; round ${round + 1}/${maxBlocked}`);
        console.warn(
          `[contactout-bot] ${statusLabel} on ${label} (round ${round + 1}/${maxBlocked}) - rotate session/proxy before retry`
        );
        console.warn(
          `[contactout-bot] Blocked session ${currentSessionLabel()}`
        );
        await rotateAccountProxyPair(statusLabel, {
          clearSession: true,
          penalizeCurrentProxyMs: proxyBlockedCooldownMs,
          removeCurrentAccount: true,
        });
        continue;
      }

      if (Number.isFinite(st) && st >= 400) {
        console.warn(
          `[contactout-bot] HTTP ${st} on ${label}; continuing, but the page may be incomplete or blocked.`
        );
      }

      await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
      return resp;
    }

    throw new Error(
      `Too many blocked HTTP responses (${label}): ${blockedStatuses.join(", ")}`
    );
  }

  const searchProfileThreshold = 2500;
  const searchYearsList = parseSearchYearsListEnv();
  const searchTotalYearsList = parseSearchTotalYearsListEnv();
  const searchEmployeeSizeList = parseSearchEmployeeSizeListEnv();
  const searchRevenueRanges = parseSearchRevenueRangesEnv();
  const searchIndustryList = parseSearchIndustryListEnv();

  const writeIntermediateMergedJson = (mergePlan, reason = "threshold") => {
    if (!writeIntermediateMerges) return false;
    const state = rowsForIntermediateMergeByKey.get(mergePlan.mergeKey);
    if (!state || state.pageFileCount === 0 || state.rows.length === 0) return false;

    const merged = dedupeRowsByLinkedin(state.rows);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const middleDir = intermediateMergeRoot;
    fs.mkdirSync(middleDir, { recursive: true });
    state.batchIndex += 1;
    const middlePath = path.join(
      middleDir,
      `contactout-middle-merged-${mergePlan.mergedSearchId.slice(0, 8)}${mergePlan.mergedExportNameSuffix}-batch-${String(state.batchIndex).padStart(4, "0")}-pages-${state.pageFileCount}-items-${merged.length}-${stamp}.json`
    );
    fs.writeFileSync(
      middlePath,
      buildJson(merged, { searchRole: mergePlan.role }),
      "utf8"
    );
    console.log(
      `[contactout-bot] Middle merged ${state.pageFileCount} page JSON file(s) for ${mergePlan.role || "default role"} -> ${merged.length} unique -> ${middlePath}${reason === "final-flush" ? " (final batch)" : ""}`
    );
    state.rows = [];
    state.pageFileCount = 0;
    rowsForIntermediateMergeByKey.set(mergePlan.mergeKey, state);
    return true;
  };

  const buildPlanFolderParts = (plan) =>
    buildExportFolderParts({
      country: plan.country,
      role: plan.role,
      gender: plan.gender,
      years: plan.years,
      totalYears: plan.totalYears,
      employeeSize: plan.employeeSize,
      revenueMin: plan.revenueMin,
      revenueMax: plan.revenueMax,
      industry: plan.industry,
    });

  const buildValidatedPageOutputPath = (task) => {
    const planFolderParts = buildPlanFolderParts(task.plan);
    const outDir = path.join(exportDir, ...planFolderParts);
    fs.mkdirSync(outDir, { recursive: true });
    return path.join(
      outDir,
      `contactout-page-${String(task.pageNum).padStart(4, "0")}${task.plan.exportNameSuffix}-${task.stamp}.json`
    );
  };

  const buildRawPageOutputPath = (plan, pageNum, stamp) => {
    const planFolderParts = buildPlanFolderParts(plan);
    const outDir = path.join(rawExportRoot, ...planFolderParts);
    fs.mkdirSync(outDir, { recursive: true });
    return path.join(
      outDir,
      `contactout-raw-page-${String(pageNum).padStart(4, "0")}${plan.exportNameSuffix}-${stamp}.json`
    );
  };

  const writeRawPageTask = (plan, searchId, pageNum, urlThis, rows) => {
    const stamp = makeFileStamp();
    const rawPath = buildRawPageOutputPath(plan, pageNum, stamp);
    fs.writeFileSync(
      rawPath,
        JSON.stringify(
          {
            version: 1,
            workerSlot,
            searchId,
            pageNum,
            urlThis,
          stamp,
          plan,
          rows,
          scrapedAt: new Date().toISOString(),
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
    console.log(
      `[contactout-bot] URL page=${pageNum} (${urlThis}): queued ${rows.length} raw row(s) -> ${rawPath}`
    );
    return rawPath;
  };

  const rawTaskBacklogMax = envInt(
    "RAW_TASK_BACKLOG_MAX",
    Math.max(4, intermediateMergeCount > 0 ? intermediateMergeCount * 2 : 12),
    1
  );
  const rawTaskBacklogResumeThreshold = Math.max(
    0,
    Math.min(rawTaskBacklogMax - 1, Math.floor(rawTaskBacklogMax / 2))
  );

  const collectPendingRawTaskPaths = () => {
    const out = [];
    const visit = (dirPath) => {
      if (!fs.existsSync(dirPath)) return;
      for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          visit(fullPath);
          continue;
        }
        if (entry.isFile() && entry.name.startsWith("contactout-raw-page-") && entry.name.endsWith(".json")) {
          out.push(fullPath);
        }
      }
    };
    visit(rawExportRoot);
    out.sort();
    return out;
  };

  const queuedRawTaskPaths = [];
  const queuedRawTaskPathSet = new Set();
  let rawTaskProcessorPromise = null;
  let rawTaskProcessorError = null;
  let activeRawTaskCount = 0;
  let rawTaskProgressResolvers = [];

  const resolveRawTaskProgressWaiters = () => {
    const resolvers = rawTaskProgressResolvers;
    rawTaskProgressResolvers = [];
    for (const resolve of resolvers) {
      resolve();
    }
  };

  const waitForRawTaskProgress = () =>
    new Promise((resolve) => {
      rawTaskProgressResolvers.push(resolve);
    });

  const pendingRawTaskCount = () => queuedRawTaskPaths.length + activeRawTaskCount;

  const maybeThrowRawTaskProcessorError = () => {
    if (rawTaskProcessorError) {
      throw rawTaskProcessorError;
    }
  };

  const enqueueRawTaskPath = (rawPath) => {
    if (!rawPath || queuedRawTaskPathSet.has(rawPath)) return;
    queuedRawTaskPathSet.add(rawPath);
    queuedRawTaskPaths.push(rawPath);
  };

  const recordValidatedRowsForMerges = (task, validatedRows) => {
    if (!validatedRows.length) return;
    const bucket = rowsForMergeByKey.get(task.plan.mergeKey) || [];
    bucket.push(...validatedRows);
    rowsForMergeByKey.set(task.plan.mergeKey, bucket);
    if (!writeIntermediateMerges) return;
    const mergePlan = mergePlansByKey.get(task.plan.mergeKey);
    const middleState = rowsForIntermediateMergeByKey.get(task.plan.mergeKey) || {
      rows: [],
      pageFileCount: 0,
      batchIndex: 0,
    };
    middleState.rows.push(...validatedRows);
    middleState.pageFileCount += 1;
    rowsForIntermediateMergeByKey.set(task.plan.mergeKey, middleState);
    if (mergePlan && middleState.pageFileCount >= intermediateMergeCount) {
      writeIntermediateMergedJson(mergePlan);
    }
  };

  const processPendingRawTask = async (rawPath) => {
    const task = JSON.parse(fs.readFileSync(rawPath, "utf8"));
    const validatedRows = await enrichRowsWithValidatedEmails(
      Array.isArray(task?.rows) ? task.rows : [],
      task?.pageNum,
      task?.plan
    );

    if (validatedRows.length > 0) {
      const outPath = buildValidatedPageOutputPath(task);
      fs.writeFileSync(
        outPath,
        buildJson(validatedRows, { searchRole: task?.plan?.role }),
        "utf8"
      );
      console.log(
        `[contactout-bot] Finalized page ${task.pageNum}${task?.plan?.role ? ` role=${task.plan.role}` : ""}${task?.plan?.gender ? ` gender=${task.plan.gender}` : ""}: wrote ${validatedRows.length} validated row(s) -> ${outPath}`
      );
      recordValidatedRowsForMerges(task, validatedRows);
    } else {
      console.log(
        `[contactout-bot] Page ${task?.pageNum} produced no validated emails after deferred enrichment; JSON file not written.`
      );
    }

    fs.unlinkSync(rawPath);
  };

  const startRawTaskProcessor = () => {
    if (rawTaskProcessorPromise) return rawTaskProcessorPromise;
    rawTaskProcessorPromise = (async () => {
      try {
        while (queuedRawTaskPaths.length > 0) {
          const rawPath = queuedRawTaskPaths.shift();
          if (!rawPath) continue;
          queuedRawTaskPathSet.delete(rawPath);
          if (!fs.existsSync(rawPath)) {
            resolveRawTaskProgressWaiters();
            continue;
          }
          activeRawTaskCount += 1;
          try {
            await processPendingRawTask(rawPath);
          } finally {
            activeRawTaskCount = Math.max(0, activeRawTaskCount - 1);
            resolveRawTaskProgressWaiters();
          }
        }
      } catch (error) {
        rawTaskProcessorError = error;
        resolveRawTaskProgressWaiters();
      } finally {
        rawTaskProcessorPromise = null;
      }
    })();
    return rawTaskProcessorPromise;
  };

  const queuePendingRawTasksFromDisk = () => {
    const pendingRawTasks = collectPendingRawTaskPaths();
    for (const rawPath of pendingRawTasks) {
      enqueueRawTaskPath(rawPath);
    }
    return pendingRawTasks.length;
  };

  const kickRawTaskProcessor = () => {
    maybeThrowRawTaskProcessorError();
    if (pendingRawTaskCount() === 0) return;
    startRawTaskProcessor();
  };

  const maybeApplyRawTaskBackpressure = async (reason = "") => {
    maybeThrowRawTaskProcessorError();
    if (pendingRawTaskCount() < rawTaskBacklogMax) return;
    console.log(
      `[contactout-bot] Raw validation backlog reached ${pendingRawTaskCount()} task(s)${reason ? ` (${reason})` : ""}; waiting for it to drain below ${rawTaskBacklogResumeThreshold || 0}.`
    );
    kickRawTaskProcessor();
    while (pendingRawTaskCount() > rawTaskBacklogResumeThreshold) {
      await waitForRawTaskProgress();
      maybeThrowRawTaskProcessorError();
      if (!rawTaskProcessorPromise && pendingRawTaskCount() > 0) {
        kickRawTaskProcessor();
      }
    }
  };

  const drainPendingRawTasks = async () => {
    maybeThrowRawTaskProcessorError();
    while (true) {
      if (!rawTaskProcessorPromise && pendingRawTaskCount() === 0) {
        break;
      }
      kickRawTaskProcessor();
      if (rawTaskProcessorPromise) {
        await rawTaskProcessorPromise;
      } else {
        await waitForRawTaskProgress();
      }
      maybeThrowRawTaskProcessorError();
      if (!rawTaskProcessorPromise && pendingRawTaskCount() === 0) {
        break;
      }
    }
  };

  const primePendingRawTasks = () => {
    const pendingRawTaskCountOnDisk = queuePendingRawTasksFromDisk();
    if (pendingRawTaskCountOnDisk > 0) {
      console.log(
        `[contactout-bot] Resuming ${pendingRawTaskCountOnDisk} deferred raw page task(s)${workerSlot ? ` for ${workerSlotDisplay(workerSlot)}` : ""}.`
      );
      kickRawTaskProcessor();
    }
  };

  const runSearchPlan = async (plan) => {
    const searchBaseUrl = normalizeSearchBaseUrl(plan.searchUrlRaw);
    const searchId = searchIdFromBaseUrl(searchBaseUrl);
    const exportNameSuffix = plan.exportNameSuffix;
    const exportFolderParts = buildExportFolderParts({
      country: plan.country,
      role: plan.role,
      gender: plan.gender,
      years: plan.years,
      totalYears: plan.totalYears,
      employeeSize: plan.employeeSize,
      revenueMin: plan.revenueMin,
      revenueMax: plan.revenueMax,
      industry: plan.industry,
    });
    const firstUrl = buildSearchUrlWithPage(searchBaseUrl, startPage);
    console.log(
      `[contactout-bot] Starting search${plan.role ? ` (role=${plan.role})` : ""}${plan.gender ? ` (gender=${plan.gender})` : ""}: ${searchBaseUrl}`
    );
    await gotoWith429Retry(
      firstUrl,
      `first search page${plan.role ? ` role=${plan.role}` : ""}${plan.gender ? ` gender=${plan.gender}` : ""}`
    );

    if (pathnameLooksLikeLogin(page.url())) {
      console.log("[contactout-bot] Not logged in; signing inвЂ¦");
      await login(page, currentEmail(), accountPassword);
      await gotoWith429Retry(firstUrl, "after login");
      loggedIn = true;
    } else if (!loggedIn) {
      console.log("[contactout-bot] Already logged in; continuing with search.");
      loggedIn = true;
    }

    if (rotator) await persistSession();

    if (!urlHasLocationParam(searchBaseUrl)) {
      await setLocationUnitedStates(page, plan.location);
      if (rotator) await persistSession();
    }

    const reloadFirstSearchPage = async () => {
      await gotoWith429Retry(
        firstUrl,
        `first search page retry${plan.role ? ` role=${plan.role}` : ""}${plan.gender ? ` gender=${plan.gender}` : ""}`
      );
      if (pathnameLooksLikeLogin(page.url())) {
        await login(page, currentEmail(), accountPassword);
        await gotoWith429Retry(firstUrl, "after re-login first search page");
        if (rotator) await persistSession();
      }
    };

    const readProfileCountFromHealthyFirstPage = async () => {
      for (let attempt = 0; attempt <= emptyPageRetryMax; attempt++) {
        if (attempt > 0) {
          await reloadFirstSearchPage();
          await sleepRandom(pageSettleDelayMinMs, pageSettleDelayMaxMs);
        }

        const profileCount = await extractProfileCount(page);
        if (profileCount) return profileCount;

        const rows = await scrapeCurrentPageRows(page, plan.role);
        const pageState = await inspectSearchPageState(page);
        const looksLikeLogin =
          pathnameLooksLikeLogin(page.url()) || pageState.hasPasswordInput;
        const suspicious =
          pageState.blocked || looksLikeLogin || (!pageState.noResults && rows.length === 0);

        if (attempt < emptyPageRetryMax && (suspicious || rows.length > 0)) {
          console.warn(
            `[contactout-bot] Profile count not readable on first page; retry ${attempt + 1}/${emptyPageRetryMax}.`
          );
          if (suspicious && (pageState.blocked || looksLikeLogin)) {
            await rotateAccountProxyPair("blocked first search page", {
              clearSession: true,
              penalizeCurrentProxyMs: proxyBlockedCooldownMs,
              removeCurrentAccount: true,
            });
          } else if (suspicious) {
            rotator?.markCooldown(proxyFailureCooldownMs, "incomplete first search page");
            await recreateProxyContext("incomplete first search page", {
              clearSession: false,
              advanceProxy: Boolean(rotator),
            });
          } else {
            await sleep(backoff429);
          }
          continue;
        }

        return null;
      }

      return null;
    };

    const profileCount = await readProfileCountFromHealthyFirstPage();
    if (profileCount) {
      console.log(
        `[contactout-bot] Profile count${plan.role ? ` for role=${plan.role}` : ""}${plan.gender ? ` gender=${plan.gender}` : ""}${plan.years ? ` years=${plan.years}` : ""}${plan.totalYears ? ` totalYears=${plan.totalYears}` : ""}${plan.employeeSize ? ` employeeSize=${plan.employeeSize}` : ""}${plan.revenueMin || plan.revenueMax ? ` revenue=${plan.revenueMin || "min"}-${plan.revenueMax || "plus"}` : ""}${plan.industry ? ` industry=${plan.industry}` : ""}: ${profileCount.total} (${profileCount.summary})`
      );
    } else {
      console.warn(
        `[contactout-bot] Profile count${plan.role ? ` for role=${plan.role}` : ""}${plan.gender ? ` gender=${plan.gender}` : ""}${plan.years ? ` years=${plan.years}` : ""}${plan.totalYears ? ` totalYears=${plan.totalYears}` : ""}${plan.employeeSize ? ` employeeSize=${plan.employeeSize}` : ""}${plan.revenueMin || plan.revenueMax ? ` revenue=${plan.revenueMin || "min"}-${plan.revenueMax || "plus"}` : ""}${plan.industry ? ` industry=${plan.industry}` : ""}: not found after first-page retries; proceeding without priority split`
      );
    }

    if (
      profileCount &&
      profileCount.total > searchProfileThreshold &&
      !plan.years &&
      searchYearsList.length > 0
    ) {
      console.log(
        `[contactout-bot] gender=${plan.gender} has ${profileCount.total} profiles (> ${searchProfileThreshold}); splitting by years: ${searchYearsList.join(", ")}`
      );
      for (const years of searchYearsList) {
        await runSearchPlan({
          ...plan,
          searchUrlRaw: setSearchParam(searchBaseUrl, "years", years),
          exportNameSuffix: buildExportNameSuffix({
            country: plan.country,
            role: plan.role,
            gender: plan.gender,
            years,
          }),
          years: String(years).trim(),
        });
      }
      return;
    }

    if (
      profileCount &&
      profileCount.total > searchProfileThreshold &&
      !plan.employeeSize &&
      searchEmployeeSizeList.length > 0 &&
      (
        plan.totalYears ||
        (plan.years && !searchTotalYearsList.length) ||
        (!plan.years && !searchYearsList.length && !searchTotalYearsList.length)
      )
    ) {
      console.log(
        `[contactout-bot]${plan.gender ? ` gender=${plan.gender}` : ""}${plan.years ? ` years=${plan.years}` : ""}${plan.totalYears ? ` totalYears=${plan.totalYears}` : ""} has ${profileCount.total} profiles (> ${searchProfileThreshold}); splitting by employee_size: ${searchEmployeeSizeList.join(", ")}`
      );
      for (const employeeSize of searchEmployeeSizeList) {
        await runSearchPlan({
          ...plan,
          searchUrlRaw: setSearchParam(searchBaseUrl, "employee_size", employeeSize),
          exportNameSuffix: buildExportNameSuffix({
            country: plan.country,
            role: plan.role,
            gender: plan.gender,
            years: plan.years,
            totalYears: plan.totalYears,
            employeeSize,
          }),
          employeeSize: String(employeeSize).trim(),
        });
      }
      return;
    }

    if (
      profileCount &&
      profileCount.total > searchProfileThreshold &&
      !plan.totalYears &&
      searchTotalYearsList.length > 0 &&
      (plan.years || !searchYearsList.length)
    ) {
      console.log(
        `[contactout-bot]${plan.gender ? ` gender=${plan.gender}` : ""}${plan.years ? ` years=${plan.years}` : ""} has ${profileCount.total} profiles (> ${searchProfileThreshold}); splitting by totalYears: ${searchTotalYearsList.join(", ")}`
      );
      for (const totalYears of searchTotalYearsList) {
        await runSearchPlan({
          ...plan,
          searchUrlRaw: setSearchParam(searchBaseUrl, "totalYears", totalYears),
          exportNameSuffix: buildExportNameSuffix({
            country: plan.country,
            role: plan.role,
            gender: plan.gender,
            years: plan.years,
            totalYears,
          }),
          totalYears: String(totalYears).trim(),
        });
      }
      return;
    }

    if (
      profileCount &&
      profileCount.total > searchProfileThreshold &&
      !(plan.revenueMin || plan.revenueMax) &&
      searchRevenueRanges.length > 0 &&
      (
        plan.employeeSize ||
        (plan.totalYears && !searchEmployeeSizeList.length) ||
        (plan.years && !searchTotalYearsList.length && !searchEmployeeSizeList.length) ||
        (!plan.years && !searchYearsList.length && !searchTotalYearsList.length && !searchEmployeeSizeList.length)
      )
    ) {
      console.log(
        `[contactout-bot]${plan.gender ? ` gender=${plan.gender}` : ""}${plan.years ? ` years=${plan.years}` : ""}${plan.totalYears ? ` totalYears=${plan.totalYears}` : ""}${plan.employeeSize ? ` employeeSize=${plan.employeeSize}` : ""} has ${profileCount.total} profiles (> ${searchProfileThreshold}); splitting by revenue: ${searchRevenueRanges.map((range) => `${range.revenueMin || "min"}-${range.revenueMax || "plus"}`).join(", ")}`
      );
      for (const range of searchRevenueRanges) {
        let nextUrl = searchBaseUrl;
        nextUrl = setSearchParam(nextUrl, "revenue_min", range.revenueMin);
        nextUrl = setSearchParam(nextUrl, "revenue_max", range.revenueMax);
        await runSearchPlan({
          ...plan,
          searchUrlRaw: nextUrl,
          exportNameSuffix: buildExportNameSuffix({
            country: plan.country,
            role: plan.role,
            gender: plan.gender,
            years: plan.years,
            totalYears: plan.totalYears,
            employeeSize: plan.employeeSize,
            revenueMin: range.revenueMin,
            revenueMax: range.revenueMax,
          }),
          revenueMin: range.revenueMin,
          revenueMax: range.revenueMax,
        });
      }
      return;
    }

    if (
      profileCount &&
      profileCount.total > searchProfileThreshold &&
      !plan.industry &&
      searchIndustryList.length > 0 &&
      (
        (plan.revenueMin || plan.revenueMax) ||
        (plan.employeeSize && !searchRevenueRanges.length) ||
        (plan.totalYears && !searchEmployeeSizeList.length && !searchRevenueRanges.length) ||
        (plan.years && !searchTotalYearsList.length && !searchEmployeeSizeList.length && !searchRevenueRanges.length) ||
        (!plan.years && !searchYearsList.length && !searchTotalYearsList.length && !searchEmployeeSizeList.length && !searchRevenueRanges.length)
      )
    ) {
      console.log(
        `[contactout-bot]${plan.gender ? ` gender=${plan.gender}` : ""}${plan.years ? ` years=${plan.years}` : ""}${plan.totalYears ? ` totalYears=${plan.totalYears}` : ""}${plan.employeeSize ? ` employeeSize=${plan.employeeSize}` : ""}${plan.revenueMin || plan.revenueMax ? ` revenue=${plan.revenueMin || "min"}-${plan.revenueMax || "plus"}` : ""} has ${profileCount.total} profiles (> ${searchProfileThreshold}); splitting by industry: ${searchIndustryList.join(", ")}`
      );
      for (const industry of searchIndustryList) {
        await runSearchPlan({
          ...plan,
          searchUrlRaw: setSearchParam(searchBaseUrl, "industry", industry),
          exportNameSuffix: buildExportNameSuffix({
            country: plan.country,
            role: plan.role,
            gender: plan.gender,
            years: plan.years,
            totalYears: plan.totalYears,
            employeeSize: plan.employeeSize,
            revenueMin: plan.revenueMin,
            revenueMax: plan.revenueMax,
            industry,
          }),
          industry: String(industry).trim(),
        });
      }
      return;
    }

    const gotoSearchPage = async (pageNum) => {
      const urlThis = buildSearchUrlWithPage(searchBaseUrl, pageNum);
      await gotoWith429Retry(urlThis, `result page=${pageNum}`);
      if (pathnameLooksLikeLogin(page.url())) {
        console.log(
          "[contactout-bot] On login page (e.g. after 429 session reset); signing in againвЂ¦"
        );
        await login(page, currentEmail(), accountPassword);
        await gotoWith429Retry(urlThis, `after re-login page=${pageNum}`);
        if (rotator) await persistSession();
      }
    };

    let lastPaginationFingerprint = "";

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
        await sleepRandom(pageSettleDelayMinMs, pageSettleDelayMaxMs);

        const rows = await scrapeCurrentPageRows(page, plan.role);
        if (rows.length === 0) {
          const pageState = await inspectSearchPageState(page);
          const looksLikeLogin =
            pathnameLooksLikeLogin(page.url()) || pageState.hasPasswordInput;
          const suspiciousEmpty = pageState.blocked || looksLikeLogin || !pageState.noResults;

          if (suspiciousEmpty && attempt < emptyPageRetryMax) {
            console.warn(
              `[contactout-bot] Page ${pageNum} returned 0 rows but looks blocked/incomplete; retry ${attempt + 1}/${emptyPageRetryMax}.`
            );
            if (pageState.blocked || looksLikeLogin) {
              await rotateAccountProxyPair("blocked/empty result page", {
                clearSession: true,
                penalizeCurrentProxyMs: proxyBlockedCooldownMs,
                removeCurrentAccount: true,
              });
            } else {
              rotator?.markCooldown(proxyFailureCooldownMs, "empty/incomplete result page");
              await recreateProxyContext("empty/incomplete result page", {
                clearSession: false,
                advanceProxy: Boolean(rotator),
              });
              if (!rotator) {
                await sleep(backoff429);
              }
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
              `Not writing JSON. Update SEARCH_COUNTRY_LIST, CONTACTOUT_LOCATION, SEARCH_PROFILE / --random-search (search_keywords.json), or CONTACTOUT_SEARCH_URL / filters for a new slice of results, then re-run (or set STOP_ON_DUPLICATE_PAGE=0 to ignore).`
          );
          return { duplicate: true, rows };
        }
        lastPaginationFingerprint = fp;

        const rawTaskPath = writeRawPageTask(plan, searchId, pageNum, urlThis, rows);
        enqueueRawTaskPath(rawTaskPath);
        kickRawTaskProcessor();
        if (!ignoreSearchHistory) {
          markPageCompleted(history, searchId, searchBaseUrl, pageNum);
          saveSearchHistory(historyPath, history);
        }
        await maybeApplyRawTaskBackpressure(
          `page ${pageNum}${plan.role ? ` role=${plan.role}` : ""}${plan.gender ? ` gender=${plan.gender}` : ""}`
        );
        await noteSuccessfulPageExport(
          `page ${pageNum}${plan.role ? ` role=${plan.role}` : ""}${plan.gender ? ` gender=${plan.gender}` : ""}`
        );
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
      console.log(
        `[contactout-bot] Finished page range (MAX_PAGES=${maxPages})${plan.role ? ` for role=${plan.role}` : ""}${plan.gender ? ` gender=${plan.gender}` : ""}.`
      );
    }
  };

  try {
    primePendingRawTasks();

    for (const plan of searchPlans) {
      await runSearchPlan(plan);
    }

    await drainPendingRawTasks();

    if (writeIntermediateMerges) {
      for (const mergePlan of mergePlans) {
        writeIntermediateMergedJson(mergePlan, "final-flush");
      }
    }

    if (mergeJson) {
      let wroteMergedOutput = false;
      for (const mergePlan of mergePlans) {
        const rowsForMerge = rowsForMergeByKey.get(mergePlan.mergeKey) || [];
        if (rowsForMerge.length === 0) continue;
        const merged = dedupeRowsByLinkedin(rowsForMerge);
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
        const mergedPath = path.join(
          mergePlan.mergedDir,
          `contactout-merged-${mergePlan.mergedSearchId.slice(0, 8)}${mergePlan.mergedExportNameSuffix}-items-${merged.length}-${stamp}.json`
        );
        fs.writeFileSync(
          mergedPath,
          buildJson(merged, { searchRole: mergePlan.role }),
          "utf8"
        );
        console.log(
          `[contactout-bot] Merged ${rowsForMerge.length} row(s) for ${mergePlan.role || "default role"} -> ${merged.length} unique -> ${mergedPath}`
        );
        wroteMergedOutput = true;
      }
      if (!wroteMergedOutput) {
        console.log(
          "[contactout-bot] No new rows this run; merged JSON not written."
        );
      }
    }
    return;

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
