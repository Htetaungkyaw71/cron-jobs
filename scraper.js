/**
 * justjoin.it Web Scraper
 * Crawls job listings posted recently (new / with days-left label)
 * and returns up to 100 jobs per run as structured JSON.
 *
 * Usage:
 *   node scraper.js                      # scrape 100 jobs, save to jobs.json
 *   node scraper.js --limit 50           # custom limit
 *   node scraper.js --output my_jobs.json
 *
 * Requirements:
 *   npm install puppeteer axios cheerio
 */

// Polyfill `File` for environments (GitHub Actions / Node 18) where
// the `File` web API isn't available but some deps (undici) expect it.
if (typeof globalThis.File === "undefined") {
  globalThis.File = class File extends Blob {
    constructor(bits = [], name = "", options = {}) {
      super(bits, options);
      this.name = name || "";
      this.lastModified = options.lastModified || Date.now();
    }
  };
}

import puppeteer from "puppeteer";
import * as cheerio from "cheerio";
import fs from "node:fs";
import path from "node:path";

// ─── Config ───────────────────────────────────────────────────────────────────
const BASE_URL = "https://justjoin.it";
const LIST_URL = `${BASE_URL}/job-offers/all-locations`;
const DEFAULT_LIMIT = 100;
const SCROLL_PAUSE_MS = 1800;
const PAGE_LOAD_TIMEOUT = 60_000;
const DETAIL_CONCURRENCY = 5; // parallel detail-page fetches

// ─── CLI Args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
};
const LIMIT = parseInt(getArg("--limit") || DEFAULT_LIMIT, 10);
const OUTPUT_FILE = getArg("--output") || "jobs.json";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse the "Xd left" / "new" label into a days-remaining number.
 * Returns Infinity for "new" (treat as freshest), numeric otherwise.
 */
function parseDaysLeft(label = "") {
  const s = label.trim().toLowerCase();
  if (s === "new" || s === "") return Infinity;
  const match = s.match(/^(\d+)d/);
  return match ? parseInt(match[1], 10) : Infinity;
}

/**
 * Only keep jobs that are "new" OR have a days-left label (meaning they were
 * posted within the last 30 days window). We exclude jobs that have already
 * expired (no label at all can mean expired on some old scraped pages).
 */
function isRecentJob(daysLeft) {
  // Accept "new" (Infinity) and anything with 1–30 days left
  return daysLeft === Infinity || (daysLeft >= 1 && daysLeft <= 30);
}

function normalizeLevel(titleOrLevel = "") {
  const t = titleOrLevel.toUpperCase();
  if (/\bLEAD\b|\bPRINCIPAL\b|\bSTAFF\b/.test(t)) return "LEAD";
  if (/\bSENIOR\b|\bSR\.?\b/.test(t)) return "SENIOR";
  if (/\bJUNIOR\b|\bJR\.?\b/.test(t)) return "JUNIOR";
  if (/\bMID\b|\bREGULAR\b|\bINTERMEDIATE\b/.test(t)) return "MID";
  return "MID"; // default
}

function normalizeType(raw = "") {
  const t = raw.toUpperCase().replace(/[-\s]/g, "_");
  if (t.includes("PART")) return "PART_TIME";
  if (t.includes("CONTRACT") || t.includes("B2B")) return "CONTRACT";
  if (t.includes("FREELANCE")) return "FREELANCE";
  return "FULL_TIME";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function gotoWithRetry(page, url, options, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await page.goto(url, options);
    } catch (err) {
      const isLastAttempt = attempt === retries;
      if (isLastAttempt) throw err;
      console.log("  ⚠️  Page load timed out, retrying once…");
      await sleep(2000);
    }
  }
}

function cleanText(value = "") {
  return value.replace(/\s+/g, " ").trim();
}

function decodeHtml(value = "") {
  const $ = cheerio.load(`<div>${value}</div>`);
  return cleanText($.text());
}

function decodeHtmlFragment(value = "") {
  if (!value) return "";

  return value
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .trim();
}

function serializeHtmlFragment($, element, fallback = "") {
  if (!element) return fallback;

  const outerHtml = $.html(element) || "";
  if (outerHtml.trim()) return outerHtml.trim();

  const innerHtml = element.html?.() || "";
  if (innerHtml.trim()) return innerHtml.trim();

  return fallback;
}

function pickDescriptionElement($) {
  const headingPattern =
    /(job description|description|responsibilities|requirements|your role|your tasks|o projekcie|twoje zadania|profil stanowiska|twoje obowiązki|what you['’]ll do|what you will do|role summary|tasks)/i;

  const headings = $("h1, h2, h3, h4, h5, h6").toArray();

  for (const heading of headings) {
    const headingText = cleanText($(heading).text());
    if (!headingPattern.test(headingText)) continue;

    const sibling = $(heading)
      .parent()
      .find("div, section, article")
      .filter((_, el) => {
        const textLength = cleanText($(el).text()).length;
        const html = $(el).html() || "";
        return (
          textLength > 120 &&
          /<(p|ul|ol|li|strong|em|br|a|h[1-6])\b/i.test(html)
        );
      })
      .first();

    if (sibling.length) return sibling;

    const nextContainer = $(heading)
      .nextAll("div, section, article")
      .filter((_, el) => {
        const textLength = cleanText($(el).text()).length;
        const html = $(el).html() || "";
        return (
          textLength > 120 &&
          /<(p|ul|ol|li|strong|em|br|a|h[1-6])\b/i.test(html)
        );
      })
      .first();

    if (nextContainer.length) return nextContainer;
  }

  let best = null;
  let bestScore = 0;

  $("div, section, article").each((_, el) => {
    const $el = $(el);
    const text = cleanText($el.text());
    const html = $el.html() || "";
    if (text.length < 120) return;
    if (!/<(p|ul|ol|li|strong|em|br|a|h[1-6])\b/i.test(html)) return;

    const blockTags = (
      html.match(/<(p|ul|ol|li|strong|em|br|a|h[1-6])\b/gi) || []
    ).length;
    const score = text.length + blockTags * 40;

    if (score > bestScore) {
      bestScore = score;
      best = $el;
    }
  });

  return best;
}

function parseJobPostingSchema($) {
  const scripts = $("script[type='application/ld+json']").toArray();

  for (const script of scripts) {
    const raw = $(script).html() || "";
    if (!raw.trim()) continue;

    try {
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed)
        ? parsed
        : parsed?.["@graph"] && Array.isArray(parsed["@graph"])
          ? parsed["@graph"]
          : [parsed];

      const jobPosting = items.find((item) => item?.["@type"] === "JobPosting");
      if (jobPosting) return jobPosting;
    } catch {
      // Ignore malformed JSON-LD blocks and keep trying.
    }
  }

  return null;
}

function normalizeTechName(raw = "") {
  let t = cleanText(raw);
  if (!t) return "";

  t = t.replace(
    /(regular|advanced|master|expert|junior|mid|senior|nice to have)$/i,
    "",
  );
  t = cleanText(t);

  // Drop salaries, plain numbers, location-like and language-level noise.
  if (/\bPLN\b|\bUSD\b|\bEUR\b|\bmonth\b|\bh\b/i.test(t)) return "";
  if (/^\d+[\d\s.,-]*$/.test(t)) return "";
  if (/^(polish|english|german|french)$/i.test(t)) return "";
  if (/^(A1|A2|B1|B2|C1|C2)$/i.test(t)) return "";
  if (/^(remote|hybrid|office)$/i.test(t)) return "";
  if (t.length < 2 || t.length > 40) return "";

  return t;
}

function isLocationLikeToken(token = "", location = "") {
  const t = cleanText(token);
  if (!t) return true;

  if (/^,\s*\+\d+$/i.test(t)) return true;
  if (/^\+\d+$/i.test(t)) return true;
  if (/^locations?$/i.test(t)) return true;

  // Common cities seen in justjoin listings.
  if (
    /^(warszawa|krakow|kraków|wrocław|wroclaw|gdańsk|gdansk|poznań|poznan|szczecin|łódź|lodz|katowice|koszalin|gliwice|gdynia|lublin|rzeszów|rzeszow)$/i.test(
      t,
    )
  ) {
    return true;
  }

  const locationParts = location
    .split(/[,/]|\s+-\s+|\s+\+\d+/)
    .map((part) => cleanText(part.toLowerCase()))
    .filter(Boolean);

  if (locationParts.includes(t.toLowerCase())) return true;

  return false;
}

function isLanguageLevelToken(token = "") {
  const t = cleanText(token);
  if (!t) return true;

  if (/^(A1|A2|B1|B2|C1|C2)$/i.test(t)) return true;
  if (/^(english|polish|german|french|spanish|italian)\s*[A-C][12]$/i.test(t)) {
    return true;
  }

  return false;
}

function isSalaryLikeToken(token = "") {
  const t = cleanText(token);
  if (!t) return true;

  if (/undisclosed salary/i.test(t)) return true;
  if (/salary/i.test(t)) return true;
  if (/\bPLN\b|\bUSD\b|\bEUR\b/i.test(t)) return true;
  if (/\bmonth\b|\bh\b/i.test(t)) return true;
  if (/^\d+[\d\s.,-]*$/.test(t)) return true;

  return false;
}

function extractSalaryText(jobPosting, $, html = "") {
  const baseSalary = jobPosting?.baseSalary;

  if (baseSalary) {
    if (typeof baseSalary === "string") {
      const fromSchema = cleanText(baseSalary);
      if (fromSchema) return fromSchema;
    }

    const value = baseSalary?.value;
    if (typeof value === "string") {
      const fromSchema = cleanText(value);
      if (fromSchema) return fromSchema;
    }

    if (value && typeof value === "object") {
      const min =
        value.minValue != null ? cleanText(String(value.minValue)) : "";
      const max =
        value.maxValue != null ? cleanText(String(value.maxValue)) : "";
      const currency = cleanText(
        String(
          value.currency ||
            baseSalary.currency ||
            jobPosting?.salaryCurrency ||
            "",
        ),
      );
      const unit = cleanText(String(value.unitText || "month"));

      if (min && max) {
        const suffix = currency ? ` ${currency}/${unit}` : "";
        return `${min} - ${max}${suffix}`.trim();
      }
    }
  }

  const salaryCandidates = [];
  $("span, div, p, li").each((_, el) => {
    const text = cleanText($(el).text());
    if (!text) return;
    if (/\b(PLN|USD|EUR)\b/i.test(text) || /salary/i.test(text)) {
      salaryCandidates.push(text);
    }
  });

  if (typeof html === "string" && html) {
    salaryCandidates.push(cleanText(html.replace(/<[^>]*>/g, " ")));
  }

  const salaryPattern =
    /(\d[\d\s.,]{2,})\s*[-–]\s*(\d[\d\s.,]{2,})\s*(PLN|USD|EUR)\s*\/?\s*(month|mo|hour|h|year|yr)?/i;

  for (const candidate of salaryCandidates) {
    const normalized = cleanText(candidate.replace(/\u00a0/g, " "));
    const match = normalized.match(salaryPattern);
    if (match) {
      const unit = match[4] ? `/${match[4]}` : "";
      return `${match[1]} - ${match[2]} ${match[3]}${unit}`;
    }
  }

  return undefined;
}

// ─── Step 1 – Collect listing cards via Puppeteer ────────────────────────────
async function collectListings(browser, limit) {
  console.log(`\n🔍  Opening listings page: ${LIST_URL}`);
  const page = await browser.newPage();

  // Intercept image/font/media to speed things up
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = req.resourceType();
    if (["image", "media", "font"].includes(type)) req.abort();
    else req.continue();
  });

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  );

  await gotoWithRetry(
    page,
    LIST_URL,
    {
      waitUntil: "domcontentloaded",
      timeout: PAGE_LOAD_TIMEOUT,
    },
    1,
  );

  await page.waitForSelector("a[href*='/job-offer/']", {
    timeout: PAGE_LOAD_TIMEOUT,
  });

  const cards = [];
  let previousCount = 0;

  console.log(`📜  Scrolling to collect ${limit} job cards…`);

  while (cards.length < limit) {
    // Parse current DOM
    const html = await page.content();
    const $ = cheerio.load(html);

    // Each job card is an <a> or <li> with a link matching /job-offer/
    $("a[href*='/job-offer/']").each((_, el) => {
      const href = $(el).attr("href") || "";
      if (!href.includes("/job-offer/")) return;

      const url = href.startsWith("http") ? href : `${BASE_URL}${href}`;

      // Avoid duplicates
      if (cards.find((c) => c.url === url)) return;

      // Days-left badge text (look for patterns like "18d left", "new", "1d left")
      const cardText = $(el).text();
      const daysMatch = cardText.match(/(\d+d\s*left|new)/i);
      const daysLabel = daysMatch ? daysMatch[1].toLowerCase() : "";
      const daysLeft = parseDaysLeft(daysLabel);

      if (!isRecentJob(daysLeft)) return;

      // Basic info available in the card
      const title = $(el).find("h3, h2").first().text().trim() || "";
      const company =
        $(el)
          .find("span, div")
          .filter((_, e) => {
            const t = $(e).text().trim();
            return (
              t.length > 0 &&
              t.length < 60 &&
              !t.match(/\d+d|new|remote|hybrid/i)
            );
          })
          .first()
          .text()
          .trim() || "";

      const logo = $(el).find("img").first().attr("src") || "";
      const techStack = [];
      $(el)
        .find("span")
        .each((_, s) => {
          const t = $(s).text().trim();
          if (
            t &&
            t.length < 30 &&
            !t.match(/\d+d|left|new|remote|hybrid|office/i)
          ) {
            techStack.push(t);
          }
        });

      cards.push({ url, title, company, logo, daysLabel, techStack });
    });

    if (cards.length >= limit) break;

    // If no new cards found after scroll, we may have hit the end
    if (cards.length === previousCount) {
      console.log(
        "  ⚠️  No new cards after scroll – possibly reached page end.",
      );
      break;
    }
    previousCount = cards.length;

    console.log(`  📌  Cards so far: ${cards.length}`);

    // Scroll down to trigger lazy-load
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 3));
    await sleep(SCROLL_PAUSE_MS);
  }

  await page.close();
  console.log(
    `✅  Collected ${Math.min(cards.length, limit)} card(s) to process.\n`,
  );
  return cards.slice(0, limit);
}

// ─── Step 2 – Scrape detail page for each job ────────────────────────────────
async function scrapeDetail(browser, card) {
  const page = await browser.newPage();

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (["image", "media", "font"].includes(req.resourceType())) req.abort();
    else req.continue();
  });

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  );

  try {
    await page.goto(card.url, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_LOAD_TIMEOUT,
    });
    const html = await page.content();
    const $ = cheerio.load(html);
    const jobPosting = parseJobPostingSchema($);

    // ── Title ──────────────────────────────────────────────────────────────
    const title =
      cleanText(jobPosting?.title || "") ||
      $("h1").first().text().trim() ||
      card.title ||
      "Unknown";

    // ── Company ────────────────────────────────────────────────────────────
    const companyLink = $(
      "a[href*='/job-offers/all-locations?companies=']",
    ).first();
    const company =
      cleanText(jobPosting?.hiringOrganization?.name || "") ||
      companyLink.text().trim() ||
      card.company ||
      "Unknown";

    // ── Logo ───────────────────────────────────────────────────────────────
    const companyLogoObject = $("object#offerCardCompanyLogo").first();
    const logoFromObject =
      cleanText(companyLogoObject.attr("data") || "") ||
      cleanText(companyLogoObject.attr("src") || "");

    const logoFromCompanyBlock =
      companyLink
        .closest("div, section, article, header")
        .find(
          "object#offerCardCompanyLogo, img[src*='company-logo'], img[src*='logos']",
        )
        .first()
        .attr("data") ||
      companyLink
        .closest("div, section, article, header")
        .find(
          "object#offerCardCompanyLogo, img[src*='company-logo'], img[src*='logos']",
        )
        .first()
        .attr("src") ||
      "";

    let logo = logoFromObject || logoFromCompanyBlock || card.logo || "";
    if (logo && logo.startsWith("/")) logo = `${BASE_URL}${logo}`;

    // ── Location / Remote ──────────────────────────────────────────────────
    const schemaLocation = cleanText(
      jobPosting?.jobLocation?.address?.addressLocality ||
        jobPosting?.applicantLocationRequirements?.name ||
        "",
    );

    const locationText =
      schemaLocation || $("a[href*='/job-offers/'] + *").first().text().trim();

    const isRemote =
      /TELECOMMUTE/i.test(jobPosting?.jobLocationType || "") ||
      /remote/i.test(locationText) ||
      /remote/i.test(html);
    const location =
      cleanText(locationText.replace(/remote|hybrid/gi, "")) || "Poland";

    // ── Description ────────────────────────────────────────────────────────
    // Look for the job description section
    const descriptionEl =
      pickDescriptionElement($) ||
      $("[class*='description'], [class*='job-description'], article, section")
        .filter((_, e) => $(e).text().length > 100)
        .first();
    const descriptionHtml = serializeHtmlFragment(
      $,
      descriptionEl,
      decodeHtmlFragment(jobPosting?.description || ""),
    );
    const description = descriptionHtml.slice(0, 12000);

    // ── Tech stack ─────────────────────────────────────────────────────────
    const techStack = new Set();

    // Seed from listing card chips.
    for (const chip of card.techStack || []) {
      const normalized = normalizeTechName(chip);
      if (normalized) techStack.add(normalized);
    }

    // Try to find the dedicated "Tech stack" section
    $("h2, h3, h4").each((_, heading) => {
      if (/tech stack/i.test($(heading).text())) {
        $(heading)
          .nextUntil("h2, h3, h4")
          .find("span, div, li, p")
          .each((_, el) => {
            const normalized = normalizeTechName($(el).text());
            if (normalized) techStack.add(normalized);
          });
      }
    });

    // Fallback: common skill chips with proficiency suffixes (e.g. Node.jsadvanced).
    $("span, li, p").each((_, el) => {
      const text = cleanText($(el).text());
      if (!/(regular|advanced|master|expert|nice to have)$/i.test(text)) return;
      const normalized = normalizeTechName(text);
      if (normalized) techStack.add(normalized);
    });

    // ── Level ──────────────────────────────────────────────────────────────
    // Justjoin shows "Mid", "Senior", etc. as badge chips
    let levelRaw = "";
    $("span, div, p").each((_, e) => {
      const t = $(e).text().trim();
      if (/^(junior|mid|senior|lead|manager|c-level)$/i.test(t)) {
        levelRaw = t;
        return false; // break
      }
    });
    const level = normalizeLevel(levelRaw || title);

    // ── Contract / Work type ───────────────────────────────────────────────
    let typeRaw = "";
    $("span, div").each((_, e) => {
      const t = $(e).text().trim();
      if (
        /^(full.?time|part.?time|b2b|freelance|permanent|contract|mandate|internship)/i.test(
          t,
        )
      ) {
        typeRaw = t;
        return false;
      }
    });
    const type = normalizeType(typeRaw);

    // ── Apply link ─────────────────────────────────────────────────────────
    // "Apply" button usually has a link or triggers the apply form
    const applyLink =
      $("a[href*='apply'], a:contains('Apply')").first().attr("href") ||
      card.url; // fallback to job page itself

    const salary = extractSalaryText(jobPosting, $, html);

    const cleanedTechStack = [...techStack]
      .map((t) => normalizeTechName(t))
      .filter(Boolean)
      .filter((t) => !isSalaryLikeToken(t))
      .filter((t) => !isLocationLikeToken(t, location))
      .filter((t) => !isLanguageLevelToken(t));

    const uniqueTechStack = [...new Set(cleanedTechStack)];

    const job = {
      title,
      description,
      location,
      isRemote,
      externalJob: true,
      applyLink: applyLink.startsWith("http")
        ? applyLink
        : `${BASE_URL}${applyLink}`,
      logo,
      company_name: company,
      ...(salary ? { salary } : {}),
      tech_stack: uniqueTechStack.slice(0, 20),
      level,
      type,
    };

    return job;
  } catch (err) {
    console.error(`  ❌  Failed to scrape ${card.url}: ${err.message}`);
    return null;
  } finally {
    await page.close();
  }
}

// ─── Step 3 – Run details in batches ─────────────────────────────────────────
async function scrapeDetails(browser, cards) {
  const results = [];
  let i = 0;

  while (i < cards.length) {
    const batch = cards.slice(i, i + DETAIL_CONCURRENCY);
    // console.log(
    //   `  🔗  Scraping details batch ${Math.floor(i / DETAIL_CONCURRENCY) + 1} ` +
    //     `(jobs ${i + 1}–${i + batch.length})…`,
    // );
    const batchResults = await Promise.all(
      batch.map((c) => scrapeDetail(browser, c)),
    );
    batchResults.forEach((r) => r && results.push(r));
    i += DETAIL_CONCURRENCY;
    await sleep(500);
  }

  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log("🚀  justjoin.it Scraper");
  console.log(`   Target: ${LIMIT} jobs | Output: ${OUTPUT_FILE}\n`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1280,900",
    ],
  });

  try {
    // 1. Collect card-level data from the listings page
    const cards = await collectListings(browser, LIMIT);

    if (cards.length === 0) {
      console.log("⚠️  No recent job cards found. Try adjusting filters.");
      return;
    }

    // 2. Enrich with detail page data
    console.log(`\n📄  Fetching detail pages for ${cards.length} jobs…`);
    const jobs = await scrapeDetails(browser, cards);

    // 3. Save output
    const outputPath = path.resolve(OUTPUT_FILE);
    fs.writeFileSync(outputPath, JSON.stringify(jobs, null, 2), "utf8");

    console.log(`\n🎉  Done! Scraped ${jobs.length} jobs → ${outputPath}`);
    // console.log("\nSample job:\n", JSON.stringify(jobs[0], null, 2));
  } finally {
    await browser.close();
  }
})();
