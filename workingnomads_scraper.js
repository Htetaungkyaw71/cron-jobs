/**
 * Working Nomads scraper
 * Uses the rendered Angular job list so we can collect the public Development
 * jobs that match the posted-date filter and export them in the same shape used
 * by the existing import pipeline.
 *
 * Usage:
 *   node workingnomads_scraper.js
 *   node workingnomads_scraper.js --limit 100 --postedDate 3 --output workingnomads_jobs.json
 */

import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";

const JOB_PAGE_URL =
  "https://www.workingnomads.com/jobs?category=development&postedDate=3";
const DEFAULT_LIMIT = 100;
const DEFAULT_POSTED_DAYS = 3;

const args = process.argv.slice(2);
const getArg = (flag) => {
  const index = args.indexOf(flag);
  return index !== -1 ? args[index + 1] : null;
};

const LIMIT = parseInt(getArg("--limit") || String(DEFAULT_LIMIT), 10);
const POSTED_DAYS = parseInt(
  getArg("--postedDate") || String(DEFAULT_POSTED_DAYS),
  10,
);
const OUTPUT_FILE = getArg("--output") || "workingnomads_jobs.json";

function cleanText(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function normalizeJobLevel(value = "") {
  const text = cleanText(value).toUpperCase();
  if (
    text.includes("LEAD") ||
    text.includes("PRINCIPAL") ||
    text.includes("STAFF")
  )
    return "LEAD";
  if (text.includes("SENIOR") || text.includes("SR.")) return "SENIOR";
  if (text.includes("JUNIOR") || text.includes("JR.")) return "JUNIOR";
  if (
    text.includes("MID") ||
    text.includes("INTERMEDIATE") ||
    text.includes("REGULAR")
  )
    return "MID";
  return "MID";
}

function normalizeJobType(value = "") {
  const text = cleanText(value).toUpperCase();
  if (text === "PT" || text.includes("PART")) return "PART_TIME";
  if (text === "CT" || text.includes("CONTRACT") || text.includes("B2B"))
    return "CONTRACT";
  if (text === "FF" || text.includes("FREELANCE")) return "FREELANCE";
  return "FULL_TIME";
}

function isWithinPostedDays(value, days) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return Date.now() - date.getTime() <= days * 24 * 60 * 60 * 1000;
}

function formatSalary(job) {
  if (job.salary_range_short) return cleanText(job.salary_range_short);
  if (job.salary_range) return cleanText(job.salary_range);
  if (typeof job.annual_salary_usd === "number") {
    return `$${job.annual_salary_usd.toLocaleString()} per year`;
  }
  return undefined;
}

function buildApplyLink(job) {
  if (job.apply_url) return cleanText(job.apply_url);
  return `https://www.workingnomads.com/jobs/${job.slug}`;
}

function extractLocation(job) {
  if (Array.isArray(job.locations) && job.locations.length > 0) {
    return cleanText(job.locations.join(", "));
  }
  if (job.location_base) return cleanText(job.location_base);
  return "Remote";
}

function extractTechStack(tags = []) {
  return Array.isArray(tags)
    ? [
        ...new Set(
          tags.map((tag) => cleanText(tag).toLowerCase()).filter(Boolean),
        ),
      ]
    : [];
}

function mapJob(job) {
  const title = cleanText(job.title);
  const description = cleanText(job.description);

  return {
    title,
    description: job.description?.trim() || "",
    location: extractLocation(job),
    isRemote: true,
    externalJob: true,
    applyLink: buildApplyLink(job),
    company_name: cleanText(job.company),
    ...(formatSalary(job) ? { salary: formatSalary(job) } : {}),
    logo: "",
    tech_stack: extractTechStack(job.tags),
    level: normalizeJobLevel(job.experience_level || `${title} ${description}`),
    type: normalizeJobType(job.position_type),
  };
}

async function loadRenderedJobs(page, targetCount, postedDays) {
  for (let safety = 0; safety < 10; safety += 1) {
    const state = await page.evaluate(() => {
      const showMore = document.querySelector(".show-more");
      const scope = window.angular?.element(showMore)?.scope?.();
      const filteredCount = Array.isArray(scope?.hits)
        ? scope.hits.filter((hit) => {
            const job = hit?._source;
            const category = String(job?.category_name || "")
              .trim()
              .toLowerCase();
            const date = new Date(job?.pub_date || "");
            return (
              category === "development" &&
              !Number.isNaN(date.getTime()) &&
              Date.now() - date.getTime() <= 3 * 24 * 60 * 60 * 1000
            );
          }).length
        : 0;
      return {
        hits: Array.isArray(scope?.hits) ? scope.hits.length : 0,
        filteredCount,
        loadMoreShow: Boolean(scope?.loadMoreShow),
      };
    });

    if (state.filteredCount >= targetCount || !state.loadMoreShow) {
      return state;
    }

    await page.evaluate(() => {
      const showMore = document.querySelector(".show-more");
      const scope = window.angular?.element(showMore)?.scope?.();
      scope?.loadMore?.();
    });

    await page.waitForFunction(
      (previousCount) => {
        const showMore = document.querySelector(".show-more");
        const scope = window.angular?.element(showMore)?.scope?.();
        return Array.isArray(scope?.hits) && scope.hits.length > previousCount;
      },
      { timeout: 30_000 },
      state.hits,
    );
  }

  return page.evaluate(() => {
    const showMore = document.querySelector(".show-more");
    const scope = window.angular?.element(showMore)?.scope?.();
    const filteredCount = Array.isArray(scope?.hits)
      ? scope.hits.filter((hit) => {
          const job = hit?._source;
          const category = String(job?.category_name || "")
            .trim()
            .toLowerCase();
          const date = new Date(job?.pub_date || "");
          return (
            category === "development" &&
            !Number.isNaN(date.getTime()) &&
            Date.now() - date.getTime() <= 3 * 24 * 60 * 60 * 1000
          );
        }).length
      : 0;
    return {
      hits: Array.isArray(scope?.hits) ? scope.hits.length : 0,
      filteredCount,
      loadMoreShow: Boolean(scope?.loadMoreShow),
    };
  });
}

async function main() {
  console.log("🚀  Working Nomads scraper");
  console.log(
    `   Target: ${LIMIT} jobs | Posted within: ${POSTED_DAYS} day(s)`,
  );

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.goto(JOB_PAGE_URL, {
      waitUntil: "networkidle2",
      timeout: 120_000,
    });

    const rendered = await loadRenderedJobs(page, LIMIT, POSTED_DAYS);
    const jobs = await page.evaluate(() => {
      const showMore = document.querySelector(".show-more");
      const scope = window.angular?.element(showMore)?.scope?.();
      return Array.isArray(scope?.hits)
        ? scope.hits.map((hit) => hit?._source).filter(Boolean)
        : [];
    });

    const filteredJobs = jobs
      .filter(
        (job) => cleanText(job.category_name).toLowerCase() === "development",
      )
      .filter((job) => isWithinPostedDays(job.pub_date, POSTED_DAYS))
      .sort(
        (a, b) =>
          new Date(b.pub_date).getTime() - new Date(a.pub_date).getTime(),
      )
      .slice(0, LIMIT)
      .map(mapJob)
      .filter((job) => job.title && job.description && job.location);

    const outputPath = path.resolve(OUTPUT_FILE);
    fs.writeFileSync(outputPath, JSON.stringify(filteredJobs, null, 2), "utf8");

    console.log(`   Rendered jobs: ${rendered.hits}`);
    console.log(`   Filtered jobs: ${rendered.filteredCount}`);
    console.log(`✅  Saved ${filteredJobs.length} jobs → ${outputPath}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
