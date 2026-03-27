#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONSTANTS_CONFIG_PATH = path.join(ROOT, "ref", "constants.js");
const EMAILS_CONFIG_PATH = path.join(ROOT, "ref", "emails.js");
const STORAGE_STATE_PATH = path.join(ROOT, "playwright-user-data", "storage-state.json");
const OUTPUT_PATH = path.join(ROOT, "ref", "industry-list.json");

function normalizeGenderValue(value) {
  return String(value ?? "").trim().toLowerCase();
}

async function loadModuleDefaultObject(modulePath) {
  const mod = await import(pathToFileURL(modulePath).href);
  return mod?.default && typeof mod.default === "object" ? mod.default : {};
}

async function loadConstants() {
  if (!fs.existsSync(CONSTANTS_CONFIG_PATH)) return {};
  return loadModuleDefaultObject(CONSTANTS_CONFIG_PATH);
}

async function loadAccounts() {
  const mod = await import(pathToFileURL(EMAILS_CONFIG_PATH).href);
  const emailPool = Array.isArray(mod.EMAIL_USER_LIST)
    ? mod.EMAIL_USER_LIST.map((s) => String(s).trim()).filter(Boolean)
    : [];
  const password =
    typeof mod.CONTACTOUT_PASSWORD === "string"
      ? mod.CONTACTOUT_PASSWORD.trim()
      : "";
  if (!emailPool.length || !password) {
    throw new Error("Missing EMAIL_USER_LIST or CONTACTOUT_PASSWORD in ref/emails.js");
  }
  return { email: emailPool[0], password };
}

function buildSearchUrl(constants) {
  const base = new URL("https://contactout.com/dashboard/search");
  const countryList = Array.isArray(constants.SEARCH_COUNTRY_LIST)
    ? constants.SEARCH_COUNTRY_LIST.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  const location =
    String(
      constants.CONTACTOUT_LOCATION ||
        countryList[0] ||
        "United States"
    ).trim();
  const roleList = Array.isArray(constants.SEARCH_ROLE_LIST)
    ? constants.SEARCH_ROLE_LIST.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  const title = String(roleList[0] || "").trim();
  const genderList = Array.isArray(constants.SEARCH_GENDER_LIST)
    ? constants.SEARCH_GENDER_LIST
    : [];
  const singleGender = normalizeGenderValue(
    genderList[0] || constants.SEARCH_GENDER || ""
  );
  base.searchParams.set("login", "success");
  if (location) base.searchParams.set("location", location);
  if (title) base.searchParams.set("title", title);
  if (singleGender) base.searchParams.set("gender", singleGender);
  return base.toString();
}

async function ensureLoggedIn(page, email, password) {
  const onLogin = () => {
    try {
      return new URL(page.url()).pathname.toLowerCase().includes("/login");
    } catch {
      return false;
    }
  };

  if (!onLogin()) return;

  const emailInput = page
    .locator('input[type="email"], input[name="email"], input#email')
    .first();
  const passInput = page.locator('input[type="password"]').first();
  await emailInput.waitFor({ state: "visible", timeout: 30000 });
  await emailInput.fill(email);
  await passInput.fill(password);
  await page
    .getByRole("button", { name: /^login$/i })
    .or(page.locator('button[type="submit"]'))
    .first()
    .click();
  await page.waitForURL(
    (url) =>
      url.hostname.includes("contactout.com") &&
      !url.pathname.toLowerCase().includes("/login"),
    { timeout: 120000 }
  );
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
}

async function openIndustryFilter(page) {
  const candidates = [
    page.getByText(/select industry/i).first(),
    page.locator('input[placeholder*="industry" i]').first(),
    page.getByRole("combobox", { name: /industry/i }).first(),
    page.locator('[role="combobox"]').filter({ hasText: /industry/i }).first(),
    page.getByRole("button", { name: /industry/i }).first(),
    page.getByLabel(/industry/i).first(),
    page.getByText(/^industry$/i).first(),
    page.locator("button,div,span").filter({ hasText: /^Industry$/i }).first(),
  ];
  for (const candidate of candidates) {
    try {
      if (await candidate.count()) {
        await candidate.click({ timeout: 4000 });
        await page.waitForTimeout(1000);
        return true;
      }
    } catch {
      /* keep trying */
    }
  }
  return false;
}

async function getIndustryTrigger(page) {
  const candidates = [
    page.getByText(/select industry/i).first(),
    page.locator('input[placeholder*="industry" i]').first(),
    page.getByRole("combobox", { name: /industry/i }).first(),
    page.locator('[role="combobox"]').filter({ hasText: /industry/i }).first(),
  ];
  for (const candidate of candidates) {
    try {
      if (await candidate.count()) return candidate;
    } catch {
      /* keep trying */
    }
  }
  return null;
}

async function collectIndustryItemsFromDropdown(page) {
  const trigger = await getIndustryTrigger(page);
  if (!trigger) return [];
  const box = await trigger.boundingBox();
  if (!box) return [];

  return page.evaluate(async (triggerBox) => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };

    const getItems = () => {
      const out = new Set();
      const popup = findPopup();
      if (!popup) return out;
      const nodes = popup.querySelectorAll(
        '[role="option"], [cmdk-item], li, [data-radix-collection-item], button, div, span'
      );
      for (const node of nodes) {
        if (!isVisible(node)) continue;
        const text = (node.textContent || "").replace(/\s+/g, " ").trim();
        if (!text) continue;
        if (/^(industry|select industry|clear|apply|show more|show less|search)$/i.test(text)) continue;
        if (text.length < 3 || text.length > 80) continue;
        if (/^\d+$/.test(text)) continue;
        out.add(text);
      }
      return out;
    };

    const findPopup = () => {
      const textCount = (el) => {
        const nodes = el.querySelectorAll("div, span, li, button, [role='option']");
        let count = 0;
        for (const node of nodes) {
          if (!isVisible(node)) continue;
          const text = (node.textContent || "").replace(/\s+/g, " ").trim();
          if (!text) continue;
          if (/^(industry|select industry|clear|apply|show more|show less|search)$/i.test(text)) continue;
          if (text.length < 3 || text.length > 80) continue;
          if (/^\d+$/.test(text)) continue;
          count += 1;
        }
        return count;
      };

      const candidates = Array.from(document.querySelectorAll("*"))
        .filter((el) => {
          if (!isVisible(el)) return false;
          const rect = el.getBoundingClientRect();
          if (rect.top < triggerBox.y + triggerBox.height - 6) return false;
          if (rect.top > triggerBox.y + 520) return false;
          if (rect.height < 80) return false;
          if (rect.width < Math.max(180, triggerBox.width - 50)) return false;
          const horizontalDistance = Math.min(
            Math.abs(rect.left - triggerBox.x),
            Math.abs(rect.right - (triggerBox.x + triggerBox.width))
          );
          if (horizontalDistance > 80 && !(rect.left <= triggerBox.x + triggerBox.width && rect.right >= triggerBox.x)) {
            return false;
          }
          return (
            el.matches('[role="listbox"], [data-radix-popper-content-wrapper], .select__menu') ||
            el.scrollHeight > el.clientHeight + 10 ||
            textCount(el) >= 4
          );
        })
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const optionCount = textCount(el);
          let score = optionCount * 10;
          if (el.matches('[role="listbox"], [data-radix-popper-content-wrapper], .select__menu')) score += 60;
          if (el.scrollHeight > el.clientHeight + 10) score += 25;
          score -= Math.abs(rect.left - triggerBox.x);
          score -= Math.abs(rect.width - triggerBox.width) / 2;
          score -= Math.abs(rect.top - (triggerBox.y + triggerBox.height)) / 3;
          return { el, score };
        })
        .sort((a, b) => b.score - a.score);

      return candidates[0]?.el || null;
    };

    const getScrollBox = () => {
      const popup = findPopup();
      if (!popup) return null;
      return (
        Array.from(popup.querySelectorAll("*")).find((el) => el.scrollHeight > el.clientHeight + 10) ||
        popup
      );
    };

    const scrollBox = getScrollBox();
    if (!scrollBox) return [];

    let stablePasses = 0;
    let lastCount = 0;
    const all = new Set();

    while (stablePasses < 4) {
      for (const item of getItems()) all.add(item);
      scrollBox.scrollTop = scrollBox.scrollHeight;
      await sleep(700);
      if (all.size === lastCount) stablePasses += 1;
      else stablePasses = 0;
      lastCount = all.size;
    }

    return [...all].sort((a, b) => a.localeCompare(b));
  }, box);
}

async function collectIndustryItemsByKeyboard(page) {
  const trigger = await getIndustryTrigger(page);
  if (!trigger) return [];

  await trigger.click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(500);

  const snapshotState = async () =>
    page.evaluate(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };

      const popup = Array.from(document.querySelectorAll('*'))
        .filter((el) => {
          if (!isVisible(el)) return false;
          return (
            el.matches('[role="listbox"], [data-radix-popper-content-wrapper], .select__menu') ||
            el.querySelector('[role="option"], li, [data-radix-collection-item], [cmdk-item]')
          );
        })
        .sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0];

      if (!popup) return { activeText: "", visibleItems: [] };

      const activeId = document.activeElement?.getAttribute?.("aria-activedescendant");
      const activeEl =
        (activeId && document.getElementById(activeId)) ||
        popup.querySelector('[aria-selected="true"], [data-highlighted], [data-state="checked"], [aria-current="true"]');

      const visibleItems = Array.from(
        popup.querySelectorAll('[role="option"], [cmdk-item], li, [data-radix-collection-item], button, div, span')
      )
        .filter((node) => isVisible(node))
        .map((node) => (node.textContent || "").replace(/\s+/g, " ").trim())
        .filter((text) => {
          if (!text) return false;
          if (/^(industry|select industry|clear|apply|show more|show less|search)$/i.test(text)) return false;
          if (text.length < 3 || text.length > 80) return false;
          if (/^\d+$/.test(text)) return false;
          return true;
        });

      return {
        activeText: ((activeEl?.textContent || "") + "").replace(/\s+/g, " ").trim(),
        visibleItems,
      };
    });

  const all = new Set();
  const seenActive = new Set();
  let stablePasses = 0;

  for (let i = 0; i < 300 && stablePasses < 12; i += 1) {
    const beforeSize = all.size;
    const { activeText, visibleItems } = await snapshotState();
    for (const item of visibleItems) all.add(item);
    if (activeText) {
      if (seenActive.has(activeText)) stablePasses += 1;
      else stablePasses = 0;
      seenActive.add(activeText);
      all.add(activeText);
    } else if (all.size === beforeSize) {
      stablePasses += 1;
    } else {
      stablePasses = 0;
    }

    await page.keyboard.press("ArrowDown").catch(() => {});
    await page.waitForTimeout(120);
  }

  return [...all].sort((a, b) => a.localeCompare(b));
}

async function collectIndustryItems(page) {
  const dropdownItems = await collectIndustryItemsFromDropdown(page);
  if (dropdownItems.length) return dropdownItems;

  const keyboardItems = await collectIndustryItemsByKeyboard(page);
  if (keyboardItems.length) return keyboardItems;

  return page.evaluate(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const findIndustryContainer = () => {
      const nodes = Array.from(document.querySelectorAll("button,div,section,aside"));
      for (const node of nodes) {
        const text = (node.textContent || "").trim();
        if (!/^industry$/i.test(text)) continue;
        let current = node;
        for (let i = 0; i < 5 && current; i += 1) {
          const labels = current.querySelectorAll('label, [role="checkbox"], input[type="checkbox"]');
          if (labels.length >= 3) return current;
          current = current.parentElement;
        }
      }
      return null;
    };

    const extractFrom = (container) => {
      const items = new Set();
      const candidates = container.querySelectorAll("label, [role='checkbox'], button, span, div");
      for (const node of candidates) {
        const text = (node.textContent || "").replace(/\s+/g, " ").trim();
        if (!text) continue;
        if (/^industry$/i.test(text)) continue;
        if (/^(show more|show less|see more|collapse|expand|clear|apply)$/i.test(text)) continue;
        if (text.length < 3 || text.length > 80) continue;
        if (/^\d+$/.test(text)) continue;
        items.add(text);
      }
      return [...items];
    };

    const container = findIndustryContainer();
    if (!container) return [];

    const scrollBox = Array.from(container.querySelectorAll("*")).find(
      (el) => el.scrollHeight > el.clientHeight + 20
    ) || container;

    let stablePasses = 0;
    let lastCount = 0;
    const all = new Set();

    while (stablePasses < 4) {
      for (const item of extractFrom(container)) all.add(item);
      scrollBox.scrollTop = scrollBox.scrollHeight;
      await sleep(700);
      if (all.size === lastCount) stablePasses += 1;
      else stablePasses = 0;
      lastCount = all.size;
    }

    return [...all].sort((a, b) => a.localeCompare(b));
  });
}

async function main() {
  const constants = await loadConstants();
  const { email, password } = await loadAccounts();
  const searchUrl = buildSearchUrl(constants);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext(
    fs.existsSync(STORAGE_STATE_PATH) ? { storageState: STORAGE_STATE_PATH } : {}
  );
  const page = await context.newPage();

  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded" });
    await ensureLoggedIn(page, email, password);
    await page.goto(searchUrl, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});

    const opened = await openIndustryFilter(page);
    if (!opened) {
      throw new Error("Could not find/click the Industry filter panel.");
    }

    const industries = await collectIndustryItems(page);
    fs.writeFileSync(
      OUTPUT_PATH,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          count: industries.length,
          items: industries,
        },
        null,
        2
      ),
      "utf8"
    );

    console.log(`Saved ${industries.length} industry item(s) to ${OUTPUT_PATH}`);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
