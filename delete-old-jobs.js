import { Client } from "pg";
import dotenv from "dotenv";
import path from "path";

async function main() {
  // Load .env from working dir (actions will set DATABASE_URL via secrets)
  dotenv.config({ path: path.join(process.cwd(), ".env") });

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL not set in environment. Aborting deletion.");
    process.exit(1);
  }

  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    const selectRes = await client.query(
      `SELECT COUNT(*)::int AS count FROM "Job" WHERE "createdAt" < NOW() - INTERVAL '30 days'`,
    );
    const count = selectRes.rows?.[0]?.count || 0;

    if (!count) {
      console.log("No jobs older than 30 days found. Nothing to delete.");
      return;
    }

    const delRes = await client.query(
      `DELETE FROM "Job" WHERE "createdAt" < NOW() - INTERVAL '30 days' RETURNING id`,
    );

    console.log(`Deleted ${delRes.rowCount} job(s) older than 30 days.`);
  } catch (err) {
    console.error("Error while deleting old jobs:", err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
