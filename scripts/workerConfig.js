import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, "..");
export const EMAILS_CONFIG_PATH = path.join(ROOT, "ref", "emails.js");
export const PROXIES_CONFIG_PATH = path.join(ROOT, "ref", "proxies.js");
export const LEGACY_PROXIES_FILE_PATH = path.join(ROOT, "ref", "proxies.txt");
export const WORKER_GENDERS = ["male", "female", "unknown"];
export const WORKER_SLOT_LABELS = ["first", "second", "third"];

export function normalizeWorkerGender(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return WORKER_GENDERS.includes(normalized) ? normalized : "";
}

export function normalizeWorkerSlot(value) {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value >= 1 && value <= WORKER_SLOT_LABELS.length ? value : 0;
  }
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= WORKER_SLOT_LABELS.length) {
    return parsed;
  }
  const labelIndex = WORKER_SLOT_LABELS.indexOf(raw);
  return labelIndex >= 0 ? labelIndex + 1 : 0;
}

export function workerSlotLabel(slot) {
  const normalized = normalizeWorkerSlot(slot);
  return normalized ? WORKER_SLOT_LABELS[normalized - 1] : "";
}

function normalizeStringList(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const item = String(value ?? "").trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

async function importFreshModule(modulePath, fresh = false) {
  if (!fs.existsSync(modulePath)) return null;
  const ref = pathToFileURL(modulePath);
  if (fresh) {
    ref.searchParams.set("t", String(Date.now()));
  }
  return import(ref.href);
}

function readFirstArrayBinding(mod, bindingNames) {
  for (const bindingName of bindingNames) {
    if (Array.isArray(mod?.[bindingName])) {
      return {
        bindingName,
        values: normalizeStringList(mod[bindingName]),
      };
    }
  }
  return {
    bindingName: bindingNames[0] || "",
    values: [],
  };
}

function emailBindingNamesForSlot(slot) {
  switch (normalizeWorkerSlot(slot)) {
    case 1:
      return ["EMAIL_USER_FIRST_LIST"];
    case 2:
      return ["EMAIL_USER_SECOND_LIST"];
    case 3:
      return ["EMAIL_USER_THIRD_LIST"];
    default:
      return ["EMAIL_USER_LIST"];
  }
}

function proxyBindingNamesForSlot(slot) {
  switch (normalizeWorkerSlot(slot)) {
    case 1:
      return ["PROXIES_FIRST_LIST"];
    case 2:
      return ["PROXIES_SECOND_LIST"];
    case 3:
      return ["PROXIES_THIRD_LIST"];
    default:
      return ["PROXIES_LIST"];
  }
}

function formatArrayBindingSource(values) {
  const normalized = normalizeStringList(values);
  if (!normalized.length) return "[]";
  return `[\n${normalized.map((value) => `  ${JSON.stringify(value)}`).join(",\n")}\n]`;
}

function replaceExistingArrayBinding(raw, bindingName, values) {
  const replacement = `export const ${bindingName} = ${formatArrayBindingSource(values)};`;
  const marker = `export const ${bindingName}`;
  const start = raw.indexOf(marker);
  if (start < 0) return null;
  const tail = raw.slice(start);
  const pattern = new RegExp(`^export const ${bindingName}\\s*=\\s*\\[(.*?)\\]\\s*;?`, "s");
  const match = tail.match(pattern);
  if (!match) return null;
  const before = raw.slice(0, start);
  const after = raw.slice(start + match[0].length);
  const needsLeadingNewline =
    before.length > 0 && !before.endsWith("\n") && !before.endsWith("\r");
  const needsTrailingNewline =
    after.length > 0 && !after.startsWith("\n") && !after.startsWith("\r");
  return `${before}${needsLeadingNewline ? "\n" : ""}${replacement}${needsTrailingNewline ? "\n" : ""}${after}`;
}

function replaceOrAppendArrayBinding(raw, bindingName, values) {
  const replaced = replaceExistingArrayBinding(raw, bindingName, values);
  if (replaced != null) {
    return replaced;
  }
  const replacement = `export const ${bindingName} = ${formatArrayBindingSource(values)};`;
  const suffix = raw.endsWith("\n") ? "" : "\n";
  return `${raw}${suffix}\n${replacement}\n`;
}

export async function inspectEmailPools(options = {}) {
  const mod = await importFreshModule(EMAILS_CONFIG_PATH, Boolean(options.fresh));
  if (!mod) {
    return {
      source: "",
      password: "",
      generic: [],
      first: [],
      second: [],
      third: [],
      hasGenderSpecific: false,
      hasSlotSpecific: false,
    };
  }

  const generic = normalizeStringList(mod.EMAIL_USER_LIST);
  const first = readFirstArrayBinding(mod, emailBindingNamesForSlot(1)).values;
  const second = readFirstArrayBinding(mod, emailBindingNamesForSlot(2)).values;
  const third = readFirstArrayBinding(mod, emailBindingNamesForSlot(3)).values;
  const password =
    typeof mod.CONTACTOUT_PASSWORD === "string"
      ? mod.CONTACTOUT_PASSWORD.trim()
      : "";

  return {
    source: EMAILS_CONFIG_PATH,
    password,
    generic,
    first,
    second,
    third,
    hasGenderSpecific: false,
    hasSlotSpecific: Boolean(first.length || second.length || third.length),
  };
}

export async function loadEmailConfig(options = {}) {
  const workerSlot = normalizeWorkerSlot(options.workerSlot);
  const info = await inspectEmailPools({ fresh: options.fresh });

  if (!info.source) {
    return {
      emailPool: [],
      password: "",
      source: "",
      bindingName: "EMAIL_USER_LIST",
      workerSlot,
      workerGender: "",
      hasGenderSpecific: false,
      hasSlotSpecific: false,
    };
  }

  if (workerSlot) {
    const mod = await importFreshModule(EMAILS_CONFIG_PATH, Boolean(options.fresh));
    const { bindingName, values } = readFirstArrayBinding(
      mod,
      emailBindingNamesForSlot(workerSlot)
    );
    return {
      emailPool: values,
      password: info.password,
      source: EMAILS_CONFIG_PATH,
      bindingName,
      workerSlot,
      workerGender: "",
      hasGenderSpecific: info.hasGenderSpecific,
      hasSlotSpecific: info.hasSlotSpecific,
    };
  }

  const aggregated = info.generic.length
    ? info.generic
    : normalizeStringList([
        ...info.first,
        ...info.second,
        ...info.third,
      ]);

  return {
    emailPool: aggregated,
    password: info.password,
    source: EMAILS_CONFIG_PATH,
    bindingName: info.generic.length
      ? "EMAIL_USER_LIST"
      : info.first.length
        ? "EMAIL_USER_FIRST_LIST"
        : "EMAIL_USER_LIST",
    workerSlot: 0,
    workerGender: "",
    hasGenderSpecific: info.hasGenderSpecific,
    hasSlotSpecific: info.hasSlotSpecific,
  };
}

export function saveEmailPoolToConfigFile(emailPool, options = {}) {
  const workerSlot = normalizeWorkerSlot(options.workerSlot);
  const bindingName =
    options.bindingName ||
    (workerSlot ? emailBindingNamesForSlot(workerSlot)[0] : "") ||
    "EMAIL_USER_LIST";
  const bindingCandidates = options.bindingName
    ? [options.bindingName]
    : workerSlot
      ? emailBindingNamesForSlot(workerSlot)
      : ["EMAIL_USER_LIST"];

  const raw = fs.readFileSync(EMAILS_CONFIG_PATH, "utf8");
  let next = raw;
  for (const candidate of bindingCandidates) {
    const pattern = new RegExp(`^export const ${candidate}\\s*=\\s*\\[(.*?)\\]\\s*;?`, "ms");
    if (pattern.test(next)) {
      next = replaceOrAppendArrayBinding(next, candidate, emailPool);
      fs.writeFileSync(EMAILS_CONFIG_PATH, next, "utf8");
      return;
    }
  }

  next = replaceOrAppendArrayBinding(next, bindingName, emailPool);
  fs.writeFileSync(EMAILS_CONFIG_PATH, next, "utf8");
}

export async function inspectProxyPools(options = {}) {
  const mod = await importFreshModule(PROXIES_CONFIG_PATH, Boolean(options.fresh));
  if (!mod) {
    return {
      source: "",
      generic: [],
      first: [],
      second: [],
      third: [],
      hasGenderSpecific: false,
      hasSlotSpecific: false,
    };
  }

  const generic = normalizeStringList(mod.PROXIES_LIST);
  const first = readFirstArrayBinding(mod, proxyBindingNamesForSlot(1)).values;
  const second = readFirstArrayBinding(mod, proxyBindingNamesForSlot(2)).values;
  const third = readFirstArrayBinding(mod, proxyBindingNamesForSlot(3)).values;

  return {
    source: PROXIES_CONFIG_PATH,
    generic,
    first,
    second,
    third,
    hasGenderSpecific: false,
    hasSlotSpecific: Boolean(first.length || second.length || third.length),
  };
}

export async function loadProxyConfig(options = {}) {
  const workerSlot = normalizeWorkerSlot(options.workerSlot);
  const info = await inspectProxyPools({ fresh: options.fresh });

  if (!info.source) {
    return {
      proxyLines: [],
      source: "",
      bindingName: "PROXIES_LIST",
      workerSlot,
      workerGender: "",
      hasGenderSpecific: false,
      hasSlotSpecific: false,
    };
  }

  if (workerSlot) {
    const mod = await importFreshModule(PROXIES_CONFIG_PATH, Boolean(options.fresh));
    const { bindingName, values } = readFirstArrayBinding(
      mod,
      proxyBindingNamesForSlot(workerSlot)
    );
    return {
      proxyLines: values,
      source: PROXIES_CONFIG_PATH,
      bindingName,
      workerSlot,
      workerGender: "",
      hasGenderSpecific: info.hasGenderSpecific,
      hasSlotSpecific: info.hasSlotSpecific,
    };
  }

  const aggregated = info.generic.length
    ? info.generic
    : normalizeStringList([
        ...info.first,
        ...info.second,
        ...info.third,
      ]);

  return {
    proxyLines: aggregated,
    source: PROXIES_CONFIG_PATH,
    bindingName: info.generic.length
      ? "PROXIES_LIST"
      : info.first.length
        ? "PROXIES_FIRST_LIST"
        : "PROXIES_LIST",
    workerSlot: 0,
    workerGender: "",
    hasGenderSpecific: info.hasGenderSpecific,
    hasSlotSpecific: info.hasSlotSpecific,
  };
}
