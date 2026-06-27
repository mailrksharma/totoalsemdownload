/**
 * TotalSem content capture script
 *
 * Auth options (checked in order):
 *  1. --cookie "session=..."  CLI flag
 *  2. TOTALSEM_COOKIE env var
 *  3. cookie.txt file in project root
 *  4. Interactive browser login (fallback)
 *
 * When a cookie + quiz ID are both known, runs fully headless with no browser window.
 *
 * Flow:
 *  A. Cookie mode (headless):  inject cookie -> fetch quiz meta -> direct API fetch all questions
 *  B. Browser mode:  open browser -> login -> intercept -> direct fetch or Next-click fallback
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { chromium } from "playwright";

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_URL = "https://hub.totalsem.com/content/25056";
const DEFAULT_MAX_PAGES = 400;
const API_ORIGIN = "https://hub.totalsem.com";
const QUIZ_API_RE = /\/tto\/quizzes\/(\d+)\/(\d+)/;

// AppSync / Wiley study platform
const APPSYNC_GRAPHQL_RE = /appsync-api\.[^/]+\.amazonaws\.com\/graphql/;
const WILEY_STUDY_HOST_RE = /(?:^|\.)(?:learning\.wiley\.com|study\.learning\.wiley\.com)$/;

// Kaplan Learn platform
const KAPLAN_GQL_ENDPOINT = "https://gql.kaplanlearn.com/graphql";
const KAPLAN_HOST_RE = /(?:^|\.)kaplanlearn\.com$/;
// URL shape: /education/dashboard/index/{hash}/qbank/{enrollmentDetailId}/quiz/custom/{testId}
const KAPLAN_URL_RE = /\/qbank\/(\d+)\/quiz\/(?:custom|timed)\/(\d+)/;

// ── Argument parsing ───────────────────────────────────────────────────────────

function parseArgs(argv) {
  const parsed = {
    url: DEFAULT_URL,
    maxPages: DEFAULT_MAX_PAGES,
    outputFile: "",
    cookie: "",        // full cookie header value, e.g. "session=ABC123"
    quizId: "",        // skip browser discovery when known, e.g. "2091291"
    headless: false,
    // Wiley / AppSync mode
    wileyAuth: "",     // full JWT value for AppSync `authorization` header (optional)
    wileyApiKey: "",   // x-api-key header value for AppSync (optional)
    wileyCookie: "",   // full browser cookie string for study.learning.wiley.com
    // Kaplan Learn mode
    kaplanCookie: "",  // full browser cookie string for kaplanlearn.com
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--url" && argv[i + 1])            { parsed.url = argv[++i]; continue; }
    if (arg === "--max-pages" && argv[i + 1]) {
      const n = Number.parseInt(argv[++i], 10);
      if (Number.isFinite(n) && n > 0) parsed.maxPages = n;
      continue;
    }
    if (arg === "--output" && argv[i + 1])         { parsed.outputFile = argv[++i]; continue; }
    if (arg === "--cookie" && argv[i + 1])         { parsed.cookie = argv[++i]; continue; }
    if (arg === "--quiz-id" && argv[i + 1])        { parsed.quizId = argv[++i]; continue; }
    if (arg === "--headless")                      { parsed.headless = true; continue; }
    if (arg === "--wiley-auth" && argv[i + 1])     { parsed.wileyAuth = argv[++i]; continue; }
    if (arg === "--wiley-api-key" && argv[i + 1])  { parsed.wileyApiKey = argv[++i]; continue; }
    if (arg === "--wiley-cookie" && argv[i + 1])   { parsed.wileyCookie = argv[++i]; continue; }
    if (arg === "--kaplan-cookie" && argv[i + 1])  { parsed.kaplanCookie = argv[++i]; continue; }
  }
  return parsed;
}

/** Load session cookie from --cookie arg, env var, or cookie.txt file. */
function resolveCookie(argCookie) {
  if (argCookie) return argCookie.trim();
  if (process.env.TOTALSEM_COOKIE) return process.env.TOTALSEM_COOKIE.trim();
  const cookieFile = path.resolve(process.cwd(), "cookie.txt");
  if (fs.existsSync(cookieFile)) {
    const raw = fs.readFileSync(cookieFile, "utf8").trim();
    if (raw) return raw;
  }
  return "";
}

/** Load Wiley browser cookies from --wiley-cookie arg, env var, or wiley-cookie.txt file. */
function resolveWileyCookie(argCookie) {
  if (argCookie) return argCookie.trim();
  if (process.env.WILEY_COOKIE) return process.env.WILEY_COOKIE.trim();
  const cookieFile = path.resolve(process.cwd(), "wiley-cookie.txt");
  if (fs.existsSync(cookieFile)) {
    const raw = fs.readFileSync(cookieFile, "utf8").trim();
    if (raw) return raw;
  }
  return "";
}

/** Load Kaplan browser cookies from --kaplan-cookie arg, env var, or kaplan-cookie.txt file. */
function resolveKaplanCookie(argCookie) {
  if (argCookie) return argCookie.trim();
  if (process.env.KAPLAN_COOKIE) return process.env.KAPLAN_COOKIE.trim();
  const cookieFile = path.resolve(process.cwd(), "kaplan-cookie.txt");
  if (fs.existsSync(cookieFile)) {
    const raw = fs.readFileSync(cookieFile, "utf8").trim();
    // Skip comment lines
    const lines = raw.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("");
    if (lines.trim()) return lines.trim();
  }
  return "";
}

/**
 * Parse a Kaplan cookie header string into Playwright addCookies() format.
 * Analytics/opt-in cookies go to .kaplan.com; session cookies to www.kaplanlearn.com.
 */
function parseKaplanCookies(cookieStr) {
  const wideDomain = new Set(["_gcl_au", "_ga", "_gid", "OptanonConsent", "OptanonAlertBoxClosed", "dtCookie"]);
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

/**
 * Parse a cookie header string like "session=VALUE; other=X" into Playwright
 * addCookies() format for hub.totalsem.com.
 */
function parseCookies(cookieStr) {
  return cookieStr
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq === -1) return null;
      return {
        name: pair.slice(0, eq).trim(),
        value: pair.slice(eq + 1).trim(),
        domain: "hub.totalsem.com",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      };
    })
    .filter(Boolean);
}

/**
 * Parse a Wiley browser cookie string into Playwright addCookies() format.
 * Covers all *.wiley.com subdomains that the study platform uses.
 */
function parseWileyCookies(cookieStr) {
  // Cookies that belong to a wider domain (e.g. .wiley.com)
  const wideDomainNames = new Set(["ALM-token", "RefreshToken", "X-NG-JWT-TOKEN"]);
  return cookieStr
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq === -1) return null;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const domain = wideDomainNames.has(name) ? ".wiley.com" : "study.learning.wiley.com";
      return { name, value, domain, path: "/", secure: true, httpOnly: false, sameSite: "Lax" };
    })
    .filter(Boolean);
}

// ── JWT / AppSync helpers ──────────────────────────────────────────────────────

/** Decode the payload of a JWT without verifying the signature. */
function parseJwtPayload(jwt) {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch { return null; }
}

/** Build headers for an AppSync POST request. */
function buildAppSyncHeaders(authToken, apiKey) {
  const headers = { "Content-Type": "application/json", Accept: "*/*" };
  if (authToken) headers["authorization"] = authToken;
  if (apiKey)    headers["x-api-key"]     = apiKey;
  return headers;
}

/** POST a single GraphQL body to the AppSync endpoint. */
async function fetchAppSyncQuery(apiRequest, endpoint, authToken, apiKey, body) {
  try {
    const resp = await apiRequest.post(endpoint, {
      headers: buildAppSyncHeaders(authToken, apiKey),
      data: JSON.stringify(body),
      timeout: 20000,
    });
    if (!resp.ok()) {
      console.warn(`  [appsync] HTTP ${resp.status()} from ${endpoint}`);
      return null;
    }
    return await resp.json();
  } catch (err) {
    console.warn(`  [appsync] Error: ${err.message}`);
    return null;
  }
}

/**
 * Walk a GraphQL response value and collect objects that look like questions.
 * Falls back to collecting the raw data object if nothing question-shaped is found.
 */
function extractQuestionsFromGraphQL(value, results = []) {
  if (!value || typeof value !== "object") return results;
  if (Array.isArray(value)) {
    for (const item of value) extractQuestionsFromGraphQL(item, results);
    return results;
  }
  // Heuristic: an object with an `id` and a text-like field is a question.
  const textKeys = ["question_text", "questionText", "question", "body", "stem", "content"];
  if (value.id && textKeys.some((k) => typeof value[k] === "string")) {
    results.push(value);
    return results;
  }
  for (const val of Object.values(value)) {
    if (val && typeof val === "object") extractQuestionsFromGraphQL(val, results);
  }
  return results;
}

// ── Wiley GraphQL query/mutation strings ──────────────────────────────────────

const GQL_GET_QUESTION = `query GetQuestionWithAttempt($assessmentAttemptId: String!, $questionId: String!, $itemId: String!) {
  getQuestionWithAttempt(
    assessmentAttemptId: $assessmentAttemptId
    contentId: $questionId
    itemId: $itemId
  ) {
    attempt {
      showAnswer correctAnswer correctness attemptTime
      maxAttempts numAttempts attemptsLeft data explanation __typename
    }
    question { id name provider status title version content __typename }
    __typename
  }
}`;

const GQL_CREATE_ATTEMPT = `mutation createAttempt($assessmentAttemptId: String!, $questionId: String!, $itemId: String!, $data: String) {
  createAttempt(
    input: {assessmentAttemptId: $assessmentAttemptId, contentId: $questionId, itemId: $itemId, data: $data}
  ) {
    attemptId correctness maxAttempts numAttempts attemptsLeft
    showAnswer attemptTime correctAnswer explanation data __typename
  }
}`;

/** Strip HTML tags and decode common entities from a string. */
function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ").replace(/&#160;/g, " ")
    .replace(/\s+/g, " ").trim();
}

/**
 * Normalize a Wiley question + attempt pair into a clean object.
 *
 * question  – the `question` sub-object from `getQuestionWithAttempt`
 * attempt   – the `createAttempt` response body (has correctAnswer + explanation)
 */
function normalizeWileyQuestion(question, attempt) {
  let content = {};
  try { content = JSON.parse(question.content); } catch { /* use empty */ }

  const questionKey = content.questionKey || "";
  const renderItems = content.renderItems || [];

  // First renderItem with displayText = question text
  const questionText = stripHtml(renderItems.find(r => r.displayText)?.displayText || "");

  // optionsValues array
  const optionsValues = renderItems.find(r => r.optionsValues)?.optionsValues || [];
  const choices = optionsValues.map(o => ({
    value: o.value,
    label: stripHtml(o.label),
  }));

  // Parse correctAnswer from createAttempt response
  let correctValue = null;
  if (attempt?.correctAnswer) {
    try {
      const ca = JSON.parse(attempt.correctAnswer);
      // Shape: { "questionKey": [{ "value": "..." }] }
      const entries = Object.values(ca);
      if (entries.length > 0 && Array.isArray(entries[0])) {
        correctValue = entries[0][0]?.value || null;
      }
    } catch { /* ignore */ }
  }
  const correctChoice = choices.find(c => c.value === correctValue) || null;

  // Parse explanation
  let explanation = "";
  if (attempt?.explanation) {
    try {
      const exp = JSON.parse(attempt.explanation);
      explanation = exp.map(e => stripHtml(e.displayText || "")).join(" ").trim();
    } catch { explanation = stripHtml(attempt.explanation); }
  }

  return {
    id: question.id,
    title: question.title,
    question_text: questionText,
    answer_choices: choices,
    correct_answer_value: correctValue,
    correct_answer_label: correctChoice?.label || null,
    explanation,
    question_key: questionKey,
  };
}

function nowStamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}-${String(d.getHours()).padStart(2,"0")}${String(d.getMinutes()).padStart(2,"0")}${String(d.getSeconds()).padStart(2,"0")}`;
}

async function prompt(message) {
  const rl = readline.createInterface({ input, output });
  try { await rl.question(message); } finally { rl.close(); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Intercept store ────────────────────────────────────────────────────────────

function makeStore() {
  const store = { quizId: null, questionIds: new Set(), listPayload: null };

  async function onResponse(response) {
    const url = response.url();
    if (!url.includes("/tto/")) return;
    const ct = response.headers()["content-type"] || "";
    if (!ct.includes("json")) return;

    const m = url.match(QUIZ_API_RE);
    if (m) {
      store.quizId = m[1];
      store.questionIds.add(m[2]);
      return;
    }

    const listMatch = url.match(/\/tto\/quizzes\/(\d+)(?:\?.*)?$/);
    if (listMatch) {
      store.quizId = listMatch[1];
      try {
        const data = await response.json();
        if (data && (Array.isArray(data) || typeof data === "object")) {
          store.listPayload = data;
          console.log(`  [intercept] Quiz list endpoint: ${url}`);
        }
      } catch { /* ignore */ }
    }
  }

  return { store, onResponse };
}

// ── AppSync / Wiley intercept store ───────────────────────────────────────────

function makeAppSyncStore() {
  const store = {
    authToken: null,
    apiKey: null,
    endpoint: null,
    capturedRequests: [],  // [{ query, variables, operationName }]
    responses: [],         // raw parsed JSON bodies
  };

  async function onRequest(request) {
    const url = request.url();
    if (!APPSYNC_GRAPHQL_RE.test(url)) return;
    store.endpoint = store.endpoint || url;
    const headers = request.headers();
    if (headers["authorization"] && !store.authToken) {
      store.authToken = headers["authorization"];
      console.log(`  [appsync] Auth token captured`);
    }
    if (headers["x-api-key"] && !store.apiKey) {
      store.apiKey = headers["x-api-key"];
    }
    try {
      const body = request.postDataJSON();
      if (body) {
        store.capturedRequests.push({
          query: body.query,
          variables: body.variables,
          operationName: body.operationName,
        });
        const label = body.operationName || (body.query || "").trim().slice(0, 60);
        console.log(`  [appsync] Request captured: ${label}`);
      }
    } catch { /* ignore */ }
  }

  async function onResponse(response) {
    const url = response.url();
    if (!APPSYNC_GRAPHQL_RE.test(url)) return;
    const ct = response.headers()["content-type"] || "";
    if (!ct.includes("json")) return;
    try {
      const data = await response.json();
      if (data) {
        store.responses.push(data);
        console.log(`  [appsync] Response captured (${JSON.stringify(data).length} bytes)`);
      }
    } catch { /* ignore */ }
  }

  return { store, onRequest, onResponse };
}

// ── Question ID extraction ─────────────────────────────────────────────────────

function extractIds(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) {
    const ids = payload
      .map((item) => (item && typeof item === "object" ? (item.id || item.question_id) : item))
      .filter(Boolean)
      .map(String);
    if (ids.length > 0) return ids;
  }
  for (const key of ["questions", "items", "quiz_questions", "question_ids"]) {
    if (Array.isArray(payload[key])) {
      const ids = payload[key]
        .map((item) => (item && typeof item === "object" ? (item.id || item.question_id) : item))
        .filter(Boolean)
        .map(String);
      if (ids.length > 0) return ids;
    }
  }
  return [];
}

// ── Direct API helpers ─────────────────────────────────────────────────────────

function buildHeaders(cookieStr) {
  const headers = { Accept: "application/json, text/plain, */*" };
  if (cookieStr) headers["Cookie"] = cookieStr;
  return headers;
}

async function fetchQuestion(apiRequest, quizId, questionId, cookieStr = "") {
  const url = `${API_ORIGIN}/tto/quizzes/${quizId}/${questionId}`;
  try {
    const resp = await apiRequest.get(url, {
      headers: buildHeaders(cookieStr),
      timeout: 15000,
    });
    if (!resp.ok()) { console.warn(`  [fetch] HTTP ${resp.status()} for ${url}`); return null; }
    return await resp.json();
  } catch (err) {
    console.warn(`  [fetch] Error fetching ${url}: ${err.message}`);
    return null;
  }
}

async function fetchQuizMeta(apiRequest, quizId, cookieStr = "") {
  const url = `${API_ORIGIN}/tto/quizzes/${quizId}`;
  console.log(`  [meta] GET ${url}`);
  try {
    const resp = await apiRequest.get(url, {
      headers: buildHeaders(cookieStr),
      timeout: 15000,
    });
    if (!resp.ok()) return null;
    return await resp.json();
  } catch { return null; }
}

// ── Browser Next-click helpers ─────────────────────────────────────────────────

const NEXT_SELECTORS = [
  "button:has-text('Next')",
  "a:has-text('Next')",
  "[aria-label*='next' i]",
  "[data-action='next']",
  "button.next",
  ".next-btn",
];

async function clickNext(page) {
  for (const sel of NEXT_SELECTORS) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) === 0) continue;
      if (!(await loc.isVisible({ timeout: 1000 }).catch(() => false))) continue;
      if (await loc.isDisabled({ timeout: 1000 }).catch(() => true)) continue;
      await loc.click({ timeout: 5000 });
      return true;
    } catch { /* try next */ }
  }
  return false;
}

// ── Wiley / AppSync mode ──────────────────────────────────────────────────────

async function runWileyMode(args, outputFile) {
  const wileyAuth    = args.wileyAuth;
  const wileyApiKey  = args.wileyApiKey;
  const wileyCookie  = resolveWileyCookie(args.wileyCookie);

  console.log(`\n[MODE] Wiley / AppSync GraphQL capture`);
  console.log(`  URL          : ${args.url}`);

  if (wileyCookie) {
    console.log(`  Browser cookie: ${wileyCookie.slice(0, 40)}...`);
  }
  if (wileyAuth) {
    const decoded = parseJwtPayload(wileyAuth);
    const p = decoded?.payload ?? decoded ?? {};
    console.log(`  Assessment ID: ${p.assessmentId || p.assessmentid || "(unknown)"}`);
    console.log(`  Auth token   : ${wileyAuth.slice(0, 30)}...`);
  }

  // Run headless when we have cookies or an explicit auth token.
  const headless = !!(wileyCookie || wileyAuth) || args.headless;
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();

  // Inject Wiley browser cookies before the first navigation.
  if (wileyCookie) {
    const parsed = parseWileyCookies(wileyCookie);
    await context.addCookies(parsed);
    console.log(`  Injected ${parsed.length} Wiley cookie(s).`);
  }

  // ── AppSync session state ─────────────────────────────────────────────────
  let appSyncEndpoint = null;
  let appSyncAuth     = wileyAuth || null;
  let appSyncApiKey   = wileyApiKey || null;
  let assessmentAttemptId = null;
  // Latest question from GetQuestionWithAttempt (pending pairing with createAttempt)
  let pendingQuestion = null;

  context.on("request", (req) => {
    const url = req.url();
    if (!APPSYNC_GRAPHQL_RE.test(url)) return;
    appSyncEndpoint = appSyncEndpoint || url;
    const h = req.headers();
    if (h["authorization"] && !appSyncAuth) {
      appSyncAuth = h["authorization"];
      console.log(`  [appsync] Auth token captured`);
    }
    if (h["x-api-key"] && !appSyncApiKey) appSyncApiKey = h["x-api-key"];
  });

  // ── Collected results ─────────────────────────────────────────────────────
  const collected = [];
  const seenIds   = new Set();

  function saveQuestion(normalized) {
    if (!normalized || seenIds.has(normalized.id)) return false;
    seenIds.add(normalized.id);
    collected.push(normalized);
    fs.writeFileSync(outputFile, JSON.stringify(collected, null, 2), "utf8");
    return true;
  }

  /** Given a raw GetQuestionWithAttempt response, submit createAttempt and return normalized. */
  async function fetchAndNormalize(qwaResponse) {
    const qwa = qwaResponse?.data?.getQuestionWithAttempt;
    if (!qwa?.question) return null;

    const question = qwa.question;
    const existing = qwa.attempt;

    // If attempt already has answer (previously submitted), use it directly
    if (existing?.showAnswer && existing?.correctAnswer) {
      return normalizeWileyQuestion(question, existing);
    }

    // Need to call createAttempt to get correct answer
    if (!appSyncEndpoint || !appSyncAuth || !assessmentAttemptId) return null;

    // Pick first option as our dummy submission
    let content = {};
    try { content = JSON.parse(question.content); } catch { /* ignore */ }
    const questionKey = content.questionKey || "";
    const options = content.renderItems?.find(r => r.optionsValues)?.optionsValues || [];
    if (options.length === 0) return null;

    const submitData = JSON.stringify([{ questionKey, values: [options[0].value] }]);
    const attemptResp = await fetchAppSyncQuery(
      context.request, appSyncEndpoint, appSyncAuth, appSyncApiKey,
      {
        operationName: "createAttempt",
        query: GQL_CREATE_ATTEMPT,
        variables: {
          assessmentAttemptId,
          questionId: question.id,
          itemId:     question.id,
          data:       submitData,
        },
      }
    );

    const attemptData = attemptResp?.data?.createAttempt || null;
    return normalizeWileyQuestion(question, attemptData);
  }

  // ── Intercept GetQuestionWithAttempt responses ────────────────────────────
  context.on("response", async (resp) => {
    const url = resp.url();
    if (!APPSYNC_GRAPHQL_RE.test(url)) return;
    const ct = resp.headers()["content-type"] || "";
    if (!ct.includes("json")) return;
    try {
      const body = await resp.json();
      const reqBody = JSON.parse(resp.request().postData() || "{}");
      const op = reqBody.operationName || "";

      if (op === "GetQuestionWithAttempt" || op === "getQuestionWithAttempt") {
        // Capture assessmentAttemptId for later use
        if (!assessmentAttemptId && reqBody.variables?.assessmentAttemptId) {
          assessmentAttemptId = reqBody.variables.assessmentAttemptId;
          console.log(`  [appsync] assessmentAttemptId: ${assessmentAttemptId}`);
        }
        pendingQuestion = body;
      }
    } catch { /* ignore */ }
  });

  const page = await context.newPage();

  if (args.url && args.url !== DEFAULT_URL) {
    console.log(`\nNavigating to: ${args.url}`);
    await page.goto(args.url, { waitUntil: "domcontentloaded" });
  }

  if (!wileyCookie && !wileyAuth) {
    console.log("\n>>> Log in at study.learning.wiley.com in the browser window.");
    console.log(">>> Navigate to the assessment/quiz page so questions are loading.");
    await prompt(">>> Press Enter here once you are on a question page: ");
  }

  console.log("\nCapture starting...\n");
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await sleep(2000);

  // Process the question already loaded on page 1
  if (pendingQuestion) {
    const norm = await fetchAndNormalize(pendingQuestion);
    if (norm && saveQuestion(norm)) {
      console.log(`  [1] "${norm.question_text.slice(0, 70)}..." → correct: ${norm.correct_answer_label || "?"}`);
    }
    pendingQuestion = null;
  }

  // ── Next-click loop ───────────────────────────────────────────────────────
  let stopReason = "max-pages";
  for (let pageNum = 2; pageNum <= args.maxPages; pageNum++) {
    pendingQuestion = null;

    // Wait for the next GetQuestionWithAttempt response while clicking Next
    const questionResponsePromise = page.waitForResponse(
      (resp) => APPSYNC_GRAPHQL_RE.test(resp.url()),
      { timeout: 15000 }
    ).catch(() => null);

    const clicked = await clickNext(page);
    if (!clicked) { stopReason = "next-not-found-or-disabled"; break; }

    await questionResponsePromise;
    await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
    // Brief extra pause to ensure async handler completes resp.json() processing
    await sleep(800);

    if (!pendingQuestion) { stopReason = "no-new-question-captured"; break; }

    const norm = await fetchAndNormalize(pendingQuestion);
    if (!norm) { console.warn(`  [${pageNum}] Could not normalize question, skipping.`); continue; }

    if (saveQuestion(norm)) {
      console.log(`  [${collected.length}] "${norm.question_text.slice(0, 70)}..." → correct: ${norm.correct_answer_label || "?"}`);
    } else {
      console.log(`  [${pageNum}] Duplicate, skipped.`);
    }
  }
  console.log(`\nStop reason: ${stopReason}`);

  await context.close();
  await browser.close();

  console.log("\n=== Wiley capture complete ===");
  console.log(`  Questions saved : ${collected.length}`);
  console.log(`  Output file     : ${outputFile}`);
}

// ── Kaplan Learn / GraphQL mode ────────────────────────────────────────────────

const GQL_KAPLAN_QUIZ_META = `query RUNNER_QUIZ_QUERY($enrollmentDetailId: Int!, $testId: Int!) {
  person {
    learner {
      qbank(enrollmentDetailId: $enrollmentDetailId) {
        quiz(testId: $testId) {
          testId
          name
          totalQuestions
          status
          questions {
            questionId
            testQuestionId
            sortOrder
            questionDifficulty
            __typename
          }
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}`;

const GQL_KAPLAN_QUESTION = `query RUNNER_QUIZ_QUESTION_QUERY($enrollmentDetailId: Int!, $testId: Int!, $questionId: Int!) {
  person {
    learner {
      qbank(enrollmentDetailId: $enrollmentDetailId) {
        quiz(testId: $testId) {
          question(position: $questionId) {
            explanation
            questionId
            testQuestionId
            questionText
            questionTypeId
            sortOrder
            questionDifficulty
            correctOptionCount
            options {
              optionText
              isCorrect
              questionOptionId
              __typename
            }
            __typename
          }
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}`;

/** Post a single GraphQL operation to the Kaplan GQL endpoint. */
async function fetchKaplanGQL(apiRequest, authHeaders, body) {
  try {
    const resp = await apiRequest.post(KAPLAN_GQL_ENDPOINT, {
      headers: {
        "Content-Type": "application/json",
        Accept: "*/*",
        ...authHeaders,
      },
      data: JSON.stringify(body),
      timeout: 20000,
    });
    if (!resp.ok()) {
      console.warn(`  [kaplan] HTTP ${resp.status()} from GQL endpoint`);
      return null;
    }
    const arr = await resp.json();
    // Response is always an array with one element
    return Array.isArray(arr) ? arr[0] : arr;
  } catch (err) {
    console.warn(`  [kaplan] Error: ${err.message}`);
    return null;
  }
}

/** Normalize a Kaplan question object into the project's standard shape. */
function normalizeKaplanQuestion(q) {
  const choices = (q.options || []).map((o) => ({
    option_id: o.questionOptionId,
    text: stripHtml(o.optionText || ""),
    is_correct: !!o.isCorrect,
  }));
  const correct = choices.filter((c) => c.is_correct).map((c) => c.text);
  return {
    id: q.questionId,
    test_question_id: q.testQuestionId,
    sort_order: q.sortOrder,
    question_type: q.questionTypeId,
    difficulty: q.questionDifficulty,
    question_text: stripHtml(q.questionText || ""),
    answer_choices: choices,
    correct_answers: correct,
    explanation: stripHtml(q.explanation || ""),
  };
}

async function runKaplanMode(args, kaplanCookie, outputFile) {
  const urlMatch = args.url.match(KAPLAN_URL_RE);
  if (!urlMatch) {
    console.error("ERROR: Could not parse enrollmentDetailId/testId from URL.");
    console.error("  Expected: .../qbank/{enrollmentDetailId}/quiz/custom/{testId}");
    process.exitCode = 1;
    return;
  }
  const enrollmentDetailId = Number(urlMatch[1]);
  const testId             = Number(urlMatch[2]);

  console.log(`\n[MODE] Kaplan Learn GraphQL capture`);
  console.log(`  URL                : ${args.url}`);
  console.log(`  enrollmentDetailId : ${enrollmentDetailId}`);
  console.log(`  testId             : ${testId}`);
  console.log(`  Cookie             : ${kaplanCookie.slice(0, 40)}...`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addCookies(parseKaplanCookies(kaplanCookie));

  // ── Step 1: Navigate to quiz page, intercept first GQL call for auth headers ─
  console.log("\n  Navigating to quiz page to capture auth headers...");
  let authHeaders = null;
  context.on("request", (req) => {
    if (!authHeaders && req.url().includes("gql.kaplanlearn.com/graphql")) {
      const h = req.headers();
      if (h["authorization"]) {
        authHeaders = {
          authorization: h["authorization"],
          ...(h["x-graviton-caller"] ? { "x-graviton-caller": h["x-graviton-caller"] } : {}),
          ...(h["referer"] ? { referer: h["referer"] } : {}),
        };
        console.log(`  Auth headers captured (${Object.keys(authHeaders).join(", ")})`);
      }
    }
  });

  const page = await context.newPage();
  await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 30000 });
  // Wait for React to boot and fire the first GQL call
  await page.waitForFunction(() => typeof window !== "undefined", { timeout: 10000 }).catch(() => {});
  await sleep(5000); // give React app time to fire GQL calls

  if (!authHeaders) {
    // Fallback: extract JWT from localStorage (set by the page's inline script)
    const jwt = await page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem("Kap") || "{}").jwt || ""; } catch { return ""; }
    }).catch(() => "");
    if (jwt) {
      authHeaders = { authorization: `Bearer ${jwt}`, "x-graviton-caller": "12d02a27" };
      console.log("  Auth headers from localStorage JWT");
    } else {
      console.error("  ERROR: Could not capture auth headers. Cookie may be expired.");
      await browser.close();
      process.exitCode = 1;
      return;
    }
  }

  await page.close();

  // ── Step 2: Fetch quiz metadata (all question positions) ─────────────────
  console.log("\n  Fetching quiz metadata...");
  const metaResp = await fetchKaplanGQL(context.request, authHeaders, {
    operationName: "RUNNER_QUIZ_QUERY",
    variables: { enrollmentDetailId, testId },
    query: GQL_KAPLAN_QUIZ_META,
  });

  const quiz = metaResp?.data?.person?.learner?.qbank?.quiz?.[0];
  if (!quiz) {
    console.error("  ERROR: Could not fetch quiz metadata. Cookie may be expired.");
    console.error("  Raw response:", JSON.stringify(metaResp).slice(0, 300));
    await browser.close();
    process.exitCode = 1;
    return;
  }

  const quizName       = quiz.name || `quiz-${testId}`;
  const totalQuestions = quiz.totalQuestions || quiz.questions?.length || 0;
  const positions      = (quiz.questions || [])
    .map((q) => q.sortOrder)
    .sort((a, b) => a - b);

  console.log(`  Quiz name         : ${quizName}`);
  console.log(`  Total questions   : ${totalQuestions}`);
  console.log(`  Positions to fetch: ${positions.length}`);

  if (positions.length === 0) {
    console.error("  ERROR: No questions found in quiz metadata.");
    await browser.close();
    process.exitCode = 1;
    return;
  }

  // ── Step 3: Fetch each question by position ───────────────────────────────
  const collected = [];
  const seenIds   = new Set();
  const limit     = Math.min(positions.length, args.maxPages);

  console.log(`\n  Fetching ${limit} questions...\n`);

  for (let i = 0; i < limit; i++) {
    const position = positions[i];
    const qResp = await fetchKaplanGQL(context.request, authHeaders, {
      operationName: "RUNNER_QUIZ_QUESTION_QUERY",
      variables: { enrollmentDetailId, testId, questionId: position },
      query: GQL_KAPLAN_QUESTION,
    });

    const rawQ = qResp?.data?.person?.learner?.qbank?.quiz?.[0]?.question;
    if (!rawQ) {
      console.warn(`  [${i + 1}/${limit}] position ${position}: no data returned`);
      continue;
    }

    const norm = normalizeKaplanQuestion(rawQ);
    if (!seenIds.has(norm.id)) {
      seenIds.add(norm.id);
      collected.push(norm);
      fs.writeFileSync(outputFile, JSON.stringify(collected, null, 2), "utf8");
      const preview = norm.question_text.slice(0, 70);
      const correct = norm.correct_answers[0] || "?";
      console.log(`  [${collected.length}/${limit}] "${preview}..." → ${correct.slice(0, 50)}`);
    }

    // Polite pacing: brief pause every 10 questions
    if ((i + 1) % 10 === 0) await sleep(300);
  }

  await context.close();
  await browser.close();

  console.log(`\n=== Kaplan capture complete ===`);
  console.log(`  Questions saved : ${collected.length}`);
  console.log(`  Output file     : ${outputFile}`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cookieStr = resolveCookie(args.cookie);
  const outDir = path.resolve(process.cwd(), "output");
  fs.mkdirSync(outDir, { recursive: true });
  const outputFile = args.outputFile
    ? path.resolve(process.cwd(), args.outputFile)
    : path.join(outDir, `totalsem-${nowStamp()}.json`);

  // ── Route to Kaplan Learn mode ───────────────────────────────────────────
  const isKaplanUrl = (() => {
    try { return KAPLAN_HOST_RE.test(new URL(args.url).hostname); } catch { return false; }
  })();
  const kaplanCookieResolved = resolveKaplanCookie(args.kaplanCookie);
  if (isKaplanUrl || kaplanCookieResolved) {
    if (!kaplanCookieResolved) {
      console.error("ERROR: Kaplan URL detected but no cookie found.");
      console.error("  Add your Kaplan cookie string to kaplan-cookie.txt or pass --kaplan-cookie");
      process.exitCode = 1;
      return;
    }
    const safeOutputFile = args.outputFile
      ? path.resolve(process.cwd(), args.outputFile)
      : path.join(outDir, `kaplan-${nowStamp()}.json`);
    return runKaplanMode(args, kaplanCookieResolved, safeOutputFile);
  }

  // ── Route to Wiley / AppSync mode when appropriate ────────────────────────
  const isWileyUrl = (() => {
    try { return WILEY_STUDY_HOST_RE.test(new URL(args.url).hostname); } catch { return false; }
  })();
  const wileyCookieResolved = resolveWileyCookie(args.wileyCookie);
  // Don't route to Wiley mode if a TotalSem quiz ID was explicitly provided
  if (!args.quizId && (isWileyUrl || args.wileyAuth || wileyCookieResolved)) {
    return runWileyMode(args, outputFile);
  }

  // ── Cookie-only headless mode (no browser window needed) ─────────────────
  // When we have both a cookie AND a quiz ID, we can skip the browser entirely.
  if (cookieStr && args.quizId) {
    console.log(`\n[MODE] Headless direct API fetch (cookie + quiz ID provided)`);
    console.log(`  Quiz ID    : ${args.quizId}`);
    console.log(`  Cookie     : ${cookieStr.slice(0, 30)}...\n`);

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.addCookies(parseCookies(cookieStr));

    const metaPayload = await fetchQuizMeta(context.request, args.quizId, cookieStr);
    const allIds = metaPayload ? extractIds(metaPayload) : [];

    if (allIds.length === 0) {
      console.log(`  [meta] No question list from meta endpoint. Trying sequential IDs from 1...`);
      // Will fall through to browser mode below if we can't enumerate IDs.
    } else {
      console.log(`  [meta] ${allIds.length} question IDs found.\n`);
      const collected = [];
      const seenIds = new Set();
      const ids = allIds.slice(0, args.maxPages);
      for (let i = 0; i < ids.length; i++) {
        const data = await fetchQuestion(context.request, args.quizId, ids[i], cookieStr);
        if (data) {
          const id = String(data.id ?? i + 1);
          if (!seenIds.has(id)) {
            seenIds.add(id);
            collected.push(data);
            fs.writeFileSync(outputFile, JSON.stringify(collected, null, 2), "utf8");
            console.log(`  [${i + 1}/${ids.length}] question ${ids[i]} saved`);
          }
        }
        if (i > 0 && i % 20 === 0) await sleep(400);
      }
      await context.close();
      await browser.close();
      console.log("\n=== Capture complete ===");
      console.log(`  Questions saved : ${collected.length}`);
      console.log(`  Output file     : ${outputFile}`);
      return;
    }

    await context.close();
    await browser.close();
  }

  // ── Browser mode ──────────────────────────────────────────────────────────
  const headless = args.headless || (!!cookieStr && !args.quizId);
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();

  // Inject cookie before first navigation so all requests are authenticated
  if (cookieStr) {
    await context.addCookies(parseCookies(cookieStr));
    console.log(`\nCookie injected. Navigating to: ${args.url}`);
  }

  const page = await context.newPage();
  const { store, onResponse } = makeStore();
  context.on("response", onResponse);

  await page.goto(args.url, { waitUntil: "domcontentloaded" });

  if (!cookieStr) {
    // ── Interactive login gate (only when no cookie provided) ───────────────
    console.log("\n>>> Log in to TotalSem in the browser window that just opened.");
    console.log(">>> Navigate to the quiz/question page so at least one question is visible.");
    await prompt(">>> Press Enter here once you are on a question page: ");
  }

  console.log("\nCapture starting...\n");
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await sleep(2000);

  // If quiz ID still not detected, trigger one Next to catch the first API call
  if (!store.quizId) {
    if (args.quizId) {
      store.quizId = args.quizId;
    } else {
      console.log("  [intercept] No quiz API calls yet. Attempting first Next click...");
      await clickNext(page);
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      await sleep(1500);
    }
  }

  if (!store.quizId) {
    console.error("\nERROR: Could not detect quiz ID from network traffic.");
    console.error("  Tip: pass --quiz-id 2091291 to skip auto-detection.\n");
    await browser.close();
    process.exitCode = 1;
    return;
  }

  console.log(`  Quiz ID       : ${store.quizId}`);
  console.log(`  Questions seen: ${store.questionIds.size}`);

  // ── Discover full question list ───────────────────────────────────────────
  let allIds = [];
  const metaPayload = store.listPayload ?? (await fetchQuizMeta(context.request, store.quizId, cookieStr));
  if (metaPayload) {
    allIds = extractIds(metaPayload);
    if (allIds.length > 0) {
      console.log(`  [meta] ${allIds.length} question IDs discovered via quiz metadata.`);
    } else {
      console.log(`  [meta] Quiz metadata returned data but could not extract question IDs.`);
      console.log(`  [meta] Raw keys: ${Object.keys(metaPayload).join(", ")}`);
    }
  }

  // ── Collected results ─────────────────────────────────────────────────────
  const collected = [];
  const seenIds = new Set();

  function checkpoint(data) {
    const id = String(data.id ?? collected.length + 1);
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    collected.push(data);
    fs.writeFileSync(outputFile, JSON.stringify(collected, null, 2), "utf8");
    return true;
  }

  // ── Strategy 1: Direct API fetch if we have a question list ──────────────
  if (allIds.length > 0) {
    const ids = allIds.slice(0, args.maxPages);
    console.log(`\n[MODE] Direct API fetch — ${ids.length} questions\n`);
    for (let i = 0; i < ids.length; i++) {
      const data = await fetchQuestion(context.request, store.quizId, ids[i], cookieStr);
      if (data) {
        const saved = checkpoint(data);
        console.log(`  [${i + 1}/${ids.length}] question ${ids[i]} — ${saved ? "saved" : "duplicate"}`);
      }
      // Brief pause to avoid hammering the server
      if (i > 0 && i % 20 === 0) await sleep(500);
    }
  } else {
    // ── Strategy 2: Browser Next-click + network capture ─────────────────
    console.log("\n[MODE] Browser Next-click fallback\n");

    const pending = new Map();
    context.on("response", async (response) => {
      const url = response.url();
      const m = url.match(QUIZ_API_RE);
      if (!m || m[1] !== store.quizId) return;
      const ct = response.headers()["content-type"] || "";
      if (!ct.includes("json")) return;
      try {
        const data = await response.json();
        if (data && data.id) pending.set(String(data.id), data);
      } catch { /* ignore */ }
    });

    let stopReason = "max-pages";

    // Capture any question already loaded on the current page
    for (const [id, data] of store.questionIds.entries()) {
      // store.questionIds only has IDs; fetch each one directly
      const fetched = await fetchQuestion(context.request, store.quizId, id);
      if (fetched) checkpoint(fetched);
    }

    for (let pageNum = collected.length + 1; pageNum <= args.maxPages; pageNum++) {
      pending.clear();
      const clicked = await clickNext(page);
      if (!clicked) { stopReason = "next-not-found-or-disabled"; break; }
      await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
      await sleep(1200);

      let savedAny = false;
      for (const [qId, data] of pending) {
        if (checkpoint(data)) {
          console.log(`  [${collected.length}] question ${qId} saved`);
          savedAny = true;
        }
      }
      if (!savedAny) { stopReason = "no-new-question-captured"; break; }
    }

    console.log(`\nStop reason: ${stopReason}`);
  }

  await context.close();
  await browser.close();

  console.log("\n=== Capture complete ===");
  console.log(`  Questions saved : ${collected.length}`);
  console.log(`  Output file     : ${outputFile}`);
}

main().catch((err) => {
  console.error("Capture failed:", err);
  process.exitCode = 1;
});
