#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { request as apiRequest } from "playwright";
import {
  LEGACY_PROXIES_FILE_PATH,
  loadProxyConfig,
  normalizeWorkerGender,
  normalizeWorkerSlot,
} from "./workerConfig.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONSTANTS_CONFIG_PATH = path.join(ROOT, "ref", "constants.js");
const DEFAULT_PROXY_FILE = LEGACY_PROXIES_FILE_PATH;

function isEnvFalseLike(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "no";
}

async function loadConstantsConfig() {
  if (!fs.existsSync(CONSTANTS_CONFIG_PATH)) return {};
  const mod = await import(pathToFileURL(CONSTANTS_CONFIG_PATH).href);
  return mod?.default && typeof mod.default === "object" ? mod.default : {};
}

function coalesceSetting(name, constants, fallback = "") {
  const envValue = process.env[name];
  if (envValue !== undefined && String(envValue).trim() !== "") {
    return String(envValue).trim();
  }
  const constantValue = constants?.[name];
  if (constantValue !== undefined && constantValue !== null) {
    return typeof constantValue === "string"
      ? constantValue.trim()
      : String(constantValue).trim();
  }
  return fallback;
}

function coalesceBooleanSetting(name, constants, fallback) {
  const envValue = process.env[name];
  if (envValue !== undefined && String(envValue).trim() !== "") {
    return !isEnvFalseLike(envValue);
  }
  const constantValue = constants?.[name];
  if (constantValue !== undefined && constantValue !== null && `${constantValue}` !== "") {
    return !isEnvFalseLike(constantValue);
  }
  return fallback;
}

function coalesceIntegerSetting(name, constants, fallback, floor = 0) {
  const raw = coalesceSetting(name, constants, "");
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(floor, parsed);
}

function resolveProxyFilePath(rootDir, constants) {
  const configured = coalesceSetting("PROXIES_FILE", constants, "");
  if (!configured) return DEFAULT_PROXY_FILE;
  return path.isAbsolute(configured)
    ? configured
    : path.resolve(rootDir, configured);
}

function cleanProxyToken(value) {
  let s = String(value || "").trim().replace(/^\uFEFF/, "");
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

function parseProxiesRawBlock(raw) {
  if (raw === undefined || !String(raw).trim()) return [];
  const s = String(raw).trim();

  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => cleanProxyToken(item)).filter(Boolean);
    }
  } catch {
    /* not strict JSON */
  }

  let inner = s;
  if (inner.startsWith("[") && inner.endsWith("]")) {
    inner = inner.slice(1, -1).trim();
  }

  return inner
    .split(/[\r\n,]+/)
    .map((item) => cleanProxyToken(item))
    .filter(Boolean);
}

function dedupePreserveOrder(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const value = String(item || "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

async function collectProxyLinesFromConfiguredSources(rootDir, constants) {
  const outputPath = resolveProxyFilePath(rootDir, constants);
  const sources = [];
  const lines = [];

  const pushBlock = (label, raw) => {
    const parsed = dedupePreserveOrder(parseProxiesRawBlock(raw));
    if (!parsed.length) return;
    sources.push({ label, count: parsed.length });
    lines.push(...parsed);
  };

  if (fs.existsSync(outputPath)) {
    pushBlock(outputPath, fs.readFileSync(outputPath, "utf8"));
  }

  const workerGender = normalizeWorkerGender(process.env.CONTACTOUT_WORKER_GENDER);
  const workerSlot = normalizeWorkerSlot(process.env.CONTACTOUT_WORKER_SLOT);
  const proxyConfig = await loadProxyConfig({
    fresh: true,
    workerSlot,
    workerGender,
  });
  if (proxyConfig.proxyLines.length) {
    pushBlock(
      `${proxyConfig.source}${workerGender ? `#${workerGender}` : ""}`,
      JSON.stringify(proxyConfig.proxyLines)
    );
  }

  const proxiesEnv = process.env.PROXIES?.trim();
  if (proxiesEnv) {
    pushBlock("PROXIES", proxiesEnv);
  }

  const proxyListFile = process.env.PROXY_LIST_FILE?.trim();
  if (proxyListFile) {
    const resolvedListFile = path.isAbsolute(proxyListFile)
      ? proxyListFile
      : path.resolve(rootDir, proxyListFile);
    if (fs.existsSync(resolvedListFile)) {
      pushBlock(resolvedListFile, fs.readFileSync(resolvedListFile, "utf8"));
    }
  }

  const proxyList = process.env.PROXY_LIST?.trim();
  if (proxyList) {
    pushBlock("PROXY_LIST", proxyList);
  }

  const proxyUrl = process.env.PROXY_URL?.trim();
  if (proxyUrl) {
    pushBlock("PROXY_URL", proxyUrl);
  }

  return {
    outputPath,
    lines: dedupePreserveOrder(lines),
    sources,
  };
}

function toPlaywrightProxy(raw) {
  let s = cleanProxyToken(raw);
  if (!s) {
    throw new Error("Empty proxy string");
  }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    s = `http://${s}`;
  }
  const url = new URL(s);
  const port =
    url.port || (String(url.protocol).startsWith("socks") ? "1080" : "80");
  const proxy = {
    server: `${url.protocol}//${url.hostname}:${port}`,
  };
  if (url.username) proxy.username = decodeURIComponent(url.username);
  if (url.password) proxy.password = decodeURIComponent(url.password);
  return proxy;
}

function proxyHealthCheckEnabled(constants) {
  return coalesceBooleanSetting("PROXY_HEALTH_CHECK", constants, false);
}

function proxyHealthCheckUrl(constants) {
  return coalesceSetting(
    "PROXY_HEALTH_CHECK_URL",
    constants,
    "https://www.google.com/generate_204"
  );
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

function proxyHealthTimeoutMs(constants) {
  return coalesceIntegerSetting(
    "PROXY_HEALTH_TIMEOUT_MS",
    constants,
    15_000,
    1_000
  );
}

function proxyHealthIgnoreTls(constants) {
  return coalesceBooleanSetting("PROXY_HEALTH_IGNORE_TLS", constants, false);
}

async function validateProxyLine(proxyLine, options = {}) {
  const constants = options.constants || {};
  const timeout = options.timeout ?? proxyHealthTimeoutMs(constants);
  const url = options.url || proxyHealthCheckUrl(constants);
  const startedAt = Date.now();

  /** @type {import("playwright").APIRequestContext | null} */
  let ctx = null;
  try {
    ctx = await apiRequest.newContext({
      proxy: toPlaywrightProxy(proxyLine),
      timeout,
      ignoreHTTPSErrors: proxyHealthIgnoreTls(constants),
    });
    const response = await ctx.get(url, { timeout });
    const blockedByTarget = isRateLimitedHealthProbe(url, response.status());
    return {
      proxyLine,
      ok: response.ok() || blockedByTarget,
      status: response.status(),
      elapsedMs: Date.now() - startedAt,
      error:
        response.ok() || blockedByTarget
          ? ""
          : `HTTP ${response.status()}`,
    };
  } catch (error) {
    return {
      proxyLine,
      ok: false,
      status: 0,
      elapsedMs: Date.now() - startedAt,
      error: String(error?.message || error || "Unknown proxy validation error"),
    };
  } finally {
    if (ctx) {
      await ctx.dispose().catch(() => {});
    }
  }
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

export async function validateProxyLines(lines, options = {}) {
  const constants = options.constants || (await loadConstantsConfig());
  const enabled = options.enabled ?? proxyHealthCheckEnabled(constants);
  if (!enabled) {
    return {
      skipped: true,
      reason: "PROXY_HEALTH_CHECK disabled",
      healthyLines: dedupePreserveOrder(lines),
      unhealthy: [],
      results: [],
    };
  }

  const logger = options.logger || console;
  const timeout = options.timeout ?? proxyHealthTimeoutMs(constants);
  const url = options.url || proxyHealthCheckUrl(constants);
  const concurrency = options.concurrency ?? coalesceIntegerSetting(
    "PROXY_VALIDATE_CONCURRENCY",
    constants,
    5,
    1
  );
  const dedupedLines = dedupePreserveOrder(lines);

  logger.log(
    `[proxy-utils] Validating ${dedupedLines.length} proxy endpoint(s) via ${url} (timeout=${timeout}ms, concurrency=${concurrency})`
  );

  const results = await mapWithConcurrency(dedupedLines, concurrency, (line) =>
    validateProxyLine(line, { constants, timeout, url })
  );
  const healthyLines = results.filter((result) => result.ok).map((result) => result.proxyLine);
  const unhealthy = results.filter((result) => !result.ok);

  for (const bad of unhealthy) {
    logger.warn(
      `[proxy-utils] Reject ${bad.proxyLine} (${bad.error || "unreachable"})`
    );
  }

  logger.log(
    `[proxy-utils] Validation kept ${healthyLines.length}/${dedupedLines.length} proxy endpoint(s)`
  );

  return {
    skipped: false,
    healthyLines,
    unhealthy,
    results,
  };
}

export async function refreshProxyFileFromLocalList(options = {}) {
  const constants = options.constants || (await loadConstantsConfig());
  const rootDir = options.rootDir || ROOT;
  const logger = options.logger || console;
  const configured = await collectProxyLinesFromConfiguredSources(rootDir, constants);
  const outputPath = options.outputPath || configured.outputPath;
  const lines = configured.lines;

  if (!lines.length) {
    return {
      skipped: true,
      reason: `No proxies found in configured sources for ${outputPath}`,
      outputPath,
      healthyLines: [],
    };
  }

  if (configured.sources.length) {
    logger.log(
      `[proxy-utils] Loaded ${lines.length} unique proxy endpoint(s) from ${configured.sources.map((source) => `${source.label} (${source.count})`).join(", ")}`
    );
  }

  const validation = await validateProxyLines(lines, {
    constants,
    logger,
    enabled:
      options.validateOnRefresh ?? coalesceBooleanSetting(
        "PROXY_VALIDATE_ON_START",
        constants,
        true
      ),
  });

  const linesToWrite = validation.skipped ? lines : validation.healthyLines;
  if (!linesToWrite.length) {
    throw new Error(
      "Proxy validation produced 0 healthy proxy endpoints; keeping the existing proxy file unchanged."
    );
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${linesToWrite.join("\n")}${linesToWrite.length ? "\n" : ""}`, "utf8");

  logger.log(
    `[proxy-utils] Wrote ${linesToWrite.length}/${lines.length} healthy proxy endpoint(s) -> ${outputPath}`
  );

  return {
    skipped: false,
    outputPath,
    originalLines: lines,
    healthyLines: linesToWrite,
    validation,
  };
}

export async function maybeRefreshProxyFileFromLocalList(options = {}) {
  const constants = options.constants || (await loadConstantsConfig());
  const enabled = options.enabled ?? coalesceBooleanSetting(
    "PROXY_VALIDATE_ON_START",
    constants,
    true
  );
  if (!enabled) {
    return { skipped: true, reason: "PROXY_VALIDATE_ON_START disabled", constants };
  }
  return refreshProxyFileFromLocalList({
    ...options,
    constants,
  });
}

async function main() {
  await refreshProxyFileFromLocalList();
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((error) => {
    console.error(`[proxy-utils] ${error?.message || error}`);
    process.exitCode = 1;
  });
}
