/**
 * Kaplan Learn API inspector
 *
 * Usage:
 *   node src/inspect-kaplan.mjs --url "https://www.kaplanlearn.com/education/dashboard/index/{hash}/qbank/{qbankId}/quiz/custom/{quizId}"
 *
 * Reads cookies from kaplan-cookie.txt (one long cookie header string).
 * Navigates to the quiz page, clicks through a few questions while
 * capturing ALL XHR/fetch network traffic, then writes a summary to
 * output/inspect-kaplan.json for analysis.
 */

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

// ── Args ───────────────────────────────────────────────────────────────────────

const DEFAULT_KAPLAN_URL =
  "https://www.kaplanlearn.com/education/dashboard/index/f8e79d5cf5f95014e5b159fdd7868de6/qbank/133123232/quiz/custom/398542489";

function parseArgs(argv) {
  const out = { url: DEFAULT_KAPLAN_URL, pages: 5, headless: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--url" && argv[i + 1]) { out.url = argv[++i]; continue; }
    if (argv[i] === "--pages" && argv[i + 1]) { out.pages = parseInt(argv[++i], 10) || 5; continue; }
    if (argv[i] === "--headless") { out.headless = true; continue; }
  }
  return out;
}

// ── Cookie helpers ─────────────────────────────────────────────────────────────

function loadCookieFile(filename) {
  const p = path.resolve(process.cwd(), filename);
  if (!fs.existsSync(p)) return "";
  return fs.readFileSync(p, "utf8").trim();
}

/**
 * Parse a raw cookie header string into Playwright addCookies() format.
 * Assigns cookies to both www.kaplanlearn.com and .kaplan.com so they're
 * sent on all Kaplan requests.
 */
function parseKaplanCookies(cookieStr) {
  // These cookies belong to the wide .kaplan.com domain
  const wideDomain = new Set(["_gcl_au", "_ga", "_gid", "OptanonConsent", "OptanonAlertBoxClosed"]);
  return cookieStr
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq === -1) return null;
      const name  = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const domain = wideDomain.has(name) ? ".kaplan.com" : "www.kaplanlearn.com";
      return { name, value, domain, path: "/", secure: true, httpOnly: false, sameSite: "Lax" };
    })
    .filter(Boolean);
}

// ── Main ───────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));

const cookieRaw = loadCookieFile("kaplan-cookie.txt");
if (!cookieRaw) {
  console.error("ERROR: kaplan-cookie.txt not found or empty.");
  console.error("  Paste your Kaplan cookie header string into kaplan-cookie.txt");
  process.exit(1);
}

const cookies = parseKaplanCookies(cookieRaw);
console.log(`Parsed ${cookies.length} cookies.`);
console.log(`Navigating to: ${args.url}`);

const browser = await chromium.launch({ headless: args.headless }); // headless when --headless flag passed
const context = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
});
await context.addCookies(cookies);

// ── Capture ALL network calls ──────────────────────────────────────────────────

const captured = []; // { type, url, method, requestBody, status, contentType, responseBody }

context.on("response", async (resp) => {
  const url = resp.url();
  // Only capture XHR/fetch (JSON/text, not images/fonts/scripts)
  const ct = resp.headers()["content-type"] || "";
  if (!ct.includes("json") && !ct.includes("text/plain") && !ct.includes("text/html")) return;
  // Skip static assets
  if (/\.(js|css|png|jpg|svg|woff|ico)(\?|$)/.test(url)) return;

  let responseBody = null;
  try {
    const text = await resp.text();
    try { responseBody = JSON.parse(text); }
    catch { responseBody = text.slice(0, 2000); }
  } catch { /* ignore */ }

  let requestBody = null;
  try {
    const pd = resp.request().postData();
    if (pd) {
      try { requestBody = JSON.parse(pd); }
      catch { requestBody = pd.slice(0, 500); }
    }
  } catch { /* ignore */ }

  const entry = {
    url,
    method: resp.request().method(),
    status: resp.status(),
    contentType: ct,
    requestBody,
    responseBody,
  };
  captured.push(entry);

  const bodyPreview = typeof responseBody === "object"
    ? JSON.stringify(responseBody).slice(0, 120)
    : String(responseBody).slice(0, 120);
  console.log(`  [${resp.status()}] ${resp.request().method()} ${url}`);
  console.log(`       ↳ ${bodyPreview}`);
});

const page = await context.newPage();
await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 3000));

// Snapshot initial state
const title = await page.title().catch(() => "");
const bodyText = await page.locator("body").innerText().catch(() => "");
console.log(`\nPage title: ${title}`);
console.log(`Body text (first 600): ${bodyText.slice(0, 600)}`);

const btnTexts = await page.locator("button, a[role='button']").allTextContents().catch(() => []);
console.log(`Buttons visible: ${btnTexts.filter((t) => t.trim()).slice(0, 20).join(" | ")}`);

// ── Click through a few questions ─────────────────────────────────────────────

const NEXT_SELECTORS = [
  "button:has-text('Next')",
  "button:has-text('next')",
  "a:has-text('Next')",
  "[data-action='next']",
  "button.next",
  ".next-btn",
  "button:has-text('Continue')",
  "button:has-text('Submit')",
];

async function clickNext(p) {
  for (const sel of NEXT_SELECTORS) {
    try {
      const loc = p.locator(sel).first();
      if ((await loc.count()) === 0) continue;
      if (!(await loc.isVisible({ timeout: 1000 }).catch(() => false))) continue;
      if (await loc.isDisabled({ timeout: 1000 }).catch(() => true)) continue;
      console.log(`  → Clicking: ${sel}`);
      await loc.click({ timeout: 5000 });
      return true;
    } catch { /* try next */ }
  }
  return false;
}

for (let i = 1; i <= args.pages; i++) {
  console.log(`\n--- Clicking Next (page ${i}/${args.pages}) ---`);
  const clicked = await clickNext(page);
  if (!clicked) {
    console.log("  No clickable Next button found, stopping.");
    break;
  }
  await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2000));
}

// ── Save results ───────────────────────────────────────────────────────────────

const outDir  = path.resolve(process.cwd(), "output");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "inspect-kaplan.json");
fs.writeFileSync(outFile, JSON.stringify(captured, null, 2), "utf8");

console.log(`\n=== Inspection complete ===`);
console.log(`  Total API calls captured : ${captured.length}`);
console.log(`  Output                   : ${outFile}`);

// Print a URL summary
const uniqueUrls = [...new Set(captured.map((c) => c.url))];
console.log(`\nUnique URLs intercepted:`);
for (const u of uniqueUrls) console.log(`  ${u}`);

await browser.close();
