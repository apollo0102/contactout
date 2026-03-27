/**
 * ContactOut: LinkedIn URL + full name + work email domain from search rows.
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

  function elementIsVisible(el) {
    if (!el) return false;
    const st = window.getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }

  function cleanTextValue(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }

  function roleHintText() {
    return cleanTextValue(window.__CONTACTOUT_ROLE_HINT || "");
  }

  function lineMatchesRoleHint(text) {
    const roleHint = roleHintText();
    if (!roleHint) return false;
    return normKey(cleanTextValue(text)).includes(normKey(roleHint));
  }

  function looksLikeDomainOrUrl(s) {
    const t = cleanTextValue(s);
    if (!t) return false;
    if (/^https?:\/\//i.test(t)) return true;
    if (/^[a-z0-9.-]+\.[a-z]{2,}(?:\/|$)/i.test(t)) return true;
    return false;
  }

  function nearestAcceptedText(root, selector, anchor, accept) {
    if (!root) return "";
    const ar = anchor?.getBoundingClientRect?.() || null;
    let best = "";
    let bestDist = Infinity;
    for (const el of root.querySelectorAll(selector)) {
      if (!elementIsVisible(el)) continue;
      const text = cleanTextValue(el.textContent || el.getAttribute?.("aria-label") || "");
      if (!text) continue;
      if (accept && !accept(text, el)) continue;
      const er = el.getBoundingClientRect();
      const dist = ar
        ? Math.abs(er.top - ar.top) + Math.abs(er.left - ar.left) * 0.12
        : er.top;
      if (dist < bestDist) {
        bestDist = dist;
        best = text;
      }
    }
    return best;
  }

  function nearestAcceptedTextFromScopes(row, selector, anchor, accept) {
    let scope = row;
    for (let hop = 0; hop < 10 && scope; hop++) {
      const found = nearestAcceptedText(scope, selector, anchor, accept);
      if (found) return found;
      scope = scope.parentElement;
    }
    return "";
  }

  function visibleUniqueLines(root) {
    const lines = (root?.innerText || "")
      .split("\n")
      .map((line) => cleanTextValue(line))
      .filter(Boolean);
    const out = [];
    const seen = new Set();
    for (const line of lines) {
      const key = line.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(line);
    }
    return out;
  }

  function visibleUniqueLinesFromScopes(row) {
    const out = [];
    const seen = new Set();
    let scope = row;
    for (let hop = 0; hop < 8 && scope; hop++) {
      for (const line of visibleUniqueLines(scope)) {
        const key = line.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(line);
      }
      scope = scope.parentElement;
    }
    return out;
  }

  function employmentLineTextsFromScopes(row) {
    const out = [];
    const seen = new Set();
    let scope = row;
    for (let hop = 0; hop < 8 && scope; hop++) {
      for (const el of scope.querySelectorAll("div, span, p, li, a, strong, b")) {
        if (!elementIsVisible(el)) continue;
        const candidates = [el, el.parentElement, el.parentElement?.parentElement];
        for (const candidateEl of candidates) {
          if (!candidateEl) continue;
          const text = cleanTextValue(candidateEl.textContent || "");
          if (!text || text.length > 220) continue;
          if (!lineMatchesRoleHint(text) && !looksLikeEmploymentLine(text)) continue;
          const key = text.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(text);
        }
      }
      scope = scope.parentElement;
    }
    return out;
  }

  function looksLikeLocationText(s) {
    const t = cleanTextValue(s);
    if (!t || t.length > 120) return false;
    if (looksLikePersonName(t)) return false;
    if (looksLikeDomainOrUrl(t) || t.includes("@")) return false;
    if (NAME_BLOCKLIST.has(normKey(t))) return false;
    if (/^\d[\d\s.,-]*$/.test(t)) return false;
    const parts = t.split(",").map((part) => part.trim()).filter(Boolean);
    if (parts.length >= 2 && parts.length <= 5) return true;
    return /\b(united states|canada|united kingdom|uk|australia|india|germany|france|ireland|singapore|netherlands|new zealand)\b/i.test(
      t
    );
  }

  function looksLikeRoleText(s) {
    const t = cleanTextValue(s);
    if (!t || t.length > 120) return false;
    if (looksLikeDomainOrUrl(t) || t.includes("@")) return false;
    return /\b(director|manager|specialist|engineer|analyst|consultant|founder|owner|president|vice president|vp|head|lead|recruiter|officer|coordinator|developer|designer|architect|administrator|assistant|associate|executive|partner|principal|supervisor|strategist|human resources)\b/i.test(
      t
    );
  }

  function looksLikeEducationLine(s) {
    const t = cleanTextValue(s);
    return /\b(bachelor|master|mba|phd|doctorate|university|college|school|student|alumni|degree|graduat)\b/i.test(
      t
    );
  }

  function looksLikeEmploymentLine(s) {
    const t = cleanTextValue(s);
    if (!t || !/\bat\b/i.test(t)) return false;
    if (looksLikeEducationLine(t)) return false;
    const beforeAt = cleanTextValue(t.split(/\bat\b/i)[0] || "");
    if (looksLikeRoleText(beforeAt)) return true;
    if (
      /\b(founder|co-?founder|chief|creative|growth|marketing|sales|operations|product|design|engineering|business development|social media|finance|strategy|strategic|people|talent|partnerships)\b/i.test(
        beforeAt
      )
    ) {
      return true;
    }
    return /\bin\s+\d{4}\s*[-–]\s*(present|\d{4})\b/i.test(t);
  }

  function looksLikeBusinessText(s, fullName) {
    const t = cleanTextValue(s);
    if (!t || t.length > 120) return false;
    if (fullName && normKey(t) === normKey(fullName)) return false;
    if (looksLikePersonName(t)) return false;
    if (looksLikeLocationText(t)) return false;
    if (looksLikeDomainOrUrl(t) || t.includes("@")) return false;
    if (NAME_BLOCKLIST.has(normKey(t))) return false;
    if (looksLikeRoleText(t)) return false;
    return true;
  }

  function businessScore(text, fullName) {
    const t = cleanTextValue(text);
    if (!t) return -1;
    let score = looksLikeBusinessText(t, fullName) ? 100 : 0;
    if (looksLikeEducationLine(t)) score -= 120;
    if (looksLikeRoleText(t)) score -= 80;
    if (/\bat\b/i.test(t)) score -= 40;
    if (/\b(?:present|current|since)\b/i.test(t)) score -= 20;
    if (/\b\d{4}\b/.test(t)) score -= 15;
    if (/[|•·]/.test(t)) score -= 20;
    if (t.length >= 2 && t.length <= 50) score += 10;
    if (t.length > 70) score -= 20;
    return score;
  }

  function preferredBusiness(nextValue, prevValue, fullName) {
    const next = cleanTextValue(nextValue);
    const prev = cleanTextValue(prevValue);
    if (!next) return prev;
    if (!prev) return next;
    const nextScore = businessScore(next, fullName);
    const prevScore = businessScore(prev, fullName);
    if (nextScore !== prevScore) return nextScore > prevScore ? next : prev;
    if (next.length !== prev.length) return next.length < prev.length ? next : prev;
    return next;
  }

  function businessFromRoleLine(line, fullName) {
    const text = cleanTextValue(line);
    if (!text || !/\bat\b/i.test(text)) return "";
    if (!lineMatchesRoleHint(text) && !looksLikeEmploymentLine(text)) return "";
    const m = text.match(/\bat\s+(.+)$/i);
    if (!m || !m[1]) return "";
    const candidate = cleanTextValue(m[1])
      .replace(/\s+in\s+\d{4}.*$/i, "")
      .replace(/\s+since\s+\d{4}.*$/i, "")
      .replace(/\s+\(?\d{4}\)?\s*[-–].*$/i, "")
      .replace(/\s+[|•·]\s+.*$/i, "")
      .trim();
    return looksLikeBusinessText(candidate, fullName) ? candidate : "";
  }

  function businessAnchorFromEmploymentLine(row, fullName) {
    let scope = row;
    for (let hop = 0; hop < 8 && scope; hop++) {
      for (const link of scope.querySelectorAll("a")) {
        if (!elementIsVisible(link)) continue;
        const href = String(link.getAttribute("href") || "").trim();
        const text = cleanTextValue(link.textContent || "");
        if (!text || !looksLikeBusinessText(text, fullName)) continue;
        if (/linkedin\.com\/in\//i.test(href)) continue;
        if (/facebook\.com|twitter\.com|x\.com|instagram\.com/i.test(href)) continue;
        const parentText = cleanTextValue(link.parentElement?.textContent || "");
        const grandText = cleanTextValue(link.parentElement?.parentElement?.textContent || "");
        if (
          lineMatchesRoleHint(parentText) ||
          looksLikeEmploymentLine(parentText) ||
          lineMatchesRoleHint(grandText) ||
          looksLikeEmploymentLine(grandText)
        ) {
          return text;
        }
      }
      scope = scope.parentElement;
    }
    return "";
  }

  function businessFromRoleLine(line, fullName) {
    const text = cleanTextValue(line);
    if (!text || !/\bat\b/i.test(text)) return "";
    if (!lineMatchesRoleHint(text) && !looksLikeEmploymentLine(text)) return "";
    const m = text.match(
      /\bat\s+(.+?)(?=\s+(?:in|since)\s+\d{4}\b|\s+\(?\d{4}\)?\s*[-–]\s*(?:present|\d{4})\b|\s+[|•·]\s+|$)/i
    );
    if (!m || !m[1]) return "";
    const candidate = cleanTextValue(m[1])
      .replace(/\s+in\s+\d{4}.*$/i, "")
      .replace(/\s+since\s+\d{4}.*$/i, "")
      .replace(/\s+\(?\d{4}\)?\s*[-–].*$/i, "")
      .replace(/\s+[|•·]\s+.*$/i, "")
      .trim();
    return looksLikeBusinessText(candidate, fullName) ? candidate : "";
  }

  function businessContextMatchesText(candidate, fullName, contexts) {
    const businessText = cleanTextValue(candidate);
    if (!businessText || !looksLikeBusinessText(businessText, fullName)) return false;
    for (const context of contexts) {
      const parsed = businessFromRoleLine(context, fullName);
      if (parsed && normKey(parsed) === normKey(businessText)) return true;
    }
    return false;
  }

  function businessAnchorFromEmploymentLine(row, fullName) {
    let scope = row;
    for (let hop = 0; hop < 8 && scope; hop++) {
      for (const link of scope.querySelectorAll("a")) {
        if (!elementIsVisible(link)) continue;
        const href = String(link.getAttribute("href") || "").trim();
        const text = cleanTextValue(link.textContent || "");
        if (!text || !looksLikeBusinessText(text, fullName)) continue;
        if (/linkedin\.com\/in\//i.test(href)) continue;
        if (/facebook\.com|twitter\.com|x\.com|instagram\.com/i.test(href)) continue;
        const parentText = cleanTextValue(link.parentElement?.textContent || "");
        const grandText = cleanTextValue(link.parentElement?.parentElement?.textContent || "");
        if (businessContextMatchesText(text, fullName, [parentText, grandText])) {
          return text;
        }
      }
      scope = scope.parentElement;
    }
    return "";
  }

  function locationFromHeaderElements(row, anchor, fullName) {
    if (!row || !anchor) return "";
    const ar = anchor.getBoundingClientRect();
    let scope = row;
    for (let hop = 0; hop < 10 && scope; hop++) {
      let best = "";
      let bestDist = Infinity;
      for (const el of scope.querySelectorAll("div, span, p, a, strong, small")) {
        if (!elementIsVisible(el)) continue;
        const er = el.getBoundingClientRect();
        if (Math.abs(er.top - ar.top) > 18) continue;
        if (er.left + er.width < ar.left) continue;
        let text = cleanTextValue(el.textContent || "");
        if (!text) continue;
        if (fullName && normKey(text).startsWith(normKey(fullName))) {
          text = cleanTextValue(text.slice(fullName.length)).replace(
            /^[|/,\-•·\s]+/,
            ""
          );
        }
        if (!looksLikeLocationText(text)) continue;
        const dist = Math.abs(er.left - ar.left) + Math.abs(er.top - ar.top) * 0.2;
        if (dist < bestDist) {
          bestDist = dist;
          best = text;
        }
      }
      if (best) return best;
      scope = scope.parentElement;
    }
    return "";
  }

  function businessFromRow(row, anchor, fullName) {
    if (!row || !anchor) return "";

    const fromCompanyModalBtn = nearestAcceptedTextFromScopes(
      row,
      "span[data-testid='company-modal-btn']",
      anchor,
      (text) => looksLikeBusinessText(text, fullName)
    );
    if (fromCompanyModalBtn) return fromCompanyModalBtn;

    const directBusinessAnchor = businessAnchorFromEmploymentLine(row, fullName);
    if (directBusinessAnchor) return directBusinessAnchor;

    const lines = employmentLineTextsFromScopes(row);
    for (const line of lines) {
      if (!lineMatchesRoleHint(line)) continue;
      const parsed = businessFromRoleLine(line, fullName);
      if (parsed) return parsed;
    }

    const roleLineText = nearestAcceptedTextFromScopes(
      row,
      "div, span, p, li, a, strong",
      anchor,
      (text) =>
        Boolean(businessFromRoleLine(text, fullName)) &&
        (!roleHintText() || lineMatchesRoleHint(text))
    );
    if (roleLineText) {
      const parsed = businessFromRoleLine(roleLineText, fullName);
      if (parsed) return parsed;
    }

    for (const line of lines) {
      const parsed = businessFromRoleLine(line, fullName);
      if (parsed) return parsed;
    }

    const fromCompanyAnchor = nearestAcceptedTextFromScopes(
      row,
      "a[href*='linkedin.com/company/'], a[href*='/company/']",
      anchor,
      (text, el) => {
        if (!looksLikeBusinessText(text, fullName)) return false;
        const parentText = cleanTextValue(el.parentElement?.textContent || "");
        const grandText = cleanTextValue(el.parentElement?.parentElement?.textContent || "");
        return (
          lineMatchesRoleHint(parentText) ||
          looksLikeEmploymentLine(parentText) ||
          lineMatchesRoleHint(grandText) ||
          looksLikeEmploymentLine(grandText)
        );
      }
    );
    if (fromCompanyAnchor) return fromCompanyAnchor;

    const fromCompanyField = nearestAcceptedTextFromScopes(
      row,
      "[class*='company' i], [class*='business' i], [data-testid*='company' i], [data-field='company']",
      anchor,
      (text, el) => {
        if (!looksLikeBusinessText(text, fullName)) return false;
        const parentText = cleanTextValue(el.parentElement?.textContent || "");
        const grandText = cleanTextValue(el.parentElement?.parentElement?.textContent || "");
        return (
          lineMatchesRoleHint(parentText) ||
          looksLikeEmploymentLine(parentText) ||
          lineMatchesRoleHint(grandText) ||
          looksLikeEmploymentLine(grandText)
        );
      }
    );
    if (fromCompanyField) return fromCompanyField;

    return "";
  }

  function detailedRoleFromRoleLine(line, fullName) {
    const text = cleanTextValue(line);
    if (!text || !/\bat\b/i.test(text)) return "";
    if (!lineMatchesRoleHint(text) && !looksLikeEmploymentLine(text)) return "";
    const m = text.match(
      /^(.*?)(?=\s+at\s+.+?(?:\s+(?:in|since)\s+\d{4}\b|\s+\(?\d{4}\)?\s*[-–]\s*(?:present|\d{4})\b|\s+[|•·]\s+|$))/i
    );
    const candidate = cleanTextValue(m?.[1] || "").replace(/\s+[|•·]\s+.*$/i, "");
    if (!candidate) return "";
    if (looksLikeEducationLine(candidate)) return "";
    return candidate;
  }

  function detailedRoleFromRow(row, anchor, fullName) {
    if (!row || !anchor) return "";

    const fromHeaderNextLine = employmentLineAfterHeaderFromScopes(
      row,
      anchor,
      fullName
    );
    if (fromHeaderNextLine) {
      const parsed = detailedRoleFromRoleLine(fromHeaderNextLine, fullName);
      if (parsed) return parsed;
    }

    const fromGeometryLine = employmentLineByGeometryFromScopes(
      row,
      anchor,
      fullName
    );
    if (fromGeometryLine) {
      const parsed = detailedRoleFromRoleLine(fromGeometryLine, fullName);
      if (parsed) return parsed;
    }

    const lines = employmentLinesFromProfileScopes(row, anchor, fullName);
    for (const line of lines) {
      const parsed = detailedRoleFromRoleLine(line, fullName);
      if (parsed) return parsed;
    }

    return roleHintText();
  }

  function debugValueCount(obj) {
    if (!obj || typeof obj !== "object") return 0;
    let count = 0;
    for (const value of Object.values(obj)) {
      if (Array.isArray(value)) {
        count += value.filter(Boolean).length;
      } else if (value) {
        count += 1;
      }
    }
    return count;
  }

  function preferredDebugSnapshot(nextDebug, prevDebug) {
    const nextCount = debugValueCount(nextDebug);
    const prevCount = debugValueCount(prevDebug);
    return nextCount >= prevCount ? nextDebug : prevDebug;
  }

  function debugProfileSnapshot(row, anchor, fullName) {
    const rowLines = visibleUniqueLines(row).slice(0, 8);
    let matchedScopeLines = [];
    let headerLine = "";
    let secondLine = "";
    let scope = row;
    for (let hop = 0; hop < 8 && scope; hop++) {
      if (!scopeMatchesProfile(scope, anchor, fullName)) {
        scope = scope.parentElement;
        continue;
      }
      const lines = visibleUniqueLines(scope);
      const fullNameKey = normKey(fullName);
      const headerIdx = fullNameKey
        ? lines.findIndex(
            (line, idx) => idx < 8 && normKey(line).includes(fullNameKey)
          )
        : -1;
      if (headerIdx !== -1) {
        matchedScopeLines = lines.slice(0, Math.min(lines.length, headerIdx + 6));
        headerLine = lines[headerIdx] || "";
        secondLine = lines[headerIdx + 1] || "";
        break;
      }
      scope = scope.parentElement;
    }

    const headerEmploymentLine = employmentLineAfterHeaderFromScopes(
      row,
      anchor,
      fullName
    );
    const geometryEmploymentLine = employmentLineByGeometryFromScopes(
      row,
      anchor,
      fullName
    );

    return {
      row_lines: rowLines,
      scope_lines: matchedScopeLines,
      header_line: headerLine,
      second_line: secondLine,
      employment_line_from_header: headerEmploymentLine,
      employment_line_from_geometry: geometryEmploymentLine,
      extracted_business_from_header: businessFromRoleLine(
        headerEmploymentLine,
        fullName
      ),
      extracted_business_from_geometry: businessFromRoleLine(
        geometryEmploymentLine,
        fullName
      ),
    };
  }

  function looksLikeExtractedBusinessText(s, fullName) {
    const t = cleanTextValue(s);
    if (!t || t.length > 140) return false;
    if (fullName && normKey(t) === normKey(fullName)) return false;
    if (looksLikeDomainOrUrl(t) || t.includes("@")) return false;
    if (NAME_BLOCKLIST.has(normKey(t))) return false;
    if (looksLikeRoleText(t)) return false;
    return true;
  }

  function businessFromRoleLine(line, fullName) {
    const text = cleanTextValue(line);
    if (!text || !/\bat\b/i.test(text)) return "";
    if (!lineMatchesRoleHint(text) && !looksLikeEmploymentLine(text)) return "";
    const m = text.match(
      /\bat\s+(.+?)(?=\s+(?:in|since)\s+\d{4}\b|\s+\(?\d{4}\)?\s*[-–]\s*(?:present|\d{4})\b|\s+[|•·]\s+|$)/i
    );
    if (!m || !m[1]) return "";
    const candidate = cleanTextValue(m[1])
      .replace(/\s+in\s+\d{4}.*$/i, "")
      .replace(/\s+since\s+\d{4}.*$/i, "")
      .replace(/\s+\(?\d{4}\)?\s*[-–].*$/i, "")
      .replace(/\s+[|•·]\s+.*$/i, "")
      .trim();
    return looksLikeExtractedBusinessText(candidate, fullName) ? candidate : "";
  }

  function businessElementNearHeaderFromScopes(row, anchor, fullName) {
    if (!row || !anchor) return "";
    const ar = anchor.getBoundingClientRect();
    let best = "";
    let bestScore = Infinity;
    let scope = row;
    for (let hop = 0; hop < 8 && scope; hop++) {
      if (!scopeMatchesProfile(scope, anchor, fullName)) {
        scope = scope.parentElement;
        continue;
      }
      for (const el of scope.querySelectorAll("a, span")) {
        if (!elementIsVisible(el)) continue;
        const text = cleanTextValue(el.textContent || "");
        if (!looksLikeExtractedBusinessText(text, fullName)) continue;
        const er = el.getBoundingClientRect();
        if (er.top < ar.top + 6 || er.top > ar.top + 110) continue;
        if (er.left + er.width < ar.left - 40) continue;
        const parentText = cleanTextValue(el.parentElement?.textContent || "");
        const grandText = cleanTextValue(el.parentElement?.parentElement?.textContent || "");
        if (
          !businessFromRoleLine(parentText, fullName) &&
          !businessFromRoleLine(grandText, fullName)
        ) {
          continue;
        }
        const score =
          hop * 100 +
          Math.abs(er.top - (ar.top + 28)) +
          Math.abs(er.left - ar.left) * 0.12;
        if (score < bestScore) {
          bestScore = score;
          best = text;
        }
      }
      scope = scope.parentElement;
    }
    return best;
  }

  function businessFromRow(row, anchor, fullName) {
    if (!row || !anchor) return "";

    const fromHeaderNextLine = employmentLineAfterHeaderFromScopes(
      row,
      anchor,
      fullName
    );
    if (fromHeaderNextLine) {
      const parsed = businessFromRoleLine(fromHeaderNextLine, fullName);
      if (parsed) return parsed;
    }

    const fromGeometryLine = employmentLineByGeometryFromScopes(
      row,
      anchor,
      fullName
    );
    if (fromGeometryLine) {
      const parsed = businessFromRoleLine(fromGeometryLine, fullName);
      if (parsed) return parsed;
    }

    const fromBusinessElement = businessElementNearHeaderFromScopes(
      row,
      anchor,
      fullName
    );
    if (fromBusinessElement) return fromBusinessElement;

    const lines = employmentLinesFromProfileScopes(row, anchor, fullName);
    for (const line of lines) {
      const parsed = businessFromRoleLine(line, fullName);
      if (parsed) return parsed;
    }

    const directBusinessAnchor = businessAnchorFromProfileScopes(
      row,
      anchor,
      fullName
    );
    if (directBusinessAnchor) return directBusinessAnchor;

    const fromCompanyModalBtn = companyModalBusinessFromProfileScopes(
      row,
      anchor,
      fullName
    );
    if (fromCompanyModalBtn) return fromCompanyModalBtn;

    return "";
  }

  function businessFromRow(row, anchor, fullName) {
    if (!row || !anchor) return "";

    const fromCompanyModalBtn = nearestAcceptedTextFromScopes(
      row,
      "span[data-testid='company-modal-btn']",
      anchor,
      (text) => looksLikeBusinessText(text, fullName)
    );
    if (fromCompanyModalBtn) return fromCompanyModalBtn;

    const lines = employmentLineTextsFromScopes(row);
    for (const line of lines) {
      if (!lineMatchesRoleHint(line)) continue;
      const parsed = businessFromRoleLine(line, fullName);
      if (parsed) return parsed;
    }

    const roleLineText = nearestAcceptedTextFromScopes(
      row,
      "div, span, p, li, a, strong",
      anchor,
      (text) =>
        Boolean(businessFromRoleLine(text, fullName)) &&
        (!roleHintText() || lineMatchesRoleHint(text))
    );
    if (roleLineText) {
      const parsed = businessFromRoleLine(roleLineText, fullName);
      if (parsed) return parsed;
    }

    for (const line of lines) {
      const parsed = businessFromRoleLine(line, fullName);
      if (parsed) return parsed;
    }

    const directBusinessAnchor = businessAnchorFromEmploymentLine(row, fullName);
    if (directBusinessAnchor) return directBusinessAnchor;

    const fromCompanyAnchor = nearestAcceptedTextFromScopes(
      row,
      "a[href*='linkedin.com/company/'], a[href*='/company/']",
      anchor,
      (text, el) => {
        if (!looksLikeBusinessText(text, fullName)) return false;
        const parentText = cleanTextValue(el.parentElement?.textContent || "");
        const grandText = cleanTextValue(el.parentElement?.parentElement?.textContent || "");
        return businessContextMatchesText(text, fullName, [parentText, grandText]);
      }
    );
    if (fromCompanyAnchor) return fromCompanyAnchor;

    const fromCompanyField = nearestAcceptedTextFromScopes(
      row,
      "[class*='company' i], [class*='business' i], [data-testid*='company' i], [data-field='company']",
      anchor,
      (text, el) => {
        if (!looksLikeBusinessText(text, fullName)) return false;
        const parentText = cleanTextValue(el.parentElement?.textContent || "");
        const grandText = cleanTextValue(el.parentElement?.parentElement?.textContent || "");
        return businessContextMatchesText(text, fullName, [parentText, grandText]);
      }
    );
    if (fromCompanyField) return fromCompanyField;

    return "";
  }

  function headerLineIndex(lines, fullName) {
    const fullNameKey = normKey(fullName);
    if (!fullNameKey) return -1;
    for (let i = 0; i < Math.min(lines.length, 4); i++) {
      if (normKey(lines[i]).includes(fullNameKey)) return i;
    }
    return -1;
  }

  function employmentLineNearHeader(row, anchor, fullName) {
    if (!row || !anchor) return "";
    const ar = anchor.getBoundingClientRect();
    let best = "";
    let bestDist = Infinity;
    for (const el of row.querySelectorAll("div, span, p, li, a, strong, b")) {
      if (!elementIsVisible(el)) continue;
      const er = el.getBoundingClientRect();
      if (er.top < ar.top + 10 || er.top > ar.top + 90) continue;
      if (er.left + er.width < ar.left - 24) continue;
      const text = cleanTextValue(el.textContent || "");
      if (!text || text.length > 220) continue;
      if (!lineMatchesRoleHint(text) && !looksLikeEmploymentLine(text)) continue;
      if (!businessFromRoleLine(text, fullName)) continue;
      const dist = Math.abs(er.top - (ar.top + 30)) + Math.abs(er.left - ar.left) * 0.12;
      if (dist < bestDist) {
        bestDist = dist;
        best = text;
      }
    }
    return best;
  }

  function employmentLinesFromRow(row, anchor, fullName) {
    const out = [];
    const seen = new Set();
    const pushLine = (line) => {
      const text = cleanTextValue(line);
      if (!text) return;
      if (!lineMatchesRoleHint(text) && !looksLikeEmploymentLine(text)) return;
      const key = text.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(text);
    };

    pushLine(employmentLineNearHeader(row, anchor, fullName));

    const lines = visibleUniqueLines(row);
    const headerIdx = headerLineIndex(lines, fullName);
    const start = headerIdx === -1 ? 0 : headerIdx + 1;
    for (let i = start; i < Math.min(lines.length, start + 6); i++) {
      pushLine(lines[i]);
    }
    if (!out.length) {
      for (let i = 0; i < Math.min(lines.length, 10); i++) {
        pushLine(lines[i]);
      }
    }
    return out;
  }

  function scopeMatchesProfile(scope, anchor, fullName) {
    if (!scope || !anchor) return false;
    const ownUrl = normalizeLinkedInUrl(anchor.href);
    const urls = uniqueLinkedInUrlsInNode(scope);
    if (urls.size > 1) return false;
    if (ownUrl && urls.size === 1 && !urls.has(ownUrl)) return false;
    const lines = visibleUniqueLines(scope);
    if (!lines.length) return false;
    if (fullName) {
      const fullNameKey = normKey(fullName);
      if (
        fullNameKey &&
        !lines.some(
          (line, idx) => idx < 4 && normKey(line).includes(fullNameKey)
        )
      ) {
        return false;
      }
    }
    return true;
  }

  function employmentLinesFromProfileScopes(row, anchor, fullName) {
    const out = [];
    const seen = new Set();
    let scope = row;
    for (let hop = 0; hop < 8 && scope; hop++) {
      if (scopeMatchesProfile(scope, anchor, fullName)) {
        for (const line of employmentLinesFromRow(scope, anchor, fullName)) {
          const key = line.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(line);
        }
      }
      scope = scope.parentElement;
    }
    return out;
  }

  function businessAnchorFromProfileScopes(row, anchor, fullName) {
    let scope = row;
    for (let hop = 0; hop < 8 && scope; hop++) {
      if (scopeMatchesProfile(scope, anchor, fullName)) {
        const found = businessAnchorFromEmploymentLine(scope, fullName);
        if (found) return found;
      }
      scope = scope.parentElement;
    }
    return "";
  }

  function companyModalBusinessFromProfileScopes(row, anchor, fullName) {
    let scope = row;
    for (let hop = 0; hop < 8 && scope; hop++) {
      if (scopeMatchesProfile(scope, anchor, fullName)) {
        const found = nearestAcceptedText(
          scope,
          "span[data-testid='company-modal-btn']",
          anchor,
          (text) => looksLikeBusinessText(text, fullName)
        );
        if (found) return found;
      }
      scope = scope.parentElement;
    }
    return "";
  }

  function businessFromRow(row, anchor, fullName) {
    if (!row || !anchor) return "";

    const lines = employmentLinesFromProfileScopes(row, anchor, fullName);
    for (const line of lines) {
      const parsed = businessFromRoleLine(line, fullName);
      if (parsed) return parsed;
    }

    const directBusinessAnchor = businessAnchorFromProfileScopes(
      row,
      anchor,
      fullName
    );
    if (directBusinessAnchor) return directBusinessAnchor;

    const fromCompanyModalBtn = companyModalBusinessFromProfileScopes(
      row,
      anchor,
      fullName
    );
    if (fromCompanyModalBtn) return fromCompanyModalBtn;

    return "";
  }

  function employmentLineAfterHeaderFromScopes(row, anchor, fullName) {
    const fullNameKey = normKey(fullName);
    if (!fullNameKey) return "";
    let best = "";
    let bestScore = Infinity;
    let scope = row;
    for (let hop = 0; hop < 8 && scope; hop++) {
      if (!scopeMatchesProfile(scope, anchor, fullName)) {
        scope = scope.parentElement;
        continue;
      }
      const lines = visibleUniqueLines(scope);
      const headerIdx = lines.findIndex(
        (line, idx) => idx < 8 && normKey(line).includes(fullNameKey)
      );
      if (headerIdx !== -1) {
        for (let i = headerIdx + 1; i < Math.min(lines.length, headerIdx + 5); i++) {
          const line = cleanTextValue(lines[i]);
          const business = businessFromRoleLine(line, fullName);
          if (!business) continue;
          const score = hop * 100 + (i - headerIdx);
          if (score < bestScore) {
            bestScore = score;
            best = line;
          }
          break;
        }
      }
      scope = scope.parentElement;
    }
    return best;
  }

  function employmentLineByGeometryFromScopes(row, anchor, fullName) {
    if (!row || !anchor) return "";
    const ar = anchor.getBoundingClientRect();
    let best = "";
    let bestScore = Infinity;
    let scope = row;
    for (let hop = 0; hop < 8 && scope; hop++) {
      if (!scopeMatchesProfile(scope, anchor, fullName)) {
        scope = scope.parentElement;
        continue;
      }
      for (const el of scope.querySelectorAll("div, span, p, li, a, strong, b")) {
        if (!elementIsVisible(el)) continue;
        const text = cleanTextValue(el.textContent || "");
        const business = businessFromRoleLine(text, fullName);
        if (!business) continue;
        const er = el.getBoundingClientRect();
        if (er.top < ar.top + 6 || er.top > ar.top + 110) continue;
        if (er.left + er.width < ar.left - 40) continue;
        const score =
          hop * 100 +
          Math.abs(er.top - (ar.top + 28)) +
          Math.abs(er.left - ar.left) * 0.12;
        if (score < bestScore) {
          bestScore = score;
          best = text;
        }
      }
      scope = scope.parentElement;
    }
    return best;
  }

  function businessFromRow(row, anchor, fullName) {
    if (!row || !anchor) return "";

    const fromHeaderNextLine = employmentLineAfterHeaderFromScopes(
      row,
      anchor,
      fullName
    );
    if (fromHeaderNextLine) {
      const parsed = businessFromRoleLine(fromHeaderNextLine, fullName);
      if (parsed) return parsed;
    }

    const fromGeometryLine = employmentLineByGeometryFromScopes(
      row,
      anchor,
      fullName
    );
    if (fromGeometryLine) {
      const parsed = businessFromRoleLine(fromGeometryLine, fullName);
      if (parsed) return parsed;
    }

    const lines = employmentLinesFromProfileScopes(row, anchor, fullName);
    for (const line of lines) {
      const parsed = businessFromRoleLine(line, fullName);
      if (parsed) return parsed;
    }

    const directBusinessAnchor = businessAnchorFromProfileScopes(
      row,
      anchor,
      fullName
    );
    if (directBusinessAnchor) return directBusinessAnchor;

    const fromCompanyModalBtn = companyModalBusinessFromProfileScopes(
      row,
      anchor,
      fullName
    );
    if (fromCompanyModalBtn) return fromCompanyModalBtn;

    return "";
  }

  function locationFromRow(row, anchor, fullName) {
    if (!row || !anchor) return "";

    const fromHeaderElements = locationFromHeaderElements(row, anchor, fullName);
    if (fromHeaderElements) return fromHeaderElements;

    const lines = visibleUniqueLines(row);
    if (fullName) {
      const fullNameKey = normKey(fullName);
      for (const line of lines) {
        if (!normKey(line).startsWith(fullNameKey)) continue;
        const suffix = cleanTextValue(line.slice(fullName.length)).replace(
          /^[|/,\-•·\s]+/,
          ""
        );
        if (looksLikeLocationText(suffix)) return suffix;
      }
    }

    const fromLocationField = nearestAcceptedTextFromScopes(
      row,
      "[class*='location' i], [data-testid*='location' i], [data-field='location']",
      anchor,
      (text) => looksLikeLocationText(text)
    );
    if (fromLocationField) return fromLocationField;

    for (const line of lines) {
      if (fullName && normKey(line) === normKey(fullName)) continue;
      if (looksLikeLocationText(line)) return line;
    }
    return "";
  }

  function normalizeFacebookUrl(href) {
    try {
      const u = new URL(href, window.location.href);
      const host = u.hostname.toLowerCase().replace(/^m\./, "").replace(/^www\./, "");
      if (host !== "facebook.com") return "";
      if (/^\/(sharer|share|dialog|plugins)\b/i.test(u.pathname)) return "";
      return `https://www.facebook.com${u.pathname}${u.search || ""}`;
    } catch {
      return "";
    }
  }

  function facebookUrlFromRow(row, anchor) {
    if (!row || !anchor) return "";
    const ar = anchor.getBoundingClientRect();
    const scored = [];
    let scope = row;
    for (let hop = 0; hop < 10 && scope; hop++) {
      for (const link of scope.querySelectorAll("a[href*='facebook.com']")) {
        if (!elementIsVisible(link)) continue;
        const url = normalizeFacebookUrl(link.href);
        if (!url) continue;
        const lr = link.getBoundingClientRect();
        const dist =
          Math.abs(lr.top - ar.top) + Math.abs(lr.left - ar.left) * 0.12;
        scored.push({ url, dist });
      }
      if (scored.length) break;
      scope = scope.parentElement;
    }
    if (!scored.length) return "";
    scored.sort((a, b) => a.dist - b.dist);
    return scored[0].url;
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

  function uniqueLinkedInUrlsInNode(root) {
    const urls = new Set();
    if (!root?.querySelectorAll) return urls;
    for (const link of root.querySelectorAll('a[href*="linkedin.com/in/"]')) {
      const normalized = normalizeLinkedInUrl(link.href);
      if (!normalized) continue;
      urls.add(normalized);
      if (urls.size > 2) break;
    }
    return urls;
  }

  function resultRowForAnchor(a) {
    const ownUrl = normalizeLinkedInUrl(a.href);
    const ar = a.getBoundingClientRect();
    let best = null;
    let bestScore = Infinity;
    let el = a.parentElement;

    for (let hop = 0; hop < 12 && el; hop++) {
      if (elementIsVisible(el)) {
        const r = el.getBoundingClientRect();
        if (r.width >= 220 && r.height >= 60 && r.height <= 420) {
          const urls = uniqueLinkedInUrlsInNode(el);
          const lines = visibleUniqueLines(el);
          const hasEmployment = lines.some(
            (line, idx) =>
              idx < 8 && (lineMatchesRoleHint(line) || looksLikeEmploymentLine(line))
          );
          if (
            urls.size === 1 &&
            (!ownUrl || urls.has(ownUrl)) &&
            lines.length >= 2 &&
            lines.length <= 12 &&
            hasEmployment
          ) {
            const score =
              r.height + lines.length * 8 + Math.abs(r.left - ar.left) * 0.04;
            if (score < bestScore) {
              bestScore = score;
              best = el;
            }
          }
        }
      }
      el = el.parentElement;
    }

    if (best) return best;

    const fallback = a.closest("tr, li, article, [role='row'], [role='listitem']");
    if (fallback) return fallback;
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
    /** @type {Map<string, { fullName: string, linkedinUrl: string, workEmailDomain: string, business: string, role: string, location: string, facebookUrl: string, debug?: object }>} */
    const map = new Map();
    const anchors = document.querySelectorAll('a[href*="linkedin.com/in/"]');

    for (const a of anchors) {
      const linkedinUrl = normalizeLinkedInUrl(a.href);
      if (!linkedinUrl) continue;
      if (!anchorIsShown(a)) continue;

      const row = resultRowForAnchor(a);
      const fullName = guessNameFromAnchor(a);
      const workEmailDomain = workEmailDomainFromRow(row, a);
      const business = businessFromRow(row, a, fullName);
      const detailedRole = detailedRoleFromRow(row, a, fullName);
      const location = locationFromRow(row, a, fullName);
      const facebookUrl = facebookUrlFromRow(row, a);
      const debug = debugProfileSnapshot(row, a, fullName);

      const prev = map.get(linkedinUrl);
      const name =
        !prev || (fullName && fullName.length > (prev.fullName || "").length)
          ? fullName
          : prev.fullName;
      const domain = workEmailDomain || prev?.workEmailDomain || "";
      const businessName = preferredBusiness(
        business,
        prev?.business || "",
        name || fullName
      );
      const roleName =
        detailedRole && detailedRole.length > (prev?.role || "").length
          ? detailedRole
          : prev?.role || roleHintText() || "";
      const profileLocation =
        location && location.length > (prev?.location || "").length
          ? location
          : prev?.location || "";
      const facebook = facebookUrl || prev?.facebookUrl || "";
      map.set(linkedinUrl, {
        fullName: name || "",
        linkedinUrl,
        workEmailDomain: domain,
        business: businessName,
        role: roleName,
        location: profileLocation,
        facebookUrl: facebook,
        debug: preferredDebugSnapshot(debug, prev?.debug),
      });
    }

    return Array.from(map.values()).sort((r, u) =>
      (r.fullName || r.linkedinUrl).localeCompare(u.fullName || u.linkedinUrl)
    );
  }

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request?.type !== "SCRAPE_CONTACTOUT") return false;
    try {
      const rows = scrapeResults();
      sendResponse({ ok: true, rows, url: location.href });
    } catch (e) {
      sendResponse({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return true;
  });
})();
