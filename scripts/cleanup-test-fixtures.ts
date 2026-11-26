/**
 * Purge (or preview) every integration-test leftover (qsit-* fixtures) in the shared TiDB.
 *   npm run test:cleanup-fixtures             # delete
 *   npm run test:cleanup-fixtures -- --dry-run  # read-only scan
 * Used by `npm run deploy:prod -- --full` after the test step.
 */
import "dotenv/config";
import { createIntegrationTestPool, purgeTestLeftovers, scanTestLeftovers } from "../api/testDbCleanup";

async function main() {
  if (!process.env.DB_HOST) {
    console.error("DB_HOST required (.env)");
    process.exit(1);
  }
  const dryRun = process.argv.includes("--dry-run");
  const pool = createIntegrationTestPool();
  try {
    const found = await purgeTestLeftovers(pool, { dryRun });
    console.log(`${dryRun ? "Would remove" : "Removed"}: ${found.emails.length} test user(s), ${found.participants} test participant(s)`);
    if (!dryRun) {
      const left = await scanTestLeftovers(pool);
      if (left.emails.length || left.participants) {
        console.error(`Still present after purge: ${JSON.stringify(left)}`);
        process.exitCode = 1;
      } else console.log("✅ No test data in the shared DB.");
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
