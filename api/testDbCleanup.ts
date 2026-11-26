/**
 * Integration-test fixture hygiene for the shared TiDB.
 *
 * Convention: every fixture email is `qsit-<suite>-<epochMs>-<anything>@example.com`.
 * Tenants created by those users (and everything under them via FK cascade) are purged.
 */
import mysql, { type Pool } from "mysql2/promise";

export const TEST_RUN_LOCK = "quicksanta_test_run";
export const FIXTURE_DOMAIN = "@example.com";
export const fixturePrefix = (suite: string) => `qsit-${suite}-${Date.now()}-`;

export function createIntegrationTestPool(): Pool {
  return mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 4000),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === "false" ? undefined : { minVersion: "TLSv1.2" },
    connectionLimit: 2,
    timezone: "Z",
    dateStrings: true,
  });
}

/** prefix → stamp (ms) for every live fixture set. */
export async function findTestFixturePrefixes(pool: Pool): Promise<Map<string, number>> {
  const [rows] = (await pool.query("SELECT email FROM users WHERE email LIKE 'qsit-%'")) as any;
  const out = new Map<string, number>();
  for (const r of rows) {
    const m = String(r.email).match(/^(qsit-[a-z0-9]+-(\d+)-)/);
    if (m) out.set(m[1], Number(m[2]));
  }
  return out;
}

async function purgeEmails(pool: Pool, likeOrEmails: string) {
  // Tenants created by fixture users cascade to members/events/participants/exclusions/assignments.
  await pool.query(`DELETE t FROM tenants t JOIN users u ON u.id = t.created_by WHERE u.email LIKE ?`, [likeOrEmails]);
  await pool.query(`DELETE FROM participants WHERE email LIKE ?`, [likeOrEmails]);
  await pool.query(`DELETE FROM otp_codes WHERE email LIKE ?`, [likeOrEmails]);
  await pool.query(`DELETE FROM email_log WHERE to_email LIKE ?`, [likeOrEmails]);
  await pool.query(`DELETE a FROM audit_log a JOIN users u ON u.id = a.actor_user_id WHERE u.email LIKE ?`, [likeOrEmails]);
  await pool.query(`DELETE FROM users WHERE email LIKE ?`, [likeOrEmails]);
}

export async function cleanupByPrefix(pool: Pool, prefix: string) {
  await purgeEmails(pool, `${prefix}%`);
}

export async function sweepTestFixtures(pool: Pool, pick: (stamp: number) => boolean): Promise<string[]> {
  const swept: string[] = [];
  for (const [prefix, stamp] of await findTestFixturePrefixes(pool)) {
    if (!pick(stamp)) continue;
    await cleanupByPrefix(pool, prefix);
    swept.push(prefix);
  }
  return swept;
}

export async function scanTestLeftovers(pool: Pool) {
  const [rows] = (await pool.query("SELECT email FROM users WHERE email LIKE 'qsit-%' LIMIT 100")) as any;
  const [p] = (await pool.query("SELECT COUNT(*) AS c FROM participants WHERE email LIKE 'qsit-%'")) as any;
  return { emails: rows.map((r: any) => r.email as string), participants: Number(p[0]?.c ?? 0) };
}

export async function purgeTestLeftovers(pool: Pool, opts: { dryRun?: boolean } = {}) {
  const found = await scanTestLeftovers(pool);
  if (!opts.dryRun) await purgeEmails(pool, "qsit-%");
  return found;
}
