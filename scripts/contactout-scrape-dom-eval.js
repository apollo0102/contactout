/**
 * Browser-only IIFE run via Playwright `page.evaluate` — same scrape logic as
 * `contactout_extension/content.js` (lines 5–391). After editing that file,
 * regenerate:
 *   ( printf '(function () {\n'; sed -n '5,391p' contactout_extension/content.js; printf '\n  return scrapeResults();\n})();\n'; ) > scripts/contactout-scrape-dom-eval.js
 */
(function () {
  const NAME_BLOCKLIST = new Set([
    "view",
    "connect",
    "message",
    "follow",
    "save",
    "more",
    "see more",
    "show all",
    "linkedin",
    "email",
    "phone",
    "copy",
    "add",
    "export",
    "filter",
    "sort",
  ]);

  function normalizeLinkedInUrl(href) {
    try {
      const u = new URL(href);
      const host = u.hostname.toLowerCase();
      if (!host.endsWith("linkedin.com")) return null;
      if (u.pathname.includes("/company/")) return null;
      const m = u.pathname.match(/\/in\/([^/]+)/i);
      if (!m) return null;
      return `https://www.linkedin.com/in/${m[1]}`;
    } catch {
      return null;
    }
  }

  function anchorIsShown(a) {
    const st = window.getComputedStyle(a);
    if (st.display === "none" || st.visibility === "hidden") return false;
    const r = a.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }

  function cleanName(s) {
    if (!s) return "";
    const t = s.replace(/\s+/g, " ").trim();
    if (!t || t.length > 160) return "";
    if (/^https?:/i.test(t)) return "";
    if (t.includes("linkedin.com")) return "";
    return t.split("\n")[0].trim();
  }

  function normKey(s) {
    return cleanName(s).toLowerCase();
  }

  function nameFromLabelText(label) {
    if (!label) return "";
    const raw = label.trim();
    const patterns = [
      /^(?:view\s+)?(.+?)'s\s+linkedin/i,
      /^(.+?)\s+on\s+linkedin/i,
      /^linkedin\s*[-–]\s*(.+)/i,
      /^open\s+(.+?)'s\s+profile/i,
      /^(.+?)'s\s+profile/i,
      /^(?:view\s+)?profile\s*(?:of|:)?\s*(.+)/i,
    ];
    for (const re of patterns) {
      const m = raw.match(re);
      if (m && m[1]) return cleanName(m[1]);
    }
    return "";
  }

  function nameFromAriaOrTitle(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return "";
    const aria = el.getAttribute("aria-label");
    const title = el.getAttribute("title");
    return nameFromLabelText(aria) || nameFromLabelText(title) || "";
  }

  function walkAriaChain(el, maxHops) {
    let cur = el;
    for (let i = 0; i < maxHops && cur; i++) {
      const n = nameFromAriaOrTitle(cur);
      if (n) return n;
      cur = cur.parentElement;
    }
    return "";
  }

  function looksLikePersonName(s) {
    const t = cleanName(s);
    if (t.length < 2 || t.length > 90) return false;
    const lower = normKey(t);
    if (NAME_BLOCKLIST.has(lower)) return false;
    if (/^[\d\s.,$+%-]+$/.test(t)) return false;
    if (/[/@]/.test(t)) return false;
    if (/\b(click|open|visit|show)\b/i.test(t)) return false;
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length > 8) return false;
    if (words.some((w) => /\d/.test(w))) return false;
    if (t.includes("|")) return false;
    if (/\s+at\s+/i.test(t) && t.length > 35) return false;
    return words.every((w) => /^[\p{L}][\p{L}'.-]*$/u.test(w));
  }

  function nameFromFirstLines(row) {
    if (!row) return "";
    const lines = (row.innerText || "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    for (let i = 0; i < Math.min(lines.length, 12); i++) {
      const line = lines[i];
      if (looksLikePersonName(line)) return line;
    }
    for (let i = 0; i < Math.min(lines.length, 4); i++) {
      const line = lines[i];
      const lower = line.toLowerCase();
      if (line.length < 2 || line.length > 55) continue;
      if (line.includes("http") || line.includes("@")) continue;
      if (NAME_BLOCKLIST.has(lower)) continue;
      if (/^[\d\s]+$/.test(line)) continue;
      if (line.includes("|")) continue;
      if (/\s+at\s+/i.test(line)) continue;
      if (/^[A-Za-z\u00C0-\u024F]/.test(line)) return line;
    }
    return "";
  }

  function textFromHeadings(root) {
    const sel =
      "h1, h2, h3, h4, h5, [class*='name' i], [data-testid*='name' i], [class*='fullName' i], [data-field='name']";
    const nodes = root.querySelectorAll(sel);
    for (const n of nodes) {
      const t = cleanName(n.textContent);
      if (looksLikePersonName(t)) return t;
    }
    return "";
  }

  function nameFromPreviousSiblings(el) {
    let cur = el;
    for (let depth = 0; depth < 8 && cur; depth++) {
      let sib = cur.previousElementSibling;
      while (sib) {
        const t = cleanName(sib.textContent || "");
        if (looksLikePersonName(t)) return t;
        const inner = sib.querySelector?.(
          "h1, h2, h3, h4, h5, span, strong, b"
        );
        if (inner) {
          const it = cleanName(inner.textContent || "");
          if (looksLikePersonName(it)) return it;
        }
        sib = sib.previousElementSibling;
      }
      cur = cur.parentElement;
    }
    return "";
  }

  function elementClassString(el) {
    if (!el?.className) return "";
    return typeof el.className === "string"
      ? el.className
      : String(el.className.baseVal || "");
  }

  function isContactOutProfileNameSpan(el) {
    if (!el || el.tagName !== "SPAN") return false;
    const c = elementClassString(el);
    if (!/\bfont-semibold\b/.test(c)) return false;
    const hasNameChrome =
      (/\bcursor-pointer\b/.test(c) && /\btruncate\b/.test(c)) ||
      (/\btext-base\b/.test(c) && /\btext-gray-900\b/.test(c));
    if (hasNameChrome) return true;
    return /\btruncate\b/.test(c) && /\btext-base\b/.test(c);
  }

  function nameFromContactOutNameSpan(row, anchor) {
    if (!row || !anchor) return "";
    const spans = row.querySelectorAll("span");
    let best = "";
    let bestDist = Infinity;
    const ar = anchor.getBoundingClientRect();
    for (const span of spans) {
      if (!isContactOutProfileNameSpan(span)) continue;
      const t = cleanName(span.textContent);
      if (t.length < 2) continue;
      if (!looksLikePersonName(t)) continue;
      const sr = span.getBoundingClientRect();
      const dist =
        Math.abs(sr.top - ar.top) + Math.abs(sr.left - ar.left) * 0.15;
      if (dist < bestDist) {
        bestDist = dist;
        best = t;
      }
    }
    if (best) return best;
    for (const span of spans) {
      const c = elementClassString(span);
      if (!/\bfont-semibold\b/.test(c)) continue;
      const t = cleanName(span.textContent);
      if (!looksLikePersonName(t)) continue;
      const sr = span.getBoundingClientRect();
      const dist =
        Math.abs(sr.top - ar.top) + Math.abs(sr.left - ar.left) * 0.15;
      if (dist < bestDist) {
        bestDist = dist;
        best = t;
      }
    }
    return best;
  }

  /**
   * After @, take host part; strip ContactOut/React suffixes like "-0-text" on data-for.
   * e.g. "***@lfdc.com-0-text" / "***@lfdc.com" → lfdc.com
   */
  function domainFromString(s) {
    if (!s) return "";
    const raw = String(s);
    const at = raw.indexOf("@");
    if (at === -1) return "";
    let rest = raw.slice(at + 1).trim();
    rest = rest.replace(/-\d+-text$/i, "");
    const m = rest.match(
      /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,})/i
    );
    return m ? m[1].toLowerCase() : "";
  }

  function workEmailDomainFromRow(row, anchor) {
    if (!row || !anchor) return "";
    const ar = anchor.getBoundingClientRect();
    const scored = [];

    const tryEl = (el) => {
      const dataFor = el.getAttribute?.("data-for") || "";
      let d = domainFromString(dataFor);
      if (!d) d = domainFromString(el.textContent || "");
      if (!d) return;
      const er = el.getBoundingClientRect();
      const dist =
        Math.abs(er.top - ar.top) + Math.abs(er.left - ar.left) * 0.12;
      scored.push({ d, dist });
    };

    /** Email chip is often outside the LinkedIn link subtree — walk up a few ancestors. */
    let scope = row;
    for (let hop = 0; hop < 10 && scope; hop++) {
      scope.querySelectorAll("[data-for*='@']").forEach(tryEl);
      scope.querySelectorAll('[data-tip="Copied!"]').forEach(tryEl);
      if (scored.length) break;
      scope = scope.parentElement;
    }

    if (!scored.length) {
      let s = row;
      for (let hop = 0; hop < 10 && s; hop++) {
        s.querySelectorAll("div, span").forEach((el) => {
          const t = el.textContent || "";
          if (!t.includes("@")) return;
          if (!/\*+@/.test(t) && !el.getAttribute?.("data-for")?.includes("@"))
            return;
          tryEl(el);
        });
        if (scored.length) break;
        s = s.parentElement;
      }
    }

    if (!scored.length) return "";

    scored.sort((a, b) => a.dist - b.dist);
    return scored[0].d;
  }

  function resultRowForAnchor(a) {
    const hit = a.closest(
      "tr, li, article, [role='row'], [role='listitem'], [data-testid], [class*='card' i], [class*='result' i], [class*='profile' i], [class*='person' i], [class*='candidate' i], [class*='lead' i], [class*='row' i]"
    );
    if (hit) return hit;
    let el = a.parentElement;
    for (let i = 0; i < 8 && el; i++) {
      const cls =
        typeof el.className === "string"
          ? el.className
          : el.className?.baseVal || "";
      if (/row|item|card|result|profile|candidate|cell|grid|listing|record/i.test(
        cls
      ))
        return el;
      el = el.parentElement;
    }
    return a.parentElement?.parentElement || a.parentElement;
  }

  function dataAttrNameNear(a) {
    let el = a;
    for (let i = 0; i < 10 && el; i++) {
      if (el.attributes) {
        for (const attr of el.attributes) {
          const n = attr.name.toLowerCase();
          if (
            (n.includes("name") || n === "data-candidate-name") &&
            attr.value &&
            !n.includes("filename")
          ) {
            const v = cleanName(attr.value);
            if (looksLikePersonName(v) || (v.length >= 3 && v.length < 60))
              return v;
          }
        }
      }
      el = el.parentElement;
    }
    return "";
  }

  function guessNameFromAnchor(a) {
    const direct = cleanName(a.textContent);
    if (looksLikePersonName(direct)) return direct;
    if (direct.length >= 3 && direct.length <= 50 && !direct.includes(" "))
      return direct;

    const fromLabel =
      nameFromAriaOrTitle(a) ||
      walkAriaChain(a.parentElement, 6) ||
      nameFromAriaOrTitle(a.closest("button, [role='button']"));
    if (fromLabel) return fromLabel;

    const row = resultRowForAnchor(a);
    if (row) {
      const co = nameFromContactOutNameSpan(row, a);
      if (co) return co;
      const h = textFromHeadings(row);
      if (h) return h;
      const first = nameFromFirstLines(row);
      if (first) return first;
    }

    const fromPrev = nameFromPreviousSiblings(a);
    if (fromPrev) return fromPrev;

    const dataN = dataAttrNameNear(a);
    if (dataN) return dataN;

    let el = a.parentElement;
    for (let i = 0; i < 10 && el; i++) {
      const t = textFromHeadings(el);
      if (t) return t;
      el = el.parentElement;
    }
    return "";
  }

  function scrapeResults() {
    /** @type {Map<string, { fullName: string, linkedinUrl: string, workEmailDomain: string }>} */
    const map = new Map();
    const anchors = document.querySelectorAll('a[href*="linkedin.com/in/"]');

    for (const a of anchors) {
      const linkedinUrl = normalizeLinkedInUrl(a.href);
      if (!linkedinUrl) continue;
      if (!anchorIsShown(a)) continue;

      const row = resultRowForAnchor(a);
      const fullName = guessNameFromAnchor(a);
      const workEmailDomain = workEmailDomainFromRow(row, a);

      const prev = map.get(linkedinUrl);
      const name =
        !prev || (fullName && fullName.length > (prev.fullName || "").length)
          ? fullName
          : prev.fullName;
      const domain = workEmailDomain || prev?.workEmailDomain || "";
      map.set(linkedinUrl, {
        fullName: name || "",
        linkedinUrl,
        workEmailDomain: domain,
      });
    }

    return Array.from(map.values()).sort((r, u) =>
      (r.fullName || r.linkedinUrl).localeCompare(u.fullName || u.linkedinUrl)
    );
  }

  return scrapeResults();
})();
