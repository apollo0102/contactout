# ContactOut search export

This repo contains:

1. **Chrome extension** (`contactout_extension/`) — optional manual use: scrapes ContactOut people-search results on the current tab and downloads a CSV (full name, LinkedIn URL, work email domain).
2. **Playwright bot** (`npm run export`) — **does not use the extension.** It opens the dashboard search URL (e.g. [`/dashboard/search?location=United%20States`](https://contactout.com/dashboard/search?location=United%20States)), logs in only if needed, then for each page loads `…&page=1`, `…&page=2`, … (incrementing `page` by 1), runs the **same DOM scrape** as the extension (see `scripts/contactout-scrape-dom-eval.js`), and saves a JSON file per page. It records completed `page=` values in **`ref/search-history.json`** (per search URL) so **re-runs skip pages already exported**. After each run it writes **`contactout-merged-*.json`** in **`data/`** — one deduplicated file (by LinkedIn URL) combining **all rows collected in that run** from the per-page JSON files.

## Requirements

- **Node.js** 18+ (recommended)
- **Network access** for `npm` and Playwright’s browser download on first setup

## Quick start

```bash
cd /path/to/contactout
npm install
npx playwright install chromium
```

Create a `.env` file in the project root (see [Environment variables](#environment-variables)). Then:

```bash
npm run export
```

**Search URL from JSON (optional):** `data/search_keywords.json` has **`search_params`** with **`pools`** (per-field lists) and **`presets`** (fixed combinations matching [ContactOut dashboard search](https://contactout.com/dashboard/search) query params such as `company`, `job_function`, `location`, `title`, `seniority`, `totalYears`, `years`, `login`). Examples:

```bash
# One random combination from pools (uses default_extra e.g. login=success)
npm run export -- --random-search

# Fixed preset id from search_params.presets (example: Google / UK / senior SWE)
npm run export -- --search-profile=google-uk-senior-swe

# Reproducible random picks
npm run export -- --random-search --random-seed=42
```

See **`SEARCH_RANDOM`**, **`SEARCH_RANDOM_SEED`**, and **`SEARCH_PROFILE`** in the table below. **`CONTACTOUT_SEARCH_URL`** in `.env` overrides presets and random picks when set.

By default the browser window is visible. Set `HEADLESS=1` to run headless. **Per-page** JSON files go under `exports/`; the **merged** JSON goes under `data/`. Exported filenames include sanitized `SEARCH_COUNTRY_LIST`, `SEARCH_ROLE_LIST`, and `SEARCH_GENDER` values when present; when you use **`SEARCH_GENDER_LIST`**, the final merged file is labeled with `all-genders`.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `EMAIL_USER` | When login needed | One login email (alternative: see below) |
| `EMAIL_USER1`, `EMAIL_USER2`, … | When login needed | Multiple accounts in order; **same password** as `CONTACTOUT_PASSWORD` for all. On **HTTP 429**, the bot switches to the **next** email and clears session before signing in again |
| `EMAIL_USERS` | When login needed | Comma- or newline-separated list (instead of numbered `EMAIL_USER*` vars) |
| `CONTACTOUT_PASSWORD` | When login needed | Password shared by all accounts in the pool |
| `CONTACTOUT_LOCATION` | No | Optional explicit location override used to build the default search URL as `?location=…` |
| `CONTACTOUT_SEARCH_URL` | No | Full dashboard search URL. Any `page=` is removed; the bot sets `page`. If set, overrides **`SEARCH_PROFILE`** and **`SEARCH_RANDOM`** |
| `SEARCH_KEYWORDS_PATH` | No | Path to **`data/search_keywords.json`** (default: that path). Contains **`search_params`** (`pools`, `presets`, `default_extra`) plus legacy **`saved_searches`** |
| `SEARCH_PROFILE` | No | When **`CONTACTOUT_SEARCH_URL`** unset: **`search_params.presets[].id`** first (params merged into a URL), else **`saved_searches[].id`**. Ignored for random if you pass **`--search-profile=`** on the CLI (that preset wins) |
| `SEARCH_RANDOM` | No | Set `1` / `true`: pick one random value per key from **`search_params.pools`** and merge **`default_extra`** (e.g. `login=success`). Disabled if you use **`--search-profile=`** on the CLI |
| `SEARCH_RANDOM_SEED` | No | Optional integer so **`SEARCH_RANDOM`** picks are reproducible; same as **`--random-seed=`** |
| `SEARCH_COUNTRY_LIST` | No | JSON array, bracket list, or comma/newline list of countries/locations. The bot runs one search per country and keeps outputs in separate country folders |
| `SEARCH_ROLE_LIST` | No | JSON array, bracket list, or comma/newline list of role titles. The bot runs one search per role and keeps outputs in separate role folders |
| `SEARCH_GENDER` | No | Optional gender filter added to generated search URLs; also included in exported JSON filenames when set. If empty, it is omitted from the filename |
| `SEARCH_GENDER_LIST` | No | JSON array, bracket list, or comma/newline list of genders. The bot runs one search per gender, keeps separate page files, and merges all rows into one final JSON |
| `SEARCH_YEARS` | No | JSON array, bracket list, or comma/newline list of `years` values. If a gender search count is over `2500`, the bot drills into each `years` item for that gender and merges the results |
| `SEARCH_TOTALYEARS` | No | JSON array, bracket list, or comma/newline list of `totalYears` values. If a `gender + years` bucket is still over `2500`, the bot drills into each `totalYears` item for that branch and merges the results |
| `SEARCH_EMPLOYEE_SIZE` | No | JSON array, bracket list, or comma/newline list of `employee_size` values. If a `gender + years + totalYears` bucket is still over `2500`, the bot drills into each `employee_size` item for that branch and merges the results |
| `SEARCH_REVENUE` | No | Array of objects with `revenue_min` / `revenue_max`. If a `gender + years + totalYears + employee_size` bucket is still over `2500`, the bot drills into each revenue range for that branch and merges the results |
| `SEARCH_INDUSTRY` | No | JSON array, bracket list, or comma/newline list of industries. If a `gender + years + totalYears + employee_size + revenue` bucket is still over `2500`, the bot drills into each industry value for that branch and merges the results |
| `START_PAGE` | No | First `page=` to load (default `1`). Use `4` to start at `…&page=4` |
| `MAX_PAGES` | No | How many URLs to export: `page=START_PAGE`, `START_PAGE+1`, … (default `10`). Set `0` to keep increasing `page` until a page returns no rows |
| `EXPORT_DIR` | No | Output directory for per-page JSON files (default: `./exports`) |
| `SEARCH_HISTORY_PATH` | No | JSON file tracking which `page=` values finished per search (default: `./ref/search-history.json`) |
| `IGNORE_SEARCH_HISTORY` | No | Set `1` or `true` to ignore history and re-download every page |
| `MERGE_JSON` | No | Set `0` or `false` to skip writing the combined `contactout-merged-*.json` at the end of a run |
| `MERGE_CSV` | No | Legacy alias for `MERGE_JSON` |
| `STOP_ON_DUPLICATE_PAGE` | No | Default **on**: if page **N** returns the **same people** as page **N−1** (ContactOut often caps pagination and repeats the last page), the bot **stops without writing** that duplicate and tells you to change **`SEARCH_COUNTRY_LIST`**, **`CONTACTOUT_LOCATION`**, **`SEARCH_PROFILE`**, or **`CONTACTOUT_SEARCH_URL`**. Set `0` / `false` to disable |
| `HEADLESS` | No | Set to `1` or `true` to run Chromium headless |
| `PROXIES` | No | **JSON array**, bracket list, or one URL per line. If **`PROXIES_FILE`** is set too, both are **merged** (deduped) |
| `PROXIES_FILE` | No | Large list file, e.g. **`./ref/proxies.txt`** for [Proxifly](https://proxifly.dev)-style **`http://ip:port`** lines. Path is relative to the **project root** |
| `PROXY_URL` | No | One proxy server: `http://host:8080`, `http://user:pass@host:8080`, or `socks5://host:1080` |
| `PROXY_LIST` | No | Comma- or newline-separated list of proxies (rotates). Also: `PROXY_LIST_FILE` = path to a `.txt` (one proxy per line) |
| `PROXY_ROTATE_EVERY` | No | After this many **successful** page exports, switch to the next proxy (`0` = rotate only after HTTP **429**; needs **several** proxies in `PROXY_LIST`) |
| `PROXY_429_BACKOFF_MS` | No | Backoff when **429** and you are **not** using a proxy rotator (same browser); default `60000` |
| `PROXY_429_SLEEP_AFTER_SWAP_MS` | No | With proxies: optional pause **after** moving to the **next** proxy on **429** (default `0`). No long wait on the old IP |
| `PROXY_FAILOVER_MAX` | No | On errors like **`ERR_EMPTY_RESPONSE`** (dead proxy) or **`page.goto` timeout** (stuck/slow proxy), switch to the next proxy up to this many times **per navigation** (default `50`, capped by list size) |
| `PROXY_CLEAR_STORAGE_ON_429` | No | On **HTTP 429**, clear **cookies**, delete **`playwright-user-data/storage-state.json`**, and open a **new context** without that file (default: enabled). Set to `0` or `false` to **keep** login/session across 429 + proxy rotation. If you use **multiple emails**, session is **always** cleared on 429 so the next account can log in cleanly |
| `PROXY_HEALTH_CHECK` | No | If not `0`/`false`, each selected proxy is checked with an **HTTPS GET** before use (default: on). **Ping to 8.8.8.8 does not work through HTTP proxies** — this is the right test |
| `PROXY_HEALTH_CHECK_URL` | No | URL to fetch via the proxy (default `https://www.google.com/generate_204`). You can try `https://dns.google/resolve?name=google.com&type=A` etc. |
| `PROXY_HEALTH_TIMEOUT_MS` | No | Health request timeout (default `15000`) |
| `PROXY_HEALTH_MAX_TRIES` | No | How many proxies to try when looking for a live one (default `min(200, list length)`) |
| `PROXY_HEALTH_IGNORE_TLS` | No | Set `1` if health checks fail on bad TLS intercept proxies |

With any proxy env set, the bot uses **`chromium.launch()`** (not the persistent profile) and saves the session to **`playwright-user-data/storage-state.json`** so logins survive restarts. On **429**, it waits, switches to the **next** proxy if you configured **more than one**, and if you configured **more than one email**, it advances to the **next** account (same password) after clearing cookies / storage as needed.

Example `.env`:

```env
EMAIL_USER=you@example.com
# Or several accounts (429 rotates through them):
# EMAIL_USER1=first@example.com
# EMAIL_USER2=second@example.com
CONTACTOUT_PASSWORD=your-secret-password
CONTACTOUT_LOCATION=United States
MAX_PAGES=5
# HEADLESS=1
# Optional: base search URL (`page` is added automatically)
# CONTACTOUT_SEARCH_URL=https://contactout.com/dashboard/search?location=United%20States&login=success
# START_PAGE=4
# Proxy rotation (example)
# PROXIES=["http://user:pass@1.2.3.4:8000","socks5://user:pass@5.6.7.8:1080"]
# PROXIES_FILE=./ref/proxies.txt
# PROXY_URL=http://127.0.0.1:8888
# PROXY_LIST=http://user-a:pass@gate1.example.com:7777,http://user-b:pass@gate2.example.com:7777
# PROXY_ROTATE_EVERY=10
# PROXY_429_BACKOFF_MS=90000
```

Keep `.env` out of version control; it is listed in `.gitignore`. The default **`data/`** folder (search history) is gitignored too.

### Proxies and rate limits

Residential or rotating proxy providers are common for avoiding **429 Too Many Requests** on long runs. Use **`PROXY_LIST`** with multiple endpoints (or a file via **`PROXY_LIST_FILE`**) and set **`PROXY_ROTATE_EVERY`** to something like `10`–`15` so the outbound IP changes before hitting limits. Respect ContactOut’s terms and the proxy provider’s rules.

**SOCKS5 with username/password:** Chromium (and Playwright) does **not** support authenticated SOCKS5 directly. This project uses [**proxy-chain**](https://github.com/apify/proxy-chain) to start a small local **HTTP** proxy that forwards to your `socks5://user:pass@host:port` so the browser can connect. **`http://` proxies with auth** in the URL work without that extra step.

### Reachability vs `ping 8.8.8.8`

Traffic through an **HTTP/HTTPS proxy** does not use ICMP. The bot runs a small **HTTPS request** through the proxy (see **`PROXY_HEALTH_CHECK_URL`**) before startup and whenever it switches proxy — equivalent to “is this exit actually usable?”

### Free lists (e.g. Proxifly)

1. Paste Proxifly’s **`http://ip:port`** lines into **`ref/proxies.txt`** (one per line — your file is already in that shape).
2. In **`.env`** add:
   ```env
   PROXIES_FILE=./ref/proxies.txt
   ```
3. Optional: set **`PROXY_ROTATE_EVERY=5`** (or `10`) so each outbound IP is only used for a few pages before switching — free proxies often rate-limit or die quickly.
4. You can keep **`PROXIES=...`** in `.env` for paid/auth proxies; they are **combined** with the file list (duplicates removed).

Expect many free proxies to be **slow, blocked, or dead**; the bot **auto-switches** to the next proxy on common tunnel errors (`ERR_EMPTY_RESPONSE`, etc.) up to **`PROXY_FAILOVER_MAX`** times per page load. On **HTTP 429**, it **immediately** opens a **new** browser context on the **next** proxy (and can clear session — see **`PROXY_CLEAR_STORAGE_ON_429`**); it does **not** sit on the same IP for a long backoff first. Use **`PROXY_429_SLEEP_AFTER_SWAP_MS`** only if you want a short pause *after* the swap.

## Scrape logic (extension vs bot)

The DOM scraping rules live in `contactout_extension/content.js`. The bot loads a pre-wrapped copy in `scripts/contactout-scrape-dom-eval.js` (same columns as the extension popup). If you change the scrape logic in `content.js`, regenerate the eval bundle from the project root:

```bash
( printf '(function () {\n'; sed -n '5,391p' contactout_extension/content.js; printf '\n  return scrapeResults();\n})();\n'; ) > scripts/contactout-scrape-dom-eval.js
```

Then add the file header comment back at the top of `scripts/contactout-scrape-dom-eval.js` if you want to keep the “how to regenerate” note.

## Using the extension only (manual)

1. Open Chrome → **Extensions** → enable **Developer mode**.
2. **Load unpacked** → select the `contactout_extension` folder.
3. Go to a ContactOut people search results page, scroll if needed, click the extension icon → **Export CSV**.

## Troubleshooting

- **No rows / empty CSV** — Scroll the results list so profiles load; the scraper only sees links present in the DOM.
- **Location not applied** — The UI may use a custom control; set **United States** (or your target) once manually, then re-run or continue from that session. `playwright-user-data/` persists the profile between runs.
- **Login fails** — ContactOut may have changed the login DOM; update selectors in `scripts/contactout-export-bot.mjs`.
- **Scrape errors after site update** — Sync `content.js` and `scripts/contactout-scrape-dom-eval.js` as described above.

## Security

- Never commit `.env` or share credentials.
- Rotate passwords if they may have been exposed.

## Compliance

Automating logins and exporting data may conflict with ContactOut’s terms of service or applicable law. Use this tooling only where you have permission and for legitimate purposes.
