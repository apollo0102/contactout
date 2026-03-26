function setStatus(el, text, ok) {
  el.textContent = text;
  el.classList.toggle("ok", Boolean(ok));
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

function downloadCsv(text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  a.href = url;
  a.download = `contactout-export-${stamp}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

document.getElementById("export").addEventListener("click", async () => {
  const statusEl = document.getElementById("status");
  const countEl = document.getElementById("count");
  setStatus(statusEl, "");
  countEl.textContent = "";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatus(statusEl, "No active tab.");
    return;
  }

  let res;
  try {
    res = await chrome.tabs.sendMessage(tab.id, { type: "SCRAPE_CONTACTOUT" });
  } catch {
    res = null;
  }

  if (!res) {
    setStatus(
      statusEl,
      "Could not reach the page. Use a contactout.com tab and refresh after installing the extension."
    );
    return;
  }

  if (!res.ok) {
    setStatus(statusEl, res.error || "Scrape failed.");
    return;
  }

  const rows = res.rows || [];
  if (!rows.length) {
    setStatus(
      statusEl,
      "No LinkedIn profile links found. Scroll the results list and try again."
    );
    return;
  }

  downloadCsv(buildCsv(rows));
  setStatus(statusEl, `Saved ${rows.length} row(s).`, true);
  countEl.textContent = `${rows.length} profiles`;
});
