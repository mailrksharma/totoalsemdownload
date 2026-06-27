import fs from "node:fs";
import { chromium } from "playwright";

const cookieRaw = fs.readFileSync("wiley-cookie.txt", "utf8").trim();
const wideDomain = new Set(["ALM-token", "RefreshToken", "X-NG-JWT-TOKEN"]);
const cookies = cookieRaw.split(";").map(s => s.trim()).filter(Boolean).map(pair => {
  const eq = pair.indexOf("=");
  if (eq === -1) return null;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  return { name, value, domain: wideDomain.has(name) ? ".wiley.com" : "study.learning.wiley.com", path: "/", secure: true, httpOnly: false, sameSite: "Lax" };
}).filter(Boolean);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
await context.addCookies(cookies);

const allCalls = [];

context.on("response", async (resp) => {
  if (!resp.url().includes("appsync-api")) return;
  try {
    const body = await resp.json();
    const reqBody = JSON.parse(resp.request().postData() || "{}");
    allCalls.push({ op: reqBody.operationName || "?", vars: reqBody.variables, query: reqBody.query, body });
  } catch { /* ignore */ }
});

const page = await context.newPage();
await page.goto(
  "https://study.learning.wiley.com/players/question?productId=4f11a775-e489-47ec-98d7-8f8cce54888f&unitId=66d3ab30-a7eb-4c42-9ea3-7ce94e325478&assignmentId=bd461d7b-75ab-4c19-8f61-9d599fb1b3a1",
  { waitUntil: "domcontentloaded", timeout: 30000 }
);
await page.waitForTimeout(4000);

// Dismiss any dialog first
await page.locator("button:has-text('Close'), button:has-text('Accept'), button:has-text('Dismiss')").first().click().catch(() => {});
await page.waitForTimeout(1000);

// Snapshot the URL to detect redirect
console.log("Final URL:", page.url());

// Print visible text content for debugging
const bodyText = await page.locator("body").innerText().catch(() => "");
console.log("Body text (first 800):", bodyText.slice(0, 800));

// Count interactive elements
const radioCount = await page.locator("input[type=radio], input[type=checkbox]").count();
const btnTexts = await page.locator("button").allTextContents();
console.log("Radio/checkbox count:", radioCount);
console.log("Buttons:", btnTexts.filter(t => t.trim()).join(" | "));

// Try clicking the first answer option
if (radioCount > 0) {
  await page.locator("input[type=radio], input[type=checkbox]").first().click().catch(() => {});
  await page.waitForTimeout(1000);
}

// Try any submit/check/confirm button
const submitSel = ["Submit", "Check", "Confirm", "Next"].map(t => `button:has-text("${t}")`).join(", ");
const submitBtn = page.locator(submitSel).first();
if (await submitBtn.count() > 0) {
  console.log("Clicking:", await submitBtn.textContent());
  await submitBtn.click().catch(() => {});
  await page.waitForTimeout(4000);
}

// Capture page title and visible text for context
const title = await page.title();
console.log("Page title:", title);

fs.writeFileSync("output/inspect-appsync.json", JSON.stringify(allCalls, null, 2));
console.log("\nOps captured:", [...new Set(allCalls.map(c => c.op))].join(", "));
console.log("Total responses:", allCalls.length);

// Print ALL response bodies + their request variables + queries
for (let i = 0; i < allCalls.length; i++) {
  console.log(`\n=== Response ${i + 1}: ${allCalls[i].op} ===`);
  console.log("Variables:", JSON.stringify(allCalls[i].vars, null, 2));
  console.log("Query:", allCalls[i].query);
  console.log("Body:", JSON.stringify(allCalls[i].body, null, 2));
}

await browser.close();
