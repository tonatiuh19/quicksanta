/**
 * In-memory fake DB for the `unit` test project (no network, milliseconds per test).
 *
 * Not a SQL engine: tests register responders keyed by a regex over the normalized SQL.
 * Unmatched SELECTs return [] and unmatched writes return { affectedRows: 1, insertId: n },
 * so a test only stubs the queries that matter for the path it asserts. Every call is
 * recorded in `calls` for assertions (e.g. "tenant_id was scoped").
 *
 *   const fake = installFakeDb();
 *   fake.on(/FROM users WHERE email/, () => [{ id: 1, status: "active" }]);
 *   ...
 *   expect(fake.find(/INSERT INTO otp_codes/)).toBeTruthy();
 */
import { __test, type Db, type DbResult } from "./index";

type Reply = unknown[] | DbResult | ((params: unknown[], sql: string) => unknown[] | DbResult | Promise<unknown[] | DbResult>);
type Responder = { re: RegExp; reply: Reply; once: boolean };
export type FakeCall = { sql: string; params: unknown[]; kind: "query" | "exec" };

export interface FakeDb extends Db {
  calls: FakeCall[];
  on(re: RegExp, reply: Reply): FakeDb;
  once(re: RegExp, reply: Reply): FakeDb;
  find(re: RegExp): FakeCall | undefined;
  findAll(re: RegExp): FakeCall[];
  reset(): void;
}

const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();

export function createFakeDb(): FakeDb {
  let responders: Responder[] = [];
  let nextId = 1000;
  const calls: FakeCall[] = [];

  async function resolve(sql: string, params: unknown[], kind: "query" | "exec") {
    const s = norm(sql);
    calls.push({ sql: s, params, kind });
    const idx = responders.findIndex((r) => r.re.test(s));
    if (idx >= 0) {
      const r = responders[idx];
      if (r.once) responders.splice(idx, 1);
      const out = typeof r.reply === "function" ? await r.reply(params, s) : r.reply;
      return out;
    }
    return /^\s*(SELECT|WITH)/i.test(s) ? [] : { affectedRows: 1, insertId: ++nextId };
  }

  const fake: FakeDb = {
    calls,
    async query(sql, params = []) {
      const out = await resolve(sql, params, "query");
      return (Array.isArray(out) ? out : []) as any[];
    },
    async exec(sql, params = []) {
      const out = await resolve(sql, params, "exec");
      if (Array.isArray(out)) return { affectedRows: out.length, insertId: 0 };
      return { affectedRows: Number((out as DbResult).affectedRows ?? 1), insertId: Number((out as DbResult).insertId ?? ++nextId) };
    },
    async tx(fn) {
      return fn(fake);
    },
    on(re, reply) {
      responders.push({ re, reply, once: false });
      return fake;
    },
    once(re, reply) {
      // `once` responders take priority over persistent ones.
      responders.unshift({ re, reply, once: true });
      return fake;
    },
    find: (re) => calls.find((c) => re.test(c.sql)),
    findAll: (re) => calls.filter((c) => re.test(c.sql)),
    reset() {
      responders = [];
      calls.splice(0);
    },
  };
  return fake;
}

/** Install a fresh fake as the API's DB (call in beforeEach). */
export function installFakeDb(): FakeDb {
  const fake = createFakeDb();
  __test.setDb(fake);
  __test.clearEmails();
  __test.clearSettingsCache();
  __test.setEmailTransport(null);
  return fake;
}

export const SESSION_TOKEN = "test-session-token";
export const sessionCookie = `qs_sid=${SESSION_TOKEN}`;

/**
 * Make the fake answer the session lookup as a signed-in user.
 * `memberships` drive tenant access (requireTenant).
 */
export function signIn(
  fake: FakeDb,
  user: Partial<{ id: number; email: string; full_name: string; platform_role: "owner" | "admin" | null; active_tenant_id: number | null }> = {},
  memberships: Array<{ tenant_id: number; role: "organizer" | "participant"; tenant_status?: string; tenant_name?: string }> = [],
) {
  const u = { id: 1, email: "me@example.com", full_name: "Me Tester", platform_role: null, active_tenant_id: memberships[0]?.tenant_id ?? null, ...user };
  fake.on(/FROM user_sessions s JOIN users u/, () => [
    { session_id: 99, active_tenant_id: u.active_tenant_id, id: u.id, public_id: "PUB", email: u.email, full_name: u.full_name, locale: "en", platform_role: u.platform_role },
  ]);
  fake.on(/FROM tenant_members m JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = \?/, () =>
    memberships.map((m) => ({
      tenant_id: m.tenant_id,
      tenant_public_id: `T${m.tenant_id}`,
      tenant_name: m.tenant_name ?? `Tenant ${m.tenant_id}`,
      tenant_slug: `t-${m.tenant_id}`,
      tenant_status: m.tenant_status ?? "active",
      role: m.role,
    })),
  );
  return u;
}
