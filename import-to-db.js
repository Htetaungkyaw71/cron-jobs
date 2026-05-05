import fs from "fs/promises";
import path from "path";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import dotenv from 'dotenv';

async function readJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    return [];
  }
}

function dedupeJobs(jobs) {
  const seen = new Map();
  for (const j of jobs) {
    const key = (j.applyLink || j.title || "") + "||" + (j.company_name || "");
    if (!seen.has(key)) seen.set(key, j);
  }
  return Array.from(seen.values());
}

async function main() {
  const repoRoot = path.resolve(new URL(import.meta.url).pathname, "..");
  const filesDir = path.join(repoRoot);

  const a = await readJson(path.join(filesDir, "todays_jobs.json"));
  const b = await readJson(path.join(filesDir, "workingnomads_jobs.json"));

  const merged = dedupeJobs([].concat(a || [], b || []));

  // write merged file locally for debugging/audit
  await fs.writeFile(
    path.join(filesDir, "merged_jobs.json"),
    JSON.stringify(merged, null, 2),
    "utf8",
  );
  console.log("Wrote", merged.length, "jobs to files/merged_jobs.json");

  // Load environment variables from files/.env so running `node import-to-db.js` picks up DATABASE_URL
  dotenv.config({ path: path.join(filesDir, '.env') });

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL not set in environment. Aborting import.");
    process.exit(1);
  }

  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    // Ensure recruiter user exists
    const recruiterEmail = "recruiter@example.com";
    const hashedPassword = await bcrypt.hash("password123", 10);
    const recruiterId = randomUUID();

    const userRes = await client.query(
      `INSERT INTO "User" (id, email, password, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role
       RETURNING id`,
      [recruiterId, recruiterEmail, hashedPassword, "RECRUITER"],
    );
    const finalRecruiterId = userRes.rows[0].id;

    // Ensure company exists for this recruiter
    const compRes = await client.query(
      `SELECT id FROM "Company" WHERE "ownerId" = $1 LIMIT 1`,
      [finalRecruiterId],
    );

    let companyId;
    if (compRes.rowCount > 0) {
      companyId = compRes.rows[0].id;
    } else {
      companyId = randomUUID();
      await client.query(
        `INSERT INTO "Company" (id, name, description, website, industry, size, "foundedYear", location, "hiringStatus", "ownerId")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          companyId,
          "StackHire Labs",
          "Imported external jobs",
          "https://justjoin.it",
          "Technology",
          "MEDIUM",
          2021,
          "Poland",
          "ACTIVELY_HIRING",
          finalRecruiterId,
        ],
      );
    }

    // Ensure recruiter profile
    const profRes = await client.query(
      `SELECT id FROM "RecruiterProfile" WHERE "userId" = $1 LIMIT 1`,
      [finalRecruiterId],
    );
    if (profRes.rowCount === 0) {
      await client.query(
        `INSERT INTO "RecruiterProfile" (id, "fullName", title, email, phone, "linkedinUrl", "userId", "companyId")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          randomUUID(),
          "Recruiter One",
          "Senior Recruiter",
          recruiterEmail,
          "09420012345",
          "https://www.linkedin.com/in/recruiter-one",
          finalRecruiterId,
          companyId,
        ],
      );
    }

    // Insert jobs
    const oneMonthLater = new Date();
    oneMonthLater.setDate(oneMonthLater.getDate() + 30);

    let created = 0;
    let skipped = 0;

    function normalizeJobLevel(value) {
      const v = (value || "").toUpperCase();
      if (v.includes("JUNIOR")) return "JUNIOR";
      if (v.includes("SENIOR")) return "SENIOR";
      if (v.includes("LEAD") || v.includes("PRINCIPAL") || v.includes("STAFF"))
        return "LEAD";
      return "MID";
    }

    function normalizeJobType(value) {
      const v = (value || "").toUpperCase();
      if (v.includes("PART")) return "PART_TIME";
      if (v.includes("FREELANCE")) return "FREELANCE";
      if (v.includes("CONTRACT") || v.includes("B2B")) return "CONTRACT";
      return "FULL_TIME";
    }

    for (const job of merged) {
      const title = job.title?.trim();
      const description = job.description?.trim();
      const location = job.location?.trim();

      if (!title || !description || !location) {
        skipped += 1;
        continue;
      }

      const exists = await client.query(
        `SELECT id FROM "Job" WHERE title = $1 AND location = $2 AND "companyId" = $3 LIMIT 1`,
        [title, location, companyId],
      );
      if (exists.rowCount > 0) {
        skipped += 1;
        continue;
      }

      const techStack = Array.isArray(job.tech_stack)
        ? job.tech_stack.map((t) => (t || "").trim()).filter(Boolean)
        : [];

      const jobId = randomUUID();
      const level = normalizeJobLevel(job.level);
      const type = normalizeJobType(job.type);

      await client.query(
        `INSERT INTO "Job" (id, title, description, location, "isRemote", "externalJob", company_name, salary, "applyLink", logo, "salaryMin", "salaryMax", "techStack", level, type, "expiresAt", "companyId", "postedById")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::text[],$14::"JobLevel",$15::"JobType",$16,$17,$18)`,
        [
          jobId,
          title,
          description,
          location,
          Boolean(job.isRemote),
          true,
          job.company_name?.trim() || null,
          job.salary?.trim() || null,
          job.applyLink?.trim() || null,
          job.logo?.trim() || null,
          null,
          null,
          techStack,
          level,
          type,
          oneMonthLater,
          companyId,
          finalRecruiterId,
        ],
      );

      created += 1;
    }

    console.log("Import complete", {
      jobsFromFile: merged.length,
      jobsCreated: created,
      jobsSkipped: skipped,
    });
    
    // remove original scraper output files to avoid re-processing
    try {
      await fs.unlink(path.join(filesDir, 'todays_jobs.json'));
      console.log('Removed todays_jobs.json');
    } catch (e) {
      // ignore if not present
    }
    try {
      await fs.unlink(path.join(filesDir, 'workingnomads_jobs.json'));
      console.log('Removed workingnomads_jobs.json');
    } catch (e) {
      // ignore if not present
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
