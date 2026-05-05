# justjoin.it Scraper

Scrapes up to 100 recent job listings from [justjoin.it](https://justjoin.it) and outputs structured JSON.

## Requirements

- **Node.js ≥ 18**
- Puppeteer (downloads Chromium automatically on first install)

## Setup

```bash
cd justjoinit-scraper
npm install
```

> First install downloads a bundled Chromium (~170 MB). This is a one-time step.

## Usage

```bash
# Scrape 100 jobs (default) → saves jobs.json
npm start

# Custom limit
node scraper.js --limit 50

# Custom output file
node scraper.js --output my_jobs.json

# Combine flags
node scraper.js --limit 100 --output todays_jobs.json
```

## Output format

Each job object looks like:

```json
{
  "title": "Senior Python Developer",
  "description": "Full job description text...",
  "location": "Warszawa",
  "isRemote": true,
  "externalJob": true,
  "applyLink": "https://justjoin.it/job-offer/...",
  "logo": "https://public.justjoin.it/companies/logos/...",
  "company_name": "Example Corp",
  "tech_stack": ["Python", "FastAPI", "Docker", "PostgreSQL"],
  "level": "SENIOR",
  "type": "FULL_TIME"
}
```

### Field reference

| Field | Type | Values |
|-------|------|--------|
| `title` | string | Job title |
| `description` | string | Full job description (up to 2000 chars) |
| `location` | string | City / region |
| `isRemote` | boolean | `true` if remote or hybrid |
| `externalJob` | boolean | Always `true` |
| `applyLink` | string | Direct URL to apply |
| `logo` | string | Company logo image URL |
| `company_name` | string | Company name |
| `tech_stack` | string[] | Up to 15 technologies/skills |
| `level` | enum | `JUNIOR` \| `MID` \| `SENIOR` \| `LEAD` |
| `type` | enum | `FULL_TIME` \| `PART_TIME` \| `CONTRACT` \| `FREELANCE` |

## How it filters "recent" jobs

justjoin.it shows each listing with a badge like:
- **new** – just posted (freshest, always included)
- **1d left … 30d left** – time remaining until the listing expires

The scraper collects **only** cards that have a `new` badge OR a `Xd left` badge (1–30 days), which are the jobs posted within the current 30-day window. This lets you run it daily and reliably pick up new postings.

## Daily cron example

```bash
# Run every day at 8 AM, append date to filename
0 8 * * * cd /path/to/justjoinit-scraper && node scraper.js --output jobs_$(date +\%Y\%m\%d).json
```

## Notes

- The scraper uses **Puppeteer** (headless Chrome) to handle the React SPA and lazy-loading.
- Resource interception (images/fonts/media) is enabled to speed up scraping.
- Detail pages are fetched with **concurrency=5** to balance speed and politeness.
- Puppeteer runs with `--no-sandbox` for compatibility in Docker/CI environments.
