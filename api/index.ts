/**
 * QuickSanta API — the whole Vercel serverless function.
 *
 * CONTRACT: keep ALL runtime API logic inline in this file. No relative value imports
 * (scripts/check-api-inline.ts blocks deploys). `import type` from ../shared is allowed.
 * Anything also needed by the client (permission matrix) is mirrored here and drift-tested.
 *
 * Layout:
 *   1. DB pool + db abstraction (swappable fake for the `unit` test project)
 *   2. Utils (ids, hashing, cookies, errors, parsers, grid query)
 *   3. Settings, audit, email (Resend, dry-run in tests / without key)
 *   4. Draw engine (pure)
 *   5. Auth (passwordless OTP, sessions, guards)
 *   6. Routes: public, auth, wizard, join, tenant app, command center, cron
 *   7. buildApp + exports
 */
import "dotenv/config";
import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import mysql, { type Pool, type PoolConnection } from "mysql2/promise";
import { Resend } from "resend";
import Stripe from "stripe";
import { z } from "zod";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import type {
  AdminEventRow,
  AdminTenantRow,
  AdminUserRow,
  AuditRow,
  CommandCenterOverview,
  EmailLogRow,
  EventPlan,
  EventRow,
  EventType,
  ExclusionRow,
  Membership,
  MyAssignment,
  PaginationInfo,
  PaymentRow,
  PricingInfo,
  ParticipantRow,
  PlatformPerm,
  PlatformRole,
  SessionUser,
  TenantDashboard,
  TenantPerm,
  TenantRole,
  WizardLaunchInput,
} from "../shared/api";

const IS_TEST = process.env.VITEST === "true";
const IS_PROD = process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";

// ════════════════════════════════════════════════════════════════════════════
// 1. Database
// ════════════════════════════════════════════════════════════════════════════

export type DbResult = { affectedRows: number; insertId: number };
/** Minimal surface every route uses. Real = mysql2 pool; unit tests = api/testFakeDb.ts. */
export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string, params?: unknown[]): Promise<DbResult>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

let _pool: Pool | null = null;
function createPool(): Pool {
  const sslOff = process.env.DB_SSL === "false";
  return mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 4000),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: sslOff ? undefined : { minVersion: "TLSv1.2" },
    waitForConnections: true,
    connectionLimit: IS_TEST ? 2 : 5,
    // TiDB's gateway drops idle connections: keep them warm and recycle.
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
    idleTimeout: 60_000,
    maxIdle: IS_TEST ? 2 : 5,
    connectTimeout: 20_000,
    timezone: "Z",
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
  });
}
function pool(): Pool {
  if (!_pool) _pool = createPool();
  return _pool;
}

const TRANSIENT = new Set(["ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "PROTOCOL_CONNECTION_LOST"]);
async function withRetry<T>(fn: () => Promise<T>, tries = 2): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e: any) {
      if (i >= tries || !TRANSIENT.has(e?.code)) throw e;
      await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    }
  }
}

function connDb(conn: Pick<PoolConnection, "query">): Db {
  const self: Db = {
    async query(sql, params = []) {
      const [rows] = await conn.query(sql, params);
      return rows as any[];
    },
    async exec(sql, params = []) {
      const [r] = (await conn.query(sql, params)) as any;
      return { affectedRows: Number(r?.affectedRows ?? 0), insertId: Number(r?.insertId ?? 0) };
    },
    async tx(fn) {
      return fn(self); // already inside a transaction
    },
  };
  return self;
}

const realDb: Db = {
  query: (sql, params = []) => withRetry(async () => (await pool().query(sql, params))[0] as any[]),
  exec: (sql, params = []) =>
    withRetry(async () => {
      const [r] = (await pool().query(sql, params)) as any;
      return { affectedRows: Number(r?.affectedRows ?? 0), insertId: Number(r?.insertId ?? 0) };
    }),
  async tx(fn) {
    const conn = await pool().getConnection();
    try {
      await conn.beginTransaction();
      const out = await fn(connDb(conn));
      await conn.commit();
      return out;
    } catch (e) {
      await conn.rollback().catch(() => undefined);
      throw e;
    } finally {
      conn.release();
    }
  },
};

let db: Db = realDb;
/** Test seam: swap the DB (unit project uses the in-memory fake). */
function setDb(next: Db | null) {
  db = next ?? realDb;
}

// ════════════════════════════════════════════════════════════════════════════
// 2. Utils
// ════════════════════════════════════════════════════════════════════════════

export const sha256 = (v: string) => crypto.createHash("sha256").update(v).digest("hex");

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** ULID-like sortable public id (26 chars). */
export function newPublicId(now = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rand = crypto.randomBytes(16);
  let r = "";
  for (let i = 0; i < 16; i++) r += CROCKFORD[rand[i] % 32];
  return time + r;
}

export function generateOtpCode(): string {
  return String(crypto.randomInt(100000, 1000000));
}

export function slugify(raw: string): string {
  return (
    String(raw || "")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "team"
  );
}

/** Run async work in small parallel batches (emails) so big exchanges finish within the function timeout. */
export async function inBatches<T>(items: T[], size: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

const toBool = (v: unknown) => v === true || v === 1 || v === "1";
const toNum = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

export class HttpError extends Error {
  constructor(
    public status: number,
    public key: string,
    public data?: Record<string, unknown>,
  ) {
    super(key);
  }
}

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
/** Wraps a handler: HttpError → {error:key}, DB constraint codes → friendly keys, else 500. */
function route(fn: Handler) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (e: any) {
      if (e instanceof HttpError) return void res.status(e.status).json({ ...(e.data ?? {}), error: e.key });
      if (e instanceof z.ZodError) {
        return void res.status(400).json({ error: "validation.invalid", fields: e.issues.map((i) => i.path.join(".")) });
      }
      if (e?.code === "ER_DUP_ENTRY" || e?.errno === 1062) return void res.status(409).json({ error: "errors.duplicate" });
      if (e?.errno === 1451 || e?.errno === 1452) return void res.status(400).json({ error: "errors.invalidReference" });
      if (!IS_TEST) console.error(`[api] ${req.method} ${req.path} failed`, e);
      res.status(500).json({ error: "errors.server" });
    }
  };
}

export function parseId(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "validation.invalidId");
  return n;
}

/** LIKE "%term%" with `!` as escape char — always pair with `ESCAPE '!'`. */
export function likeContains(raw: unknown): string | null {
  const s = String(raw ?? "").trim().slice(0, 80);
  if (!s) return null;
  return `%${s.replace(/[!%_]/g, (m) => `!${m}`)}%`;
}

export interface GridSpec {
  /** client sort key → SQL column (whitelist). */
  sortMap: Record<string, string>;
  defaultSort: string;
  defaultDir?: "ASC" | "DESC";
  /** query param → allowed values (whitelist) → SQL column. */
  filters?: Record<string, { column: string; values: readonly string[] }>;
  /** Columns searched by `q` (LIKE). */
  search?: string[];
  maxLimit?: number;
}

export interface ParsedGrid {
  page: number;
  limit: number;
  offset: number;
  orderBy: string;
  where: string[];
  params: unknown[];
}

/**
 * Single server-side grid parser (filters + search + sort + pagination).
 * Every grid endpoint: `const g = parseGridQuery(req.query, SPEC, baseWhere, baseParams)`.
 */
export function parseGridQuery(
  query: Record<string, unknown>,
  spec: GridSpec,
  baseWhere: string[] = [],
  baseParams: unknown[] = [],
): ParsedGrid {
  const int = (v: unknown, d: number) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? n : d;
  };
  const maxLimit = spec.maxLimit ?? 100;
  const page = Math.max(1, int(query.page, 1));
  const limit = Math.min(maxLimit, Math.max(1, int(query.limit, 25)));
  const sortKey = String(query.sort_by ?? "");
  const col = spec.sortMap[sortKey] ?? spec.sortMap[spec.defaultSort];
  const dirRaw = String(query.sort_dir ?? spec.defaultDir ?? "DESC").toUpperCase();
  const dir = dirRaw === "ASC" ? "ASC" : "DESC";
  const where = [...baseWhere];
  const params = [...baseParams];
  for (const [key, f] of Object.entries(spec.filters ?? {})) {
    const v = String(query[key] ?? "");
    if (v && v !== "all" && f.values.includes(v)) {
      where.push(`${f.column} = ?`);
      params.push(v);
    }
  }
  const like = likeContains(query.q);
  if (like && spec.search?.length) {
    where.push(`(${spec.search.map((c) => `${c} LIKE ? ESCAPE '!'`).join(" OR ")})`);
    for (let i = 0; i < spec.search.length; i++) params.push(like);
  }
  // Stable tiebreaker so pages never duplicate/skip rows.
  const pk = spec.sortMap.id ?? Object.values(spec.sortMap)[0];
  const orderBy = `${col} ${dir}${col === pk ? "" : `, ${pk} ${dir}`}`;
  return { page, limit, offset: (page - 1) * limit, orderBy, where, params };
}

export function paginationInfo(g: ParsedGrid, total: number): PaginationInfo {
  return { page: g.page, limit: g.limit, total, totalPages: Math.max(1, Math.ceil(total / g.limit)) };
}

/** Run COUNT + page in parallel. `from` includes joins; `select` the column list. */
async function runGrid<T>(g: ParsedGrid, select: string, from: string, map: (r: any) => T, groupBy = "") {
  const whereSql = g.where.length ? `WHERE ${g.where.join(" AND ")}` : "";
  const countSql = groupBy
    ? `SELECT COUNT(*) AS c FROM (SELECT 1 FROM ${from} ${whereSql} ${groupBy}) x`
    : `SELECT COUNT(*) AS c FROM ${from} ${whereSql}`;
  const [countRows, rows] = await Promise.all([
    db.query<{ c: number }>(countSql, g.params),
    // limit/offset are sanitized integers: inlined (LIMIT placeholders are unreliable through proxies).
    db.query(`SELECT ${select} FROM ${from} ${whereSql} ${groupBy} ORDER BY ${g.orderBy} LIMIT ${g.limit} OFFSET ${g.offset}`, g.params),
  ]);
  const total = Number(countRows[0]?.c ?? 0);
  return { ok: true as const, items: rows.map(map), pagination: paginationInfo(g, total) };
}

// Cookies (no cookie-parser dependency)
const SESSION_COOKIE = "qs_sid";
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}
function setSessionCookie(res: Response, token: string, expires: Date) {
  res.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Expires=${expires.toUTCString()}${IS_PROD ? "; Secure" : ""}`,
  );
}
function clearSessionCookie(res: Response) {
  res.append("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT${IS_PROD ? "; Secure" : ""}`);
}

function clientIp(req: Request): string {
  return String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim().slice(0, 64);
}

function appUrl(): string {
  return (process.env.PUBLIC_APP_URL || "http://localhost:8080").replace(/\/+$/, "");
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Settings, audit, email
// ════════════════════════════════════════════════════════════════════════════

const settingsCache = new Map<string, { v: string | null; at: number }>();
const TEST_SETTING_DEFAULTS: Record<string, string> = { session_days: "30", default_max_events: "10", default_max_participants: "20", signups_enabled: "1", free_max_participants: "20", pro_max_participants: "100", pro_price_cents: "890", pro_currency: "usd" };
async function readSetting(key: string, fallback: string | null = null): Promise<string | null> {
  const hit = settingsCache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.v ?? fallback;
  try {
    const rows = await db.query<{ setting_value: string | null }>("SELECT setting_value FROM system_settings WHERE setting_key = ?", [key]);
    const v = rows[0]?.setting_value ?? (IS_TEST ? TEST_SETTING_DEFAULTS[key] ?? null : null);
    settingsCache.set(key, { v, at: Date.now() });
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

async function audit(
  req: Request | null,
  action: string,
  entity: string,
  entityId: string | number | null,
  opts: { tenantId?: number | null; actorId?: number | null; meta?: Record<string, unknown> } = {},
) {
  try {
    await db.exec(
      "INSERT INTO audit_log (tenant_id, actor_user_id, action, entity, entity_id, meta, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [opts.tenantId ?? null, opts.actorId ?? null, action, entity, entityId == null ? null : String(entityId), opts.meta ? JSON.stringify(opts.meta) : null, req ? clientIp(req) : null],
    );
  } catch (e) {
    if (!IS_TEST) console.warn("[audit] failed", (e as Error).message);
  }
}

type EmailMsg = { to: string; subject: string; html: string; text: string; template: string; tenantId?: number | null };
const emailDryRuns: EmailMsg[] = [];
let resendClient: Resend | null = null;
/** Test seam: replace the email transport (returns provider id or throws). */
let emailTransport: ((m: EmailMsg) => Promise<string | null>) | null = null;

async function sendEmail(m: EmailMsg): Promise<{ ok: boolean; dryRun: boolean }> {
  const key = process.env.RESEND_API_KEY;
  let status: "sent" | "failed" | "dry_run" = "sent";
  let providerId: string | null = null;
  let error: string | null = null;
  try {
    if (emailTransport) {
      providerId = await emailTransport(m);
    } else if (IS_TEST || !key) {
      status = "dry_run";
      emailDryRuns.push(m);
      if (!IS_TEST) console.log(`[email:dry-run] to=${m.to} subject="${m.subject}"\n${m.text}`);
    } else {
      resendClient ??= new Resend(key);
      const r = await resendClient.emails.send({
        from: process.env.SMTP_FROM || "QuickSanta <onboarding@resend.dev>",
        to: m.to,
        subject: m.subject,
        html: m.html,
        text: m.text,
      });
      if ((r as any)?.error) throw new Error((r as any).error.message || "resend error");
      providerId = (r as any)?.data?.id ?? null;
    }
  } catch (e) {
    status = "failed";
    error = (e as Error).message?.slice(0, 500) ?? "error";
  }
  db.exec("INSERT INTO email_log (tenant_id, to_email, template, status, provider_id, error) VALUES (?, ?, ?, ?, ?, ?)", [
    m.tenantId ?? null,
    m.to,
    m.template,
    status,
    providerId,
    error,
  ]).catch(() => undefined);
  return { ok: status !== "failed", dryRun: status === "dry_run" };
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

type Lang = "en" | "es";
function emailLayout(lang: Lang, title: string, bodyHtml: string, cta?: { href: string; label: string }) {
  const foot = lang === "es" ? "Recibiste este correo por QuickSanta." : "You received this email from QuickSanta.";
  return `<!doctype html><html><body style="margin:0;background:#fdf6ec;font-family:Manrope,Segoe UI,Arial,sans-serif;color:#1f1a17">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:18px;overflow:hidden;border:1px solid #f1e4cf">
<tr><td style="background:#991b1b;padding:20px 28px;color:#fff;font-size:20px;font-weight:800">🎁 QuickSanta</td></tr>
<tr><td style="padding:28px"><h1 style="margin:0 0 12px;font-size:22px">${esc(title)}</h1>${bodyHtml}
${cta ? `<p style="margin:24px 0 0"><a href="${esc(cta.href)}" style="display:inline-block;background:#b91c1c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:700">${esc(cta.label)}</a></p>` : ""}
</td></tr><tr><td style="padding:16px 28px;color:#8a7f73;font-size:12px;border-top:1px solid #f1e4cf">${foot}</td></tr></table></td></tr></table></body></html>`;
}

export function tplOtp(lang: Lang, code: string) {
  const title = lang === "es" ? "Tu código de acceso" : "Your sign-in code";
  const p =
    lang === "es"
      ? "Usa este código para entrar. Vence en 10 minutos. Si no lo pediste, ignora este correo."
      : "Use this code to sign in. It expires in 10 minutes. If you didn't request it, ignore this email.";
  const html = emailLayout(
    lang,
    title,
    `<p style="margin:0 0 18px;line-height:1.6">${p}</p><p style="font-size:34px;letter-spacing:10px;font-weight:800;margin:0;color:#991b1b">${esc(code)}</p>`,
  );
  return { subject: `${code} · ${title}`, html, text: `${title}: ${code}\n${p}` };
}

export function tplInvite(lang: Lang, o: { organizer: string; eventName: string; typeName: string; date: string | null; budget: string | null; link: string }) {
  const es = lang === "es";
  const title = es ? `${o.organizer} te invitó a "${o.eventName}"` : `${o.organizer} invited you to "${o.eventName}"`;
  const lines = [
    `<strong>${esc(o.typeName)}</strong>`,
    o.date ? `${es ? "Fecha" : "Date"}: ${esc(o.date)}` : "",
    o.budget ? `${es ? "Presupuesto" : "Budget"}: ${esc(o.budget)}` : "",
  ].filter(Boolean);
  const html = emailLayout(lang, title, `<p style="margin:0;line-height:1.8">${lines.join("<br>")}</p>`, { href: o.link, label: es ? "Unirme" : "Join the exchange" });
  return { subject: title, html, text: `${title}\n${o.link}` };
}

export function tplAssignment(lang: Lang, o: { eventName: string; link: string }) {
  const es = lang === "es";
  const title = es ? `¡El sorteo de "${o.eventName}" está listo!` : `The draw for "${o.eventName}" is ready!`;
  const p = es ? "Entra para descubrir a quién le regalas. Es secreto 🤫" : "Sign in to discover who you're gifting. Keep it secret 🤫";
  const html = emailLayout(lang, title, `<p style="margin:0;line-height:1.6">${p}</p>`, { href: o.link, label: es ? "Ver mi asignación" : "Reveal my match" });
  return { subject: title, html, text: `${title}\n${p}\n${o.link}` };
}

// ════════════════════════════════════════════════════════════════════════════
// 4. Draw engine (pure)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Assign each giver exactly one receiver: no self, every receiver once, honoring
 * exclusions (giver → receiver pairs). Randomized backtracking; returns null when impossible.
 * `rand` is injectable for deterministic tests.
 */
export function drawAssignments(
  ids: number[],
  excluded: Array<[number, number]>,
  rand: () => number = () => crypto.randomInt(0, 2 ** 31) / 2 ** 31,
): Map<number, number> | null {
  const n = ids.length;
  if (n < 2) return null;
  const blocked = new Set(excluded.map(([a, b]) => `${a}>${b}`));
  const allowed = (g: number, r: number) => g !== r && !blocked.has(`${g}>${r}`);
  const shuffle = <T>(arr: T[]) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  // Most-constrained givers first keeps backtracking tiny.
  const givers = shuffle(ids).sort((a, b) => ids.filter((r) => allowed(a, r)).length - ids.filter((r) => allowed(b, r)).length);
  const used = new Set<number>();
  const out = new Map<number, number>();
  let steps = 0;
  const solve = (i: number): boolean => {
    if (i === givers.length) return true;
    if (++steps > 200_000) return false;
    const g = givers[i];
    for (const r of shuffle(ids)) {
      if (used.has(r) || !allowed(g, r)) continue;
      used.add(r);
      out.set(g, r);
      if (solve(i + 1)) return true;
      used.delete(r);
      out.delete(g);
    }
    return false;
  };
  return solve(0) ? out : null;
}

/** Expand UI exclusions (bidirectional flag) into directed pairs. */
/**
 * Allowed organizer status changes. Drawing/opening after payment happen through their own endpoints.
 * open → completed is only for services without a draw (white elephant, cookie swap).
 */
export function canTransition(from: string, to: string, usesDraw: boolean): boolean {
  const table: Record<string, string[]> = {
    draft: ["open", "cancelled"],
    pending_payment: ["cancelled"],
    open: usesDraw ? ["cancelled"] : ["completed", "cancelled"],
    drawn: ["completed"],
    completed: [],
    cancelled: [],
  };
  return (table[from] ?? []).includes(to);
}

export function expandExclusions(rows: Array<{ giver: number; receiver: number; bidirectional: boolean }>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const r of rows) {
    out.push([r.giver, r.receiver]);
    if (r.bidirectional) out.push([r.receiver, r.giver]);
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// 5. Auth
// ════════════════════════════════════════════════════════════════════════════

const OTP_TTL_MIN = 10;
const OTP_MAX_ATTEMPTS = 5;

/** Mirror of shared/api.ts PLATFORM_PERMS / TENANT_PERMS (drift-tested in api/permissions.test.ts). */
export const PLATFORM_PERMS: Record<PlatformPerm, PlatformRole[]> = {
  overview: ["owner", "admin"],
  "tenants.read": ["owner", "admin"],
  "tenants.write": ["owner", "admin"],
  "users.read": ["owner", "admin"],
  "users.write": ["owner", "admin"],
  "users.roles": ["owner"],
  "events.read": ["owner", "admin"],
  "catalog.write": ["owner", "admin"],
  "audit.read": ["owner", "admin"],
  "emails.read": ["owner", "admin"],
  "payments.read": ["owner", "admin"],
  "settings.write": ["owner"],
};
export const TENANT_PERMS: Record<TenantPerm, TenantRole[]> = {
  "events.manage": ["organizer"],
  "participants.manage": ["organizer"],
  "draw.run": ["organizer"],
  "members.manage": ["organizer"],
  "events.view_own": ["organizer", "participant"],
};
const platformCan = (role: PlatformRole | null | undefined, perm: PlatformPerm) => Boolean(role && PLATFORM_PERMS[perm].includes(role));
const tenantCan = (role: TenantRole | null | undefined, perm: TenantPerm) => Boolean(role && TENANT_PERMS[perm].includes(role));

type Authed = SessionUser & { session_id: number };
type TenantCtx = { tenant_id: number; role: TenantRole; tenant_name: string };

async function loadMemberships(userId: number): Promise<Membership[]> {
  const rows = await db.query(
    `SELECT t.id AS tenant_id, t.public_id AS tenant_public_id, t.name AS tenant_name, t.slug AS tenant_slug, t.status AS tenant_status, m.role
       FROM tenant_members m JOIN tenants t ON t.id = m.tenant_id
      WHERE m.user_id = ? AND m.status = 'active' AND t.status <> 'archived'
      ORDER BY FIELD(m.role, 'organizer', 'participant'), t.name`,
    [userId],
  );
  return rows.map((r) => ({ ...r, tenant_id: Number(r.tenant_id) }));
}

async function loadSessionUser(req: Request): Promise<Authed | null> {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token || token.length > 200) return null;
  const rows = await db.query(
    `SELECT s.id AS session_id, s.active_tenant_id, u.id, u.public_id, u.email, u.full_name, u.locale, u.platform_role
       FROM user_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.is_active = 1 AND s.expires_at > UTC_TIMESTAMP() AND u.status = 'active'
      LIMIT 1`,
    [sha256(token)],
  );
  const u = rows[0];
  if (!u) return null;
  const memberships = await loadMemberships(Number(u.id));
  return {
    session_id: Number(u.session_id),
    id: Number(u.id),
    public_id: u.public_id,
    email: u.email,
    full_name: u.full_name,
    locale: u.locale === "es" ? "es" : "en",
    platform_role: u.platform_role ?? null,
    memberships,
    active_tenant_id: u.active_tenant_id ? Number(u.active_tenant_id) : memberships[0]?.tenant_id ?? null,
  };
}

const authed = (res: Response) => res.locals.user as Authed;
const tenantCtx = (res: Response) => res.locals.tenant as TenantCtx;

function requireAuth() {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = await loadSessionUser(req);
      if (!u) return void res.status(401).json({ error: "errors.unauthorized" });
      res.locals.user = u;
      next();
    } catch (e) {
      next(e);
    }
  };
}

function requirePlatform(perm: PlatformPerm) {
  const auth = requireAuth();
  return (req: Request, res: Response, next: NextFunction) =>
    auth(req, res, (err?: unknown) => {
      if (err) return next(err);
      if (!platformCan(authed(res).platform_role, perm)) return void res.status(403).json({ error: "errors.forbidden" });
      next();
    });
}

/** Resolves the tenant from `X-Tenant-Id` (or the session's active tenant) and checks the member's role. */
function requireTenant(perm: TenantPerm) {
  const auth = requireAuth();
  return (req: Request, res: Response, next: NextFunction) =>
    auth(req, res, (err?: unknown) => {
      if (err) return next(err);
      const u = authed(res);
      const hdr = Number(req.headers["x-tenant-id"]);
      const tenantId = Number.isInteger(hdr) && hdr > 0 ? hdr : u.active_tenant_id;
      const m = u.memberships.find((x) => x.tenant_id === tenantId);
      if (!m) return void res.status(403).json({ error: "errors.noTenantAccess" });
      if (m.tenant_status !== "active") return void res.status(423).json({ error: "errors.tenantSuspended" });
      if (!tenantCan(m.role, perm)) return void res.status(403).json({ error: "errors.forbidden" });
      res.locals.tenant = { tenant_id: m.tenant_id, role: m.role, tenant_name: m.tenant_name } satisfies TenantCtx;
      next();
    });
}

/** Non-GET requests must come from our own origin (cookie auth → CSRF guard). */
function csrfOriginGuard(req: Request, res: Response, next: NextFunction) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  if (!req.path.startsWith("/api/") || req.path.startsWith("/api/cron/") || req.path.startsWith("/api/webhooks/")) return next();
  const origin = String(req.headers.origin || "");
  if (!origin) {
    // No Origin: browsers still send Sec-Fetch-Site; only server-to-server calls lack both.
    const site = String(req.headers["sec-fetch-site"] || "");
    if (site && site !== "same-origin" && site !== "none") return void res.status(403).json({ error: "errors.badOrigin" });
    return next();
  }
  let host = "";
  try {
    host = new URL(origin).host;
  } catch {
    return void res.status(403).json({ error: "errors.badOrigin" });
  }
  const allowed = new Set([String(req.headers.host || ""), (() => { try { return new URL(appUrl()).host; } catch { return ""; } })()]);
  if (allowed.has(host) || /^localhost(:\d+)?$/.test(host) || /^127\.0\.0\.1(:\d+)?$/.test(host)) return next();
  if (/\.vercel\.app$/.test(host) && !IS_PROD) return next();
  res.status(403).json({ error: "errors.badOrigin" });
}

const limiter = (windowMs: number, max: number) =>
  rateLimit({ windowMs, max: IS_TEST ? 10_000 : max, standardHeaders: true, legacyHeaders: false, message: { error: "errors.tooMany" } });
const otpRequestLimiter = limiter(15 * 60_000, 8);
const otpVerifyLimiter = limiter(15 * 60_000, 30);
const writeLimiter = limiter(60_000, 120);

async function mintSession(req: Request, res: Response, userId: number, activeTenantId: number | null) {
  const days = Math.max(1, Math.min(90, Number(await readSetting("session_days", "30")) || 30));
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + days * 86_400_000);
  await db.exec(
    "INSERT INTO user_sessions (user_id, token_hash, active_tenant_id, ip_address, user_agent, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    [userId, sha256(token), activeTenantId, clientIp(req), String(req.headers["user-agent"] || "").slice(0, 255), expires.toISOString().slice(0, 19).replace("T", " ")],
  );
  setSessionCookie(res, token, expires);
}


// ════════════════════════════════════════════════════════════════════════════
// 5b. Pricing + Stripe (Free ≤ free_max, Pro paid per exchange, Enterprise = tenant plan)
// ════════════════════════════════════════════════════════════════════════════

export async function pricingInfo(): Promise<PricingInfo> {
  const [freeMax, proMax, cents, currency] = await Promise.all([
    readSetting("free_max_participants", "20"),
    readSetting("pro_max_participants", "100"),
    readSetting("pro_price_cents", "890"),
    readSetting("pro_currency", "usd"),
  ]);
  return {
    free_max_participants: Number(freeMax) || 20,
    pro_max_participants: Number(proMax) || 100,
    pro_price_cents: Number(cents) || 890,
    pro_currency: String(currency || "usd").toLowerCase(),
  };
}

/** Effective people limit for one exchange. Enterprise tenants use their own (Command Center) limit. */
export function participantLimit(p: PricingInfo, eventPlan: EventPlan, tenantPlan: string | null | undefined, tenantMax: number): number {
  if (tenantPlan === "enterprise") return Math.max(tenantMax || 0, p.pro_max_participants);
  return eventPlan === "pro" ? p.pro_max_participants : p.free_max_participants;
}

/** Minimal surface of the Stripe SDK we use (swappable in tests). */
export interface PaymentsApi {
  createIntent(o: { amount: number; currency: string; metadata: Record<string, string>; description: string; email: string; idempotencyKey: string }): Promise<{ id: string; client_secret: string | null; status: string }>;
  retrieveIntent(id: string): Promise<{ id: string; status: string; amount: number; currency: string; metadata: Record<string, string>; card_brand: string | null; card_last4: string | null; client_secret?: string | null }>;
  constructWebhookEvent(raw: Buffer, signature: string, secret: string): { type: string; data: { object: any } };
}

let paymentsOverride: PaymentsApi | null = null;
let stripeClient: Stripe | null = null;
function paymentsApi(): PaymentsApi {
  if (paymentsOverride) return paymentsOverride;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || IS_TEST) throw new HttpError(503, "errors.paymentsUnavailable");
  stripeClient ??= new Stripe(key);
  const st = stripeClient;
  return {
    async createIntent(o) {
      const pi = await st.paymentIntents.create(
        {
          amount: o.amount,
          currency: o.currency,
          metadata: o.metadata,
          description: o.description,
          receipt_email: o.email,
          automatic_payment_methods: { enabled: true, allow_redirects: "never" },
        },
        { idempotencyKey: o.idempotencyKey },
      );
      return { id: pi.id, client_secret: pi.client_secret, status: pi.status };
    },
    async retrieveIntent(id) {
      const pi = await st.paymentIntents.retrieve(id, { expand: ["latest_charge"] });
      const charge: any = pi.latest_charge && typeof pi.latest_charge === "object" ? pi.latest_charge : null;
      return {
        id: pi.id,
        status: pi.status,
        amount: pi.amount,
        currency: pi.currency,
        metadata: (pi.metadata ?? {}) as Record<string, string>,
        card_brand: charge?.payment_method_details?.card?.brand ?? null,
        card_last4: charge?.payment_method_details?.card?.last4 ?? null,
        client_secret: pi.client_secret,
      };
    },
    constructWebhookEvent(raw, signature, secret) {
      return st.webhooks.constructEvent(raw, signature, secret) as any;
    },
  };
}

/**
 * Idempotent: marks the exchange Pro once its payment succeeded, opens a pending exchange and
 * sends the invitations that were waiting for payment. Safe to call from confirm + webhook.
 */
async function finalizePayment(req: Request | null, intent: Awaited<ReturnType<PaymentsApi["retrieveIntent"]>>): Promise<{ eventId: number; tenantId: number } | null> {
  const eventId = Number(intent.metadata?.event_id);
  const tenantId = Number(intent.metadata?.tenant_id);
  if (!eventId || !tenantId) return null;
  if (intent.status !== "succeeded") {
    await db.exec("UPDATE payments SET status = ? WHERE provider_payment_id = ? AND status = 'pending'", [intent.status === "canceled" ? "failed" : "pending", intent.id]);
    return null;
  }
  const pricing = await pricingInfo();
  if (intent.amount < pricing.pro_price_cents || intent.currency.toLowerCase() !== pricing.pro_currency) return null;
  const opened = await db.tx(async (tx) => {
    await tx.exec("UPDATE payments SET status = 'succeeded', card_brand = ?, card_last4 = ? WHERE provider_payment_id = ? AND tenant_id = ?", [intent.card_brand, intent.card_last4, intent.id, tenantId]);
    // Only the first finalize flips the event (paid_at IS NULL guard).
    const r = await tx.exec(
      "UPDATE events SET plan = 'pro', paid_at = UTC_TIMESTAMP(), status = IF(status = 'pending_payment', 'open', status) WHERE id = ? AND tenant_id = ? AND paid_at IS NULL",
      [eventId, tenantId],
    );
    return r.affectedRows === 1;
  });
  if (!opened) return { eventId, tenantId };
  const ev = (await db.query("SELECT e.name, e.exchange_date, e.budget_min, e.budget_max, e.currency, e.invites_pending, et.name_en, et.name_es, u.full_name AS organizer FROM events e JOIN event_types et ON et.id = e.event_type_id LEFT JOIN users u ON u.id = e.created_by WHERE e.id = ?", [eventId]))[0];
  if (ev && toBool(ev.invites_pending) && req) {
    const people = await db.query("SELECT id, email FROM participants WHERE event_id = ? AND tenant_id = ? AND status = 'invited' AND invite_token_hash IS NULL", [eventId, tenantId]);
    for (const p of people) {
      await sendInvite(req, db, {
        tenantId,
        participantId: Number(p.id),
        email: p.email,
        organizer: ev.organizer || "QuickSanta",
        event: { name: ev.name, exchange_date: ev.exchange_date, budget_min: toNum(ev.budget_min), budget_max: toNum(ev.budget_max), currency: ev.currency },
        typeName: reqLang(req) === "es" ? ev.name_es : ev.name_en,
      });
    }
    await db.exec("UPDATE events SET invites_pending = 0 WHERE id = ?", [eventId]);
  }
  await audit(req, "event.paid", "event", eventId, { tenantId, meta: { amount: intent.amount, currency: intent.currency, intent: intent.id } });
  return { eventId, tenantId };
}

// ════════════════════════════════════════════════════════════════════════════
// 6. Routes
// ════════════════════════════════════════════════════════════════════════════

const reqLang = (req: Request): Lang => (String(req.headers["accept-language"] || "").toLowerCase().startsWith("es") ? "es" : "en");
const emailSchema = z.string().trim().toLowerCase().email().max(190);

function mapEventType(r: any): EventType {
  return {
    id: Number(r.id),
    slug: r.slug,
    name_en: r.name_en,
    name_es: r.name_es,
    description_en: r.description_en,
    description_es: r.description_es,
    icon: r.icon,
    uses_draw: toBool(r.uses_draw),
    is_active: toBool(r.is_active),
    sort_order: Number(r.sort_order ?? 0),
  };
}

const EVENT_SELECT = `e.id, e.public_id, e.tenant_id, et.slug AS event_type_slug, et.name_en AS event_type_name, e.name, e.description, e.status,
  e.plan, e.paid_at, e.budget_min, e.budget_max, e.currency, e.exchange_date, e.rsvp_deadline, e.location, e.allow_wishlists, e.drawn_at, e.created_at,
  (SELECT COUNT(*) FROM participants p WHERE p.event_id = e.id AND p.status IN ('invited','joined')) AS participant_count,
  (SELECT COUNT(*) FROM participants p WHERE p.event_id = e.id AND p.status = 'joined') AS joined_count`;

function mapEvent(r: any): EventRow {
  return {
    id: Number(r.id),
    public_id: r.public_id,
    tenant_id: Number(r.tenant_id),
    event_type_slug: r.event_type_slug,
    event_type_name: r.event_type_name,
    name: r.name,
    description: r.description ?? null,
    status: r.status,
    plan: r.plan === "pro" ? "pro" : "free",
    paid_at: r.paid_at ?? null,
    budget_min: toNum(r.budget_min),
    budget_max: toNum(r.budget_max),
    currency: r.currency,
    exchange_date: r.exchange_date ?? null,
    rsvp_deadline: r.rsvp_deadline ?? null,
    location: r.location ?? null,
    allow_wishlists: toBool(r.allow_wishlists),
    participant_count: Number(r.participant_count ?? 0),
    joined_count: Number(r.joined_count ?? 0),
    drawn_at: r.drawn_at ?? null,
    created_at: r.created_at,
  };
}

function mapParticipant(r: any): ParticipantRow {
  return {
    id: Number(r.id),
    public_id: r.public_id,
    event_id: Number(r.event_id),
    name: r.name,
    email: r.email,
    status: r.status,
    has_wishlist: Boolean(r.wishlist && String(r.wishlist).trim()),
    invited_at: r.invited_at ?? null,
    joined_at: r.joined_at ?? null,
    created_at: r.created_at,
  };
}

function budgetLabel(min: number | null, max: number | null, currency: string): string | null {
  if (min == null && max == null) return null;
  if (min != null && max != null) return `${min}–${max} ${currency}`;
  return `${min ?? max} ${currency}`;
}

/** Create invite token for a participant and email it. Returns true when sent (or dry-run). */
async function sendInvite(
  req: Request,
  dbx: Db,
  o: { tenantId: number; participantId: number; email: string; organizer: string; event: { name: string; exchange_date: string | null; budget_min: number | null; budget_max: number | null; currency: string }; typeName: string },
) {
  const token = crypto.randomBytes(24).toString("base64url");
  await dbx.exec("UPDATE participants SET invite_token_hash = ?, invited_at = UTC_TIMESTAMP() WHERE id = ? AND tenant_id = ?", [sha256(token), o.participantId, o.tenantId]);
  const tpl = tplInvite(reqLang(req), {
    organizer: o.organizer,
    eventName: o.event.name,
    typeName: o.typeName,
    date: o.event.exchange_date,
    budget: budgetLabel(o.event.budget_min, o.event.budget_max, o.event.currency),
    link: `${appUrl()}/join/${token}`,
  });
  const r = await sendEmail({ to: o.email, ...tpl, template: "invite", tenantId: o.tenantId });
  return r.ok;
}

async function loadTenantEvent(tenantId: number, eventId: number) {
  const rows = await db.query(
    `SELECT ${EVENT_SELECT}, et.uses_draw, t.max_participants_per_event, t.plan AS tenant_plan FROM events e
       JOIN event_types et ON et.id = e.event_type_id JOIN tenants t ON t.id = e.tenant_id
      WHERE e.id = ? AND e.tenant_id = ? LIMIT 1`,
    [eventId, tenantId],
  );
  if (!rows[0]) throw new HttpError(404, "errors.notFound");
  const event = mapEvent(rows[0]);
  const pricing = await pricingInfo();
  const maxParticipants = participantLimit(pricing, event.plan, rows[0].tenant_plan, Number(rows[0].max_participants_per_event));
  return { row: rows[0], event, maxParticipants, pricing };
}

function registerPublicRoutes(app: express.Express) {
  app.get("/api/health", (_req, res) => res.json({ ok: true, service: "quicksanta", time: new Date().toISOString() }));

  app.get(
    "/api/pricing",
    route(async (_req, res) => {
      res.json({ ok: true, ...(await pricingInfo()) });
    }),
  );

  /** Stripe webhook: payment_intent.succeeded / payment_failed (signature verified on the raw body). */
  app.post(
    "/api/webhooks/stripe",
    route(async (req, res) => {
      const secret = process.env.STRIPE_WEBHOOK_SECRET;
      const sig = String(req.headers["stripe-signature"] || "");
      const raw = (req as any).rawBody as Buffer | undefined;
      if (!secret || !sig || !raw) throw new HttpError(400, "errors.badSignature");
      let evt: { type: string; data: { object: any } };
      try {
        evt = paymentsApi().constructWebhookEvent(raw, sig, secret);
      } catch {
        throw new HttpError(400, "errors.badSignature");
      }
      if (evt.type === "payment_intent.succeeded" || evt.type === "payment_intent.payment_failed" || evt.type === "payment_intent.canceled") {
        const intent = await paymentsApi().retrieveIntent(String(evt.data.object?.id));
        if (evt.type === "payment_intent.succeeded") await finalizePayment(req, intent);
        else await db.exec("UPDATE payments SET status = 'failed' WHERE provider_payment_id = ? AND status = 'pending'", [intent.id]);
      }
      res.json({ received: true });
    }),
  );

  app.get(
    "/api/event-types",
    route(async (_req, res) => {
      const rows = await db.query("SELECT * FROM event_types WHERE is_active = 1 ORDER BY sort_order, id");
      res.json({ ok: true, items: rows.map(mapEventType) });
    }),
  );
}

function registerAuthRoutes(app: express.Express) {
  app.post(
    "/api/auth/otp/request",
    otpRequestLimiter,
    route(async (req, res) => {
      const email = emailSchema.parse(req.body?.email);
      const users = await db.query("SELECT id, status FROM users WHERE email = ? LIMIT 1", [email]);
      const u = users[0];
      // Anti-enumeration: suspended accounts get the same answer, but no code.
      if (u && u.status !== "active") return void res.json({ ok: true, sent: true });
      if (!u && (await readSetting("signups_enabled", "1")) !== "1") return void res.json({ ok: true, sent: true });
      // Per-email throttle (on top of the per-IP limiter): max 5 codes / 15 min, silently.
      const recent = await db.query<{ c: number }>("SELECT COUNT(*) AS c FROM otp_codes WHERE email = ? AND created_at > UTC_TIMESTAMP() - INTERVAL 15 MINUTE", [email]);
      if (Number(recent[0]?.c ?? 0) >= 5) return void res.json({ ok: true, sent: true });
      const code = generateOtpCode();
      const expires = new Date(Date.now() + OTP_TTL_MIN * 60_000).toISOString().slice(0, 19).replace("T", " ");
      const ins = await db.exec("INSERT INTO otp_codes (email, code_hash, expires_at, ip_address) VALUES (?, ?, ?, ?)", [email, sha256(code), expires, clientIp(req)]);
      const tpl = tplOtp(reqLang(req), code);
      const sent = await sendEmail({ to: email, ...tpl, template: "otp" });
      if (!sent.ok) {
        await db.exec("UPDATE otp_codes SET consumed_at = UTC_TIMESTAMP() WHERE id = ?", [ins.insertId]);
        throw new HttpError(502, "errors.otpSendFailed");
      }
      res.json({ ok: true, sent: true });
    }),
  );

  app.post(
    "/api/auth/otp/verify",
    otpVerifyLimiter,
    route(async (req, res) => {
      const body = z.object({ email: emailSchema, code: z.string().regex(/^\d{6}$/), full_name: z.string().trim().max(120).optional() }).parse(req.body ?? {});
      const rows = await db.query(
        "SELECT id, code_hash, attempts FROM otp_codes WHERE email = ? AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP() ORDER BY id DESC LIMIT 1",
        [body.email],
      );
      const otp = rows[0];
      if (!otp) throw new HttpError(400, "errors.otpInvalid");
      if (Number(otp.attempts) >= OTP_MAX_ATTEMPTS) throw new HttpError(429, "errors.authLocked");
      // Across codes: too many wrong guesses for this email in 15 min locks it (new codes don't reset it).
      const fails = await db.query<{ n: number }>("SELECT COALESCE(SUM(attempts), 0) AS n FROM otp_codes WHERE email = ? AND created_at > UTC_TIMESTAMP() - INTERVAL 15 MINUTE", [body.email]);
      if (Number(fails[0]?.n ?? 0) >= OTP_MAX_ATTEMPTS * 2) throw new HttpError(429, "errors.authLocked");
      const hash = sha256(body.code);
      if (hash !== otp.code_hash) {
        await db.exec("UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?", [otp.id]);
        throw new HttpError(400, "errors.otpInvalid", { attempts_left: Math.max(0, OTP_MAX_ATTEMPTS - Number(otp.attempts) - 1) });
      }
      // Atomic consume: two parallel verifies can't both mint a session.
      const consumed = await db.exec("UPDATE otp_codes SET consumed_at = UTC_TIMESTAMP() WHERE id = ? AND consumed_at IS NULL AND code_hash = ?", [otp.id, hash]);
      if (consumed.affectedRows !== 1) throw new HttpError(400, "errors.otpInvalid");

      let users = await db.query("SELECT id, status FROM users WHERE email = ? LIMIT 1", [body.email]);
      let isNew = false;
      if (!users[0]) {
        const fallbackName = body.full_name || body.email.split("@")[0];
        await db.exec("INSERT INTO users (public_id, email, full_name, locale) VALUES (?, ?, ?, ?)", [newPublicId(), body.email, fallbackName, reqLang(req)]);
        users = await db.query("SELECT id, status FROM users WHERE email = ? LIMIT 1", [body.email]);
        isNew = true;
      }
      const u = users[0];
      if (!u || u.status !== "active") throw new HttpError(403, "errors.accountSuspended");
      if (body.full_name) await db.exec("UPDATE users SET full_name = ? WHERE id = ? AND (full_name = '' OR full_name = ?)", [body.full_name, u.id, body.email.split("@")[0]]);
      await db.exec("UPDATE users SET last_login_at = UTC_TIMESTAMP() WHERE id = ?", [u.id]);
      const memberships = await loadMemberships(Number(u.id));
      await mintSession(req, res, Number(u.id), memberships[0]?.tenant_id ?? null);
      await audit(req, isNew ? "user.signup" : "user.login", "user", u.id, { actorId: Number(u.id) });
      res.json({ ok: true, is_new: isNew });
    }),
  );

  app.get(
    "/api/auth/me",
    route(async (req, res) => {
      const u = await loadSessionUser(req);
      if (!u) throw new HttpError(401, "errors.unauthorized");
      const { session_id: _s, ...user } = u;
      res.json({ ok: true, user });
    }),
  );

  app.post(
    "/api/auth/logout",
    route(async (req, res) => {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (token) await db.exec("UPDATE user_sessions SET is_active = 0 WHERE token_hash = ?", [sha256(token)]);
      clearSessionCookie(res);
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/auth/switch-tenant",
    requireAuth(),
    route(async (req, res) => {
      const u = authed(res);
      const tenantId = parseId(req.body?.tenant_id);
      if (!u.memberships.some((m) => m.tenant_id === tenantId)) throw new HttpError(403, "errors.noTenantAccess");
      await db.exec("UPDATE user_sessions SET active_tenant_id = ? WHERE id = ?", [tenantId, u.session_id]);
      res.json({ ok: true, active_tenant_id: tenantId });
    }),
  );

  app.patch(
    "/api/auth/profile",
    requireAuth(),
    route(async (req, res) => {
      const body = z.object({ full_name: z.string().trim().min(1).max(120).optional(), locale: z.enum(["en", "es"]).optional() }).parse(req.body ?? {});
      const u = authed(res);
      if (body.full_name !== undefined) await db.exec("UPDATE users SET full_name = ? WHERE id = ?", [body.full_name, u.id]);
      if (body.locale !== undefined) await db.exec("UPDATE users SET locale = ? WHERE id = ?", [body.locale, u.id]);
      res.json({ ok: true });
    }),
  );
}

const wizardSchema = z.object({
  eventTypeSlug: z.string().min(1).max(40),
  name: z.string().trim().min(2).max(140),
  description: z.string().trim().max(2000).optional().default(""),
  exchangeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  rsvpDeadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  budgetMin: z.number().min(0).max(1_000_000).nullable().optional(),
  budgetMax: z.number().min(0).max(1_000_000).nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).default("USD"),
  location: z.string().trim().max(200).nullable().optional(),
  allowWishlists: z.boolean().default(true),
  organizerName: z.string().trim().min(1).max(120),
  includeMe: z.boolean().default(true),
  participants: z.array(z.object({ name: z.string().trim().min(1).max(120), email: emailSchema })).max(500),
  exclusions: z.array(z.object({ a: z.union([z.literal("me"), emailSchema]), b: z.union([z.literal("me"), emailSchema]), bidirectional: z.boolean() })).max(500).default([]),
  sendInvites: z.boolean().default(true),
  tenantName: z.string().trim().max(120).optional(),
  plan: z.enum(["free", "pro"]).default("free"),
});

function registerWizardRoutes(app: express.Express) {
  /**
   * One-shot launch from the onboarding wizard: creates the tenant (if the user has none they organize),
   * the event, participants, exclusions, and sends invites. All in one transaction.
   */
  app.post(
    "/api/wizard/launch",
    writeLimiter,
    requireAuth(),
    route(async (req, res) => {
      const input = wizardSchema.parse(req.body ?? {}) as unknown as WizardLaunchInput & { description: string };
      const u = authed(res);
      if (input.budgetMin != null && input.budgetMax != null && input.budgetMin > input.budgetMax) throw new HttpError(400, "validation.budgetRange");

      const types = await db.query("SELECT * FROM event_types WHERE slug = ? AND is_active = 1 LIMIT 1", [input.eventTypeSlug]);
      const type = types[0] ? mapEventType(types[0]) : null;
      if (!type) throw new HttpError(400, "validation.eventType");

      // Organizer first (index 0) when they take part, then the list, deduped by email.
      const people: Array<{ name: string; email: string; isMe: boolean }> = [];
      const seen = new Set<string>();
      if (input.includeMe) {
        people.push({ name: input.organizerName, email: u.email, isMe: true });
        seen.add(u.email);
      }
      for (const p of input.participants) {
        if (seen.has(p.email)) continue;
        seen.add(p.email);
        people.push({ ...p, isMe: false });
      }
      const minPeople = type.uses_draw ? 3 : 1;
      if (people.length < minPeople) throw new HttpError(400, "validation.minParticipants", { min: minPeople });
      // Exclusions reference people by email ("me" = the organizer), so list edits / login can't shift them.
      const indexOf = (ref: string) => people.findIndex((p) => (ref === "me" ? p.isMe : p.email === ref));
      const excl = input.exclusions.map((x) => ({ a: indexOf(x.a), b: indexOf(x.b), bidirectional: x.bidirectional }));
      for (const x of excl) {
        if (x.a < 0 || x.b < 0 || x.a === x.b) throw new HttpError(400, "validation.exclusion");
      }
      if (type.uses_draw && !drawAssignments(people.map((_, i) => i + 1), expandExclusions(excl.map((x) => ({ giver: x.a + 1, receiver: x.b + 1, bidirectional: x.bidirectional }))))) {
        throw new HttpError(400, "validation.drawImpossible");
      }

      if (u.memberships.some((m) => m.role === "organizer" && m.tenant_status === "suspended")) throw new HttpError(423, "errors.tenantSuspended");
      const organizerTenant = u.memberships.find((m) => m.role === "organizer" && m.tenant_status === "active");
      const defaultMaxEvents = Number(await readSetting("default_max_events", "10")) || 10;
      const defaultMaxParticipants = Number(await readSetting("default_max_participants", "20")) || 20;
      const pricing = await pricingInfo();
      const plan: EventPlan = (input as any).plan === "pro" ? "pro" : "free";

      const result = await db.tx(async (tx) => {
        let tenantId = organizerTenant?.tenant_id ?? 0;
        let tenantPlan: string = "free";
        let tenantMax = defaultMaxParticipants;
        if (!tenantId) {
          if ((await readSetting("signups_enabled", "1")) !== "1") throw new HttpError(403, "errors.signupsDisabled");
          const name = input.tenantName?.trim() || `${input.organizerName.split(" ")[0]}'s exchanges`;
          const slug = `${slugify(name)}-${crypto.randomBytes(3).toString("hex")}`;
          const t = await tx.exec(
            "INSERT INTO tenants (public_id, name, slug, max_events, max_participants_per_event, locale, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [newPublicId(), name, slug, defaultMaxEvents, defaultMaxParticipants, reqLang(req), u.id],
          );
          tenantId = t.insertId;
          await tx.exec("INSERT INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, 'organizer')", [tenantId, u.id]);
        } else {
          const lim = await tx.query("SELECT plan, max_events, max_participants_per_event, (SELECT COUNT(*) FROM events WHERE tenant_id = ? AND status NOT IN ('cancelled','completed')) AS active FROM tenants WHERE id = ?", [tenantId, tenantId]);
          if (lim[0] && Number(lim[0].active) >= Number(lim[0].max_events)) throw new HttpError(402, "errors.eventLimit");
          tenantPlan = lim[0]?.plan ?? "free";
          tenantMax = Number(lim[0]?.max_participants_per_event ?? tenantMax);
        }
        const maxParticipants = participantLimit(pricing, plan, tenantPlan, tenantMax);
        if (people.length > maxParticipants) {
          // Free exchange too big → the client offers Pro; Pro too big → Enterprise.
          const needs = plan === "free" && people.length <= participantLimit(pricing, "pro", tenantPlan, tenantMax) ? "errors.needsPro" : "errors.participantLimit";
          throw new HttpError(402, needs, { max: maxParticipants, free_max: pricing.free_max_participants, pro_max: pricing.pro_max_participants });
        }
        // Pro on an Enterprise tenant is already covered: no payment needed.
        const payNow = plan === "pro" && tenantPlan !== "enterprise";

        const publicId = newPublicId();
        const ev = await tx.exec(
          `INSERT INTO events (public_id, tenant_id, event_type_id, name, description, status, plan, invites_pending, budget_min, budget_max, currency, exchange_date, rsvp_deadline, location, allow_wishlists, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [publicId, tenantId, type.id, input.name, input.description || null, payNow ? "pending_payment" : "open", payNow ? "free" : plan, payNow && input.sendInvites ? 1 : 0, input.budgetMin ?? null, input.budgetMax ?? null, input.currency, input.exchangeDate ?? null, input.rsvpDeadline ?? null, input.location ?? null, input.allowWishlists ? 1 : 0, u.id],
        );
        const eventId = ev.insertId;
        const ids: number[] = [];
        for (const p of people) {
          const r = await tx.exec(
            "INSERT INTO participants (public_id, tenant_id, event_id, user_id, name, email, status, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [newPublicId(), tenantId, eventId, p.isMe ? u.id : null, p.name, p.email, p.isMe ? "joined" : "invited", p.isMe ? new Date().toISOString().slice(0, 19).replace("T", " ") : null],
          );
          ids.push(r.insertId);
        }
        for (const x of excl) {
          await tx.exec("INSERT IGNORE INTO exclusions (tenant_id, event_id, giver_participant_id, receiver_participant_id, bidirectional) VALUES (?, ?, ?, ?, ?)", [
            tenantId,
            eventId,
            ids[x.a],
            ids[x.b],
            x.bidirectional ? 1 : 0,
          ]);
        }
        return { tenantId, eventId, publicId, ids, payNow };
      });

      if (input.organizerName && input.organizerName !== u.full_name) {
        await db.exec("UPDATE users SET full_name = ? WHERE id = ?", [input.organizerName, u.id]).catch(() => undefined);
      }
      await db.exec("UPDATE user_sessions SET active_tenant_id = ? WHERE id = ?", [result.tenantId, u.session_id]);

      let invited = 0;
      if (input.sendInvites && !result.payNow) {
        await inBatches(people.map((_, i) => i), 8, async (i) => {
          if (people[i].isMe) return;
          const ok = await sendInvite(req, db, {
            tenantId: result.tenantId,
            participantId: result.ids[i],
            email: people[i].email,
            organizer: input.organizerName,
            event: { name: input.name, exchange_date: input.exchangeDate ?? null, budget_min: input.budgetMin ?? null, budget_max: input.budgetMax ?? null, currency: input.currency },
            typeName: reqLang(req) === "es" ? type.name_es : type.name_en,
          });
          if (ok) invited++;
        });
      }
      await audit(req, "event.create", "event", result.eventId, { tenantId: result.tenantId, actorId: u.id, meta: { via: "wizard", participants: people.length, type: type.slug } });
      res.status(201).json({ ok: true, tenant_id: result.tenantId, event_id: result.eventId, event_public_id: result.publicId, invited, payment_required: result.payNow });
    }),
  );
}

function registerJoinRoutes(app: express.Express) {
  const findInvite = async (token: string) => {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw new HttpError(404, "errors.inviteInvalid");
    const rows = await db.query(
      `SELECT p.id, p.tenant_id, p.event_id, p.name, p.email, p.status, e.name AS event_name, e.status AS event_status, e.exchange_date,
              e.budget_min, e.budget_max, e.currency, e.public_id AS event_public_id, et.name_en, et.name_es, t.name AS tenant_name, t.status AS tenant_status
         FROM participants p JOIN events e ON e.id = p.event_id JOIN event_types et ON et.id = e.event_type_id JOIN tenants t ON t.id = p.tenant_id
        WHERE p.invite_token_hash = ? LIMIT 1`,
      [sha256(token)],
    );
    const r = rows[0];
    if (!r || r.status === "removed" || r.event_status === "cancelled" || r.tenant_status !== "active") throw new HttpError(404, "errors.inviteInvalid");
    return r;
  };

  app.get(
    "/api/join/:token",
    route(async (req, res) => {
      const r = await findInvite(String(req.params.token));
      res.json({
        ok: true,
        invite: {
          name: r.name,
          email_hint: r.email.replace(/^(.).*(@.*)$/, "$1•••$2"),
          event_name: r.event_name,
          event_status: r.event_status,
          type_name: reqLang(req) === "es" ? r.name_es : r.name_en,
          exchange_date: r.exchange_date,
          budget: budgetLabel(toNum(r.budget_min), toNum(r.budget_max), r.currency),
          tenant_name: r.tenant_name,
          status: r.status,
        },
      });
    }),
  );

  app.post(
    "/api/join/:token/respond",
    requireAuth(),
    route(async (req, res) => {
      const r = await findInvite(String(req.params.token));
      const u = authed(res);
      if (r.email !== u.email) throw new HttpError(403, "errors.inviteWrongAccount", { expected: r.email.replace(/^(.).*(@.*)$/, "$1•••$2") });
      const accept = req.body?.accept !== false;
      if (r.event_status === "completed" || r.event_status === "pending_payment") throw new HttpError(409, "errors.eventClosed");
      // After the draw the matches are fixed: no leaving, and decliners can't come back without a match.
      if (r.event_status === "drawn" && (!accept || r.status !== "joined" && r.status !== "invited")) throw new HttpError(409, "errors.alreadyDrawn");
      await db.tx(async (tx) => {
        await tx.exec(
          `UPDATE participants SET user_id = ?, status = ?, joined_at = IF(? = 'joined', COALESCE(joined_at, UTC_TIMESTAMP()), joined_at) WHERE id = ?`,
          [u.id, accept ? "joined" : "declined", accept ? "joined" : "declined", r.id],
        );
        if (accept) {
          await tx.exec("INSERT IGNORE INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, 'participant')", [r.tenant_id, u.id]);
          // A removed member re-joining through an invite comes back as a participant only (never their old role).
          await tx.exec("UPDATE tenant_members SET status = 'active', role = 'participant' WHERE tenant_id = ? AND user_id = ? AND status = 'removed'", [r.tenant_id, u.id]);
        }
      });
      if (accept) await db.exec("UPDATE user_sessions SET active_tenant_id = ? WHERE id = ?", [r.tenant_id, u.session_id]);
      await audit(req, accept ? "participant.join" : "participant.decline", "participant", r.id, { tenantId: Number(r.tenant_id), actorId: u.id });
      res.json({ ok: true, status: accept ? "joined" : "declined", tenant_id: Number(r.tenant_id), event_public_id: r.event_public_id });
    }),
  );
}

const EVENT_GRID: GridSpec = {
  sortMap: { id: "e.id", name: "e.name", exchange_date: "e.exchange_date", status: "e.status", created_at: "e.created_at" },
  defaultSort: "created_at",
  filters: { status: { column: "e.status", values: ["draft", "open", "drawn", "completed", "cancelled"] }, type: { column: "et.slug", values: [] } },
  search: ["e.name", "e.location"],
};

const PARTICIPANT_GRID: GridSpec = {
  sortMap: { id: "p.id", name: "p.name", email: "p.email", status: "p.status", joined_at: "p.joined_at", created_at: "p.created_at" },
  defaultSort: "name",
  defaultDir: "ASC",
  filters: { status: { column: "p.status", values: ["invited", "joined", "declined", "removed"] } },
  search: ["p.name", "p.email"],
};

const eventPatchSchema = z.object({
  name: z.string().trim().min(2).max(140).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  exchange_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  rsvp_deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  budget_min: z.number().min(0).nullable().optional(),
  budget_max: z.number().min(0).nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  location: z.string().trim().max(200).nullable().optional(),
  allow_wishlists: z.boolean().optional(),
  status: z.enum(["draft", "open", "completed", "cancelled"]).optional(),
});

function registerTenantRoutes(app: express.Express) {
  app.get(
    "/api/app/dashboard",
    requireTenant("events.view_own"),
    route(async (_req, res) => {
      const { tenant_id, role } = tenantCtx(res);
      const isOrganizer = role === "organizer";
      const meId = authed(res).id;
      const [tenantRows, kpiRows, upcoming] = await Promise.all([
        db.query("SELECT id, name, slug, plan, max_events, max_participants_per_event FROM tenants WHERE id = ?", [tenant_id]),
        db.query(
          `SELECT COUNT(*) AS events, SUM(e.status = 'open') AS open, SUM(e.status = 'drawn') AS drawn,
                  (SELECT COUNT(*) FROM participants p WHERE p.tenant_id = ? AND p.status IN ('invited','joined')) AS participants,
                  (SELECT COUNT(*) FROM participants p WHERE p.tenant_id = ? AND p.status = 'joined') AS joined
             FROM events e WHERE e.tenant_id = ? AND e.status <> 'cancelled'`,
          [tenant_id, tenant_id, tenant_id],
        ),
        isOrganizer
          ? db.query(
              `SELECT ${EVENT_SELECT} FROM events e JOIN event_types et ON et.id = e.event_type_id
                WHERE e.tenant_id = ? AND e.status IN ('pending_payment','open','drawn') ORDER BY e.exchange_date IS NULL, e.exchange_date ASC LIMIT 5`,
              [tenant_id],
            )
          : db.query(
              `SELECT ${EVENT_SELECT} FROM events e JOIN event_types et ON et.id = e.event_type_id JOIN participants me ON me.event_id = e.id AND me.user_id = ? AND me.status = 'joined'
                WHERE e.tenant_id = ? AND e.status IN ('open','drawn') ORDER BY e.exchange_date IS NULL, e.exchange_date ASC LIMIT 5`,
              [meId, tenant_id],
            ),
      ]);
      const t = tenantRows[0];
      const k = isOrganizer ? kpiRows[0] ?? {} : {}; // participants never see tenant-wide numbers
      const out: TenantDashboard = {
        tenant: { id: Number(t.id), name: t.name, slug: t.slug, plan: t.plan, max_events: Number(t.max_events), max_participants_per_event: Number(t.max_participants_per_event) },
        kpis: { events: Number(k.events ?? 0), open: Number(k.open ?? 0), drawn: Number(k.drawn ?? 0), participants: Number(k.participants ?? 0), joined: Number(k.joined ?? 0) },
        upcoming: upcoming.map(mapEvent),
      };
      res.json({ ok: true, ...out });
    }),
  );

  app.get(
    "/api/app/events",
    requireTenant("events.manage"),
    route(async (req, res) => {
      const { tenant_id } = tenantCtx(res);
      const typeSlugs = (await db.query("SELECT slug FROM event_types")).map((r) => r.slug);
      const spec = { ...EVENT_GRID, filters: { ...EVENT_GRID.filters, type: { column: "et.slug", values: typeSlugs } } };
      const g = parseGridQuery(req.query as any, spec, ["e.tenant_id = ?"], [tenant_id]);
      res.json(await runGrid(g, EVENT_SELECT, "events e JOIN event_types et ON et.id = e.event_type_id", mapEvent));
    }),
  );

  app.get(
    "/api/app/events/:id",
    requireTenant("events.manage"),
    route(async (req, res) => {
      const { tenant_id } = tenantCtx(res);
      const { event, row, maxParticipants, pricing } = await loadTenantEvent(tenant_id, parseId(req.params.id));
      const excl = await db.query(
        `SELECT x.id, x.giver_participant_id, x.receiver_participant_id, x.bidirectional, g.name AS giver_name, r.name AS receiver_name
           FROM exclusions x JOIN participants g ON g.id = x.giver_participant_id JOIN participants r ON r.id = x.receiver_participant_id
          WHERE x.event_id = ? AND x.tenant_id = ? ORDER BY x.id`,
        [event.id, tenant_id],
      );
      const viewed = await db.query("SELECT COUNT(*) AS total, SUM(viewed_at IS NOT NULL) AS viewed FROM assignments WHERE event_id = ? AND tenant_id = ?", [event.id, tenant_id]);
      const exclusions: ExclusionRow[] = excl.map((x) => ({
        id: Number(x.id),
        giver_participant_id: Number(x.giver_participant_id),
        receiver_participant_id: Number(x.receiver_participant_id),
        giver_name: x.giver_name,
        receiver_name: x.receiver_name,
        bidirectional: toBool(x.bidirectional),
      }));
      res.json({
        ok: true,
        event,
        uses_draw: toBool(row.uses_draw),
        max_participants: maxParticipants,
        pricing,
        tenant_plan: row.tenant_plan,
        exclusions,
        assignments: { total: Number(viewed[0]?.total ?? 0), viewed: Number(viewed[0]?.viewed ?? 0) },
      });
    }),
  );

  app.patch(
    "/api/app/events/:id",
    requireTenant("events.manage"),
    route(async (req, res) => {
      const { tenant_id } = tenantCtx(res);
      const id = parseId(req.params.id);
      const body = eventPatchSchema.parse(req.body ?? {});
      const { event, row } = await loadTenantEvent(tenant_id, id);
      if (body.status && body.status !== event.status && !canTransition(event.status, body.status, toBool(row.uses_draw))) {
        throw new HttpError(event.status === "pending_payment" ? 402 : 409, event.status === "pending_payment" ? "errors.paymentRequired" : "errors.invalidTransition");
      }
      const min = body.budget_min !== undefined ? body.budget_min : event.budget_min;
      const max = body.budget_max !== undefined ? body.budget_max : event.budget_max;
      if (min != null && max != null && min > max) throw new HttpError(400, "validation.budgetRange");
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const [k, v] of Object.entries(body)) {
        sets.push(`${k} = ?`);
        params.push(typeof v === "boolean" ? (v ? 1 : 0) : v);
      }
      if (!sets.length) return void res.json({ ok: true, event });
      await db.exec(`UPDATE events SET ${sets.join(", ")} WHERE id = ? AND tenant_id = ?`, [...params, id, tenant_id]);
      await audit(req, "event.update", "event", id, { tenantId: tenant_id, actorId: authed(res).id, meta: { fields: Object.keys(body) } });
      res.json({ ok: true, event: (await loadTenantEvent(tenant_id, id)).event });
    }),
  );

  app.get(
    "/api/app/events/:id/participants",
    requireTenant("participants.manage"),
    route(async (req, res) => {
      const { tenant_id } = tenantCtx(res);
      const eventId = parseId(req.params.id);
      const g = parseGridQuery(req.query as any, PARTICIPANT_GRID, ["p.tenant_id = ?", "p.event_id = ?"], [tenant_id, eventId]);
      res.json(await runGrid(g, "p.*", "participants p", mapParticipant));
    }),
  );

  app.post(
    "/api/app/events/:id/participants",
    writeLimiter,
    requireTenant("participants.manage"),
    route(async (req, res) => {
      const { tenant_id } = tenantCtx(res);
      const u = authed(res);
      const eventId = parseId(req.params.id);
      const body = z.object({ participants: z.array(z.object({ name: z.string().trim().min(1).max(120), email: emailSchema })).min(1).max(200), send_invites: z.boolean().default(true) }).parse(req.body ?? {});
      const { event, row, maxParticipants, pricing } = await loadTenantEvent(tenant_id, eventId);
      if (event.status === "drawn") throw new HttpError(409, "errors.alreadyDrawn");
      if (event.status === "cancelled" || event.status === "completed") throw new HttpError(409, "errors.eventClosed");
      // Dedupe the request, then count only people who aren't already active in this exchange.
      const uniq = [...new Map(body.participants.map((p) => [p.email, p])).values()];
      const active = new Set(
        (await db.query("SELECT email FROM participants WHERE event_id = ? AND tenant_id = ? AND status IN ('invited','joined')", [eventId, tenant_id])).map((r) => String(r.email)),
      );
      const incoming = uniq.filter((p) => !active.has(p.email));
      const total = event.participant_count + incoming.length;
      if (total > maxParticipants) {
        const canUpgrade = event.plan === "free" && row.tenant_plan !== "enterprise" && total <= pricing.pro_max_participants;
        throw new HttpError(402, canUpgrade ? "errors.needsPro" : "errors.participantLimit", { max: maxParticipants, free_max: pricing.free_max_participants, pro_max: pricing.pro_max_participants });
      }
      let added = 0;
      let invited = 0;
      const toInvite: Array<{ id: number; email: string }> = [];
      for (const p of incoming) {
        // New email → insert; previously removed/declined → back to invited (unique event+email).
        await db.exec(
          `INSERT INTO participants (public_id, tenant_id, event_id, name, email) VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE name = VALUES(name), status = IF(status IN ('removed','declined'), 'invited', status), joined_at = IF(status = 'invited', NULL, joined_at)`,
          [newPublicId(), tenant_id, eventId, p.name, p.email],
        );
        const row2 = (await db.query("SELECT id FROM participants WHERE event_id = ? AND tenant_id = ? AND email = ? LIMIT 1", [eventId, tenant_id, p.email]))[0];
        if (!row2) continue;
        added++;
        toInvite.push({ id: Number(row2.id), email: p.email });
      }
      if (body.send_invites) {
        await inBatches(toInvite, 8, async (p) => {
          if (await sendInvite(req, db, { tenantId: tenant_id, participantId: p.id, email: p.email, organizer: u.full_name, event, typeName: event.event_type_name })) invited++;
        });
      }
      await audit(req, "participant.add", "event", eventId, { tenantId: tenant_id, actorId: u.id, meta: { added } });
      res.status(201).json({ ok: true, added, invited, skipped: body.participants.length - added });
    }),
  );

  app.patch(
    "/api/app/events/:id/participants/:pid",
    requireTenant("participants.manage"),
    route(async (req, res) => {
      const { tenant_id } = tenantCtx(res);
      const eventId = parseId(req.params.id);
      const pid = parseId(req.params.pid);
      // Organizers can remove or re-invite; "joined" only happens when the person accepts.
      const body = z.object({ name: z.string().trim().min(1).max(120).optional(), status: z.enum(["invited", "removed"]).optional() }).parse(req.body ?? {});
      const { event } = await loadTenantEvent(tenant_id, eventId);
      if (body.status && event.status === "drawn") throw new HttpError(409, "errors.alreadyDrawn");
      if (body.status && (event.status === "cancelled" || event.status === "completed")) throw new HttpError(409, "errors.eventClosed");
      const sets: string[] = [];
      const params: unknown[] = [];
      if (body.name) (sets.push("name = ?"), params.push(body.name));
      if (body.status) (sets.push("status = ?"), params.push(body.status));
      if (!sets.length) return void res.json({ ok: true });
      const r = await db.exec(`UPDATE participants SET ${sets.join(", ")} WHERE id = ? AND event_id = ? AND tenant_id = ?`, [...params, pid, eventId, tenant_id]);
      if (!r.affectedRows) throw new HttpError(404, "errors.notFound");
      await audit(req, "participant.update", "participant", pid, { tenantId: tenant_id, actorId: authed(res).id, meta: body });
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/app/events/:id/participants/:pid/resend",
    writeLimiter,
    requireTenant("participants.manage"),
    route(async (req, res) => {
      const { tenant_id } = tenantCtx(res);
      const eventId = parseId(req.params.id);
      const pid = parseId(req.params.pid);
      const { event } = await loadTenantEvent(tenant_id, eventId);
      const rows = await db.query("SELECT id, email, status FROM participants WHERE id = ? AND event_id = ? AND tenant_id = ?", [pid, eventId, tenant_id]);
      if (!rows[0]) throw new HttpError(404, "errors.notFound");
      if (rows[0].status === "removed") throw new HttpError(409, "errors.participantRemoved");
      const ok = await sendInvite(req, db, { tenantId: tenant_id, participantId: pid, email: rows[0].email, organizer: authed(res).full_name, event, typeName: event.event_type_name });
      if (!ok) throw new HttpError(502, "errors.emailFailed");
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/app/events/:id/exclusions",
    requireTenant("participants.manage"),
    route(async (req, res) => {
      const { tenant_id } = tenantCtx(res);
      const eventId = parseId(req.params.id);
      const body = z.object({ giver_participant_id: z.number().int().positive(), receiver_participant_id: z.number().int().positive(), bidirectional: z.boolean().default(true) }).parse(req.body ?? {});
      if (body.giver_participant_id === body.receiver_participant_id) throw new HttpError(400, "validation.exclusion");
      const { event } = await loadTenantEvent(tenant_id, eventId);
      if (event.status === "drawn") throw new HttpError(409, "errors.alreadyDrawn");
      if (event.status === "cancelled" || event.status === "completed") throw new HttpError(409, "errors.eventClosed");
      const own = await db.query("SELECT COUNT(*) AS c FROM participants WHERE id IN (?, ?) AND event_id = ? AND tenant_id = ? AND status IN ('invited','joined')", [body.giver_participant_id, body.receiver_participant_id, eventId, tenant_id]);
      if (Number(own[0]?.c) !== 2) throw new HttpError(400, "validation.exclusion");
      const r = await db.exec("INSERT INTO exclusions (tenant_id, event_id, giver_participant_id, receiver_participant_id, bidirectional) VALUES (?, ?, ?, ?, ?)", [
        tenant_id,
        eventId,
        body.giver_participant_id,
        body.receiver_participant_id,
        body.bidirectional ? 1 : 0,
      ]);
      res.status(201).json({ ok: true, id: r.insertId });
    }),
  );

  app.delete(
    "/api/app/events/:id/exclusions/:xid",
    requireTenant("participants.manage"),
    route(async (req, res) => {
      const { tenant_id } = tenantCtx(res);
      const r = await db.exec("DELETE FROM exclusions WHERE id = ? AND event_id = ? AND tenant_id = ?", [parseId(req.params.xid), parseId(req.params.id), tenant_id]);
      if (!r.affectedRows) throw new HttpError(404, "errors.notFound");
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/app/events/:id/draw",
    writeLimiter,
    requireTenant("draw.run"),
    route(async (req, res) => {
      const { tenant_id } = tenantCtx(res);
      const eventId = parseId(req.params.id);
      const { event, row } = await loadTenantEvent(tenant_id, eventId);
      if (!toBool(row.uses_draw)) throw new HttpError(400, "errors.drawNotSupported");
      if (event.status === "drawn") throw new HttpError(409, "errors.alreadyDrawn");
      if (event.status !== "open") throw new HttpError(409, "errors.eventClosed");
      const includeInvited = req.body?.include_invited !== false;
      // Lock first (open → drawn), then read people + rules inside the same transaction: nothing can change in between.
      const { people, result } = await db.tx(async (tx) => {
        const locked = await tx.exec("UPDATE events SET status = 'drawn', drawn_at = UTC_TIMESTAMP() WHERE id = ? AND tenant_id = ? AND status = 'open'", [eventId, tenant_id]);
        if (locked.affectedRows !== 1) throw new HttpError(409, "errors.alreadyDrawn");
        const people = await tx.query(
          `SELECT id, email, user_id FROM participants WHERE event_id = ? AND tenant_id = ? AND status IN (${includeInvited ? "'invited','joined'" : "'joined'"})`,
          [eventId, tenant_id],
        );
        if (people.length < 3) throw new HttpError(400, "validation.minParticipants", { min: 3 });
        const excl = await tx.query("SELECT giver_participant_id, receiver_participant_id, bidirectional FROM exclusions WHERE event_id = ? AND tenant_id = ?", [eventId, tenant_id]);
        const result = drawAssignments(
          people.map((p) => Number(p.id)),
          expandExclusions(excl.map((x) => ({ giver: Number(x.giver_participant_id), receiver: Number(x.receiver_participant_id), bidirectional: toBool(x.bidirectional) }))),
        );
        if (!result) throw new HttpError(400, "validation.drawImpossible");
        await tx.exec("DELETE FROM assignments WHERE event_id = ? AND tenant_id = ?", [eventId, tenant_id]);
        const values = [...result.entries()];
        await tx.exec(
          `INSERT INTO assignments (tenant_id, event_id, giver_participant_id, receiver_participant_id) VALUES ${values.map(() => "(?, ?, ?, ?)").join(", ")}`,
          values.flatMap(([g, r]) => [tenant_id, eventId, g, r]),
        );
        return { people, result };
      });
      const ids = people.map((p) => Number(p.id));
      const link = `${appUrl()}/app/my/${event.public_id}`;
      let notified = 0;
      const tpl = tplAssignment(reqLang(req), { eventName: event.name, link });
      await inBatches(people, 10, async (p) => {
        if ((await sendEmail({ to: p.email, ...tpl, template: "assignment", tenantId: tenant_id })).ok) notified++;
      });
      await audit(req, "event.draw", "event", eventId, { tenantId: tenant_id, actorId: authed(res).id, meta: { participants: ids.length } });
      res.json({ ok: true, assigned: result.size, notified });
    }),
  );

  app.post(
    "/api/app/events/:id/reset-draw",
    requireTenant("draw.run"),
    route(async (req, res) => {
      const { tenant_id } = tenantCtx(res);
      const eventId = parseId(req.params.id);
      const { event } = await loadTenantEvent(tenant_id, eventId);
      if (event.status !== "drawn") throw new HttpError(409, "errors.notDrawn");
      await db.tx(async (tx) => {
        await tx.exec("DELETE FROM assignments WHERE event_id = ? AND tenant_id = ?", [eventId, tenant_id]);
        await tx.exec("UPDATE events SET status = 'open', drawn_at = NULL WHERE id = ? AND tenant_id = ?", [eventId, tenant_id]);
      });
      await audit(req, "event.reset_draw", "event", eventId, { tenantId: tenant_id, actorId: authed(res).id });
      res.json({ ok: true });
    }),
  );


  // ── Pro checkout (Stripe PaymentIntent; card fields are Stripe Elements on the client) ──
  app.post(
    "/api/app/events/:id/checkout",
    writeLimiter,
    requireTenant("events.manage"),
    route(async (req, res) => {
      const { tenant_id } = tenantCtx(res);
      const u = authed(res);
      const eventId = parseId(req.params.id);
      const { event, row, pricing } = await loadTenantEvent(tenant_id, eventId);
      if (event.plan === "pro" || event.paid_at) throw new HttpError(409, "errors.alreadyPro");
      if (row.tenant_plan === "enterprise") throw new HttpError(409, "errors.alreadyPro");
      if (event.status === "cancelled" || event.status === "completed") throw new HttpError(409, "errors.eventClosed");
      const api = paymentsApi();
      // Reuse an open intent for this exchange so retries never double charge.
      const existing = await db.query("SELECT provider_payment_id FROM payments WHERE event_id = ? AND tenant_id = ? AND status = 'pending' AND amount_cents = ? ORDER BY id DESC LIMIT 1", [eventId, tenant_id, pricing.pro_price_cents]);
      let intentId: string | null = null;
      let clientSecret: string | null = null;
      if (existing[0]) {
        const prev = await api.retrieveIntent(String(existing[0].provider_payment_id));
        if (prev.status === "succeeded") {
          await finalizePayment(req, prev);
          throw new HttpError(409, "errors.alreadyPro");
        }
        if (["requires_payment_method", "requires_confirmation", "requires_action"].includes(prev.status) && prev.client_secret) {
          intentId = prev.id;
          clientSecret = prev.client_secret;
        }
      }
      if (!intentId) {
        const pi = await api.createIntent({
          amount: pricing.pro_price_cents,
          currency: pricing.pro_currency,
          metadata: { tenant_id: String(tenant_id), event_id: String(eventId), user_id: String(u.id) },
          description: `QuickSanta Pro · ${event.name}`.slice(0, 200),
          email: u.email,
          idempotencyKey: `qs-pro-${eventId}-${crypto.randomBytes(8).toString("hex")}`,
        });
        intentId = pi.id;
        clientSecret = pi.client_secret;
        await db.exec("INSERT INTO payments (tenant_id, event_id, user_id, provider_payment_id, amount_cents, currency) VALUES (?, ?, ?, ?, ?, ?)", [tenant_id, eventId, u.id, pi.id, pricing.pro_price_cents, pricing.pro_currency.toUpperCase()]);
      }
      res.json({ ok: true, client_secret: clientSecret, payment_intent_id: intentId, amount_cents: pricing.pro_price_cents, currency: pricing.pro_currency });
    }),
  );

  app.post(
    "/api/app/events/:id/checkout/confirm",
    requireTenant("events.manage"),
    route(async (req, res) => {
      const { tenant_id } = tenantCtx(res);
      const eventId = parseId(req.params.id);
      const intentId = z.string().regex(/^pi_[A-Za-z0-9_]{6,}$/).parse(req.body?.payment_intent_id);
      const own = await db.query("SELECT id FROM payments WHERE provider_payment_id = ? AND event_id = ? AND tenant_id = ?", [intentId, eventId, tenant_id]);
      if (!own[0]) throw new HttpError(404, "errors.notFound");
      const intent = await paymentsApi().retrieveIntent(intentId);
      if (Number(intent.metadata?.event_id) !== eventId || Number(intent.metadata?.tenant_id) !== tenant_id) throw new HttpError(400, "errors.paymentMismatch");
      if (intent.status !== "succeeded") throw new HttpError(402, "errors.paymentNotCompleted", { status: intent.status });
      await finalizePayment(req, intent);
      const { event } = await loadTenantEvent(tenant_id, eventId);
      res.json({ ok: true, event });
    }),
  );

  // ── Participant views (any member) ──
  app.get(
    "/api/app/my/events",
    requireAuth(),
    route(async (_req, res) => {
      const u = authed(res);
      const rows = await db.query(
        `SELECT ${EVENT_SELECT}, t.name AS tenant_name FROM participants me
           JOIN events e ON e.id = me.event_id JOIN event_types et ON et.id = e.event_type_id JOIN tenants t ON t.id = e.tenant_id
          WHERE me.user_id = ? AND me.status = 'joined' AND e.status <> 'cancelled' AND t.status = 'active'
          ORDER BY e.exchange_date IS NULL, e.exchange_date ASC, e.id DESC LIMIT 100`,
        [u.id],
      );
      res.json({ ok: true, items: rows.map((r) => ({ ...mapEvent(r), tenant_name: r.tenant_name })) });
    }),
  );

  app.get(
    "/api/app/my/events/:publicId",
    requireAuth(),
    route(async (req, res) => {
      const u = authed(res);
      const rows = await db.query(
        `SELECT ${EVENT_SELECT}, me.id AS me_id, me.name AS me_name, me.wishlist AS me_wishlist, me.status AS me_status
           FROM participants me JOIN events e ON e.id = me.event_id JOIN event_types et ON et.id = e.event_type_id JOIN tenants t ON t.id = e.tenant_id
          WHERE e.public_id = ? AND me.user_id = ? AND me.status = 'joined' AND t.status = 'active' AND e.status NOT IN ('cancelled','pending_payment') LIMIT 1`,
        [String(req.params.publicId).slice(0, 26), u.id],
      );
      const r = rows[0];
      if (!r) throw new HttpError(404, "errors.notFound");
      let receiver: MyAssignment["receiver"] = null;
      if (r.status === "drawn" || r.status === "completed") {
        const a = await db.query(
          `SELECT a.id, rp.name, rp.wishlist FROM assignments a JOIN participants rp ON rp.id = a.receiver_participant_id
            WHERE a.event_id = ? AND a.giver_participant_id = ? LIMIT 1`,
          [r.id, r.me_id],
        );
        if (a[0]) {
          receiver = { name: a[0].name, wishlist: toBool(r.allow_wishlists) ? a[0].wishlist ?? null : null };
          await db.exec("UPDATE assignments SET viewed_at = COALESCE(viewed_at, UTC_TIMESTAMP()) WHERE id = ?", [a[0].id]);
        }
      }
      const out: MyAssignment = { event: mapEvent(r), me: { participant_id: Number(r.me_id), name: r.me_name, wishlist: r.me_wishlist ?? null, status: r.me_status }, receiver };
      res.json({ ok: true, ...out });
    }),
  );

  app.put(
    "/api/app/my/events/:publicId/wishlist",
    requireAuth(),
    route(async (req, res) => {
      const u = authed(res);
      const wishlist = z.string().max(4000).parse(String(req.body?.wishlist ?? ""));
      const r = await db.exec(
        `UPDATE participants me JOIN events e ON e.id = me.event_id SET me.wishlist = ?
          WHERE e.public_id = ? AND me.user_id = ? AND me.status = 'joined' AND e.allow_wishlists = 1 AND e.status IN ('open','drawn')`,
        [wishlist.trim() || null, String(req.params.publicId).slice(0, 26), u.id],
      );
      if (!r.affectedRows) throw new HttpError(404, "errors.notFound");
      res.json({ ok: true });
    }),
  );

  // ── Tenant members (organizer) ──
  app.get(
    "/api/app/members",
    requireTenant("members.manage"),
    route(async (req, res) => {
      const { tenant_id } = tenantCtx(res);
      const g = parseGridQuery(
        req.query as any,
        {
          sortMap: { id: "m.id", name: "u.full_name", email: "u.email", role: "m.role", created_at: "m.created_at" },
          defaultSort: "name",
          defaultDir: "ASC",
          filters: { role: { column: "m.role", values: ["organizer", "participant"] } },
          search: ["u.full_name", "u.email"],
        },
        ["m.tenant_id = ?", "m.status = 'active'"],
        [tenant_id],
      );
      res.json(
        await runGrid(g, "m.id, m.user_id, m.role, m.created_at, u.full_name, u.email, u.last_login_at", "tenant_members m JOIN users u ON u.id = m.user_id", (r) => ({
          id: Number(r.id),
          user_id: Number(r.user_id),
          full_name: r.full_name,
          email: r.email,
          role: r.role,
          last_login_at: r.last_login_at,
          created_at: r.created_at,
        })),
      );
    }),
  );

  app.patch(
    "/api/app/members/:id",
    requireTenant("members.manage"),
    route(async (req, res) => {
      const { tenant_id } = tenantCtx(res);
      const u = authed(res);
      const id = parseId(req.params.id);
      const body = z.object({ role: z.enum(["organizer", "participant"]).optional(), remove: z.boolean().optional() }).parse(req.body ?? {});
      const rows = await db.query("SELECT user_id, role FROM tenant_members WHERE id = ? AND tenant_id = ? AND status = 'active'", [id, tenant_id]);
      if (!rows[0]) throw new HttpError(404, "errors.notFound");
      if (Number(rows[0].user_id) === u.id) throw new HttpError(400, "errors.cannotChangeSelf");
      if (rows[0].role === "organizer" && (body.remove || body.role === "participant")) {
        const orgs = await db.query("SELECT COUNT(*) AS c FROM tenant_members WHERE tenant_id = ? AND role = 'organizer' AND status = 'active'", [tenant_id]);
        if (Number(orgs[0]?.c) <= 1) throw new HttpError(400, "errors.lastOrganizer");
      }
      if (body.remove) await db.exec("UPDATE tenant_members SET status = 'removed' WHERE id = ? AND tenant_id = ?", [id, tenant_id]);
      else if (body.role) await db.exec("UPDATE tenant_members SET role = ? WHERE id = ? AND tenant_id = ?", [body.role, id, tenant_id]);
      await audit(req, "member.update", "member", id, { tenantId: tenant_id, actorId: u.id, meta: body });
      res.json({ ok: true });
    }),
  );

  app.patch(
    "/api/app/tenant",
    requireTenant("members.manage"),
    route(async (req, res) => {
      const { tenant_id } = tenantCtx(res);
      const body = z.object({ name: z.string().trim().min(2).max(120).optional(), locale: z.enum(["en", "es"]).optional() }).parse(req.body ?? {});
      if (body.name) await db.exec("UPDATE tenants SET name = ? WHERE id = ?", [body.name, tenant_id]);
      if (body.locale) await db.exec("UPDATE tenants SET locale = ? WHERE id = ?", [body.locale, tenant_id]);
      await audit(req, "tenant.update", "tenant", tenant_id, { tenantId: tenant_id, actorId: authed(res).id, meta: body });
      res.json({ ok: true });
    }),
  );
}

// ── Command Center (platform owner/admin) ──
const TENANT_GRID: GridSpec = {
  sortMap: { id: "t.id", name: "t.name", status: "t.status", plan: "t.plan", created_at: "t.created_at", event_count: "event_count", member_count: "member_count" },
  defaultSort: "created_at",
  filters: { status: { column: "t.status", values: ["active", "suspended", "archived"] }, plan: { column: "t.plan", values: ["free", "pro", "enterprise"] } },
  search: ["t.name", "t.slug", "u.email"],
};
const TENANT_SELECT = `t.id, t.public_id, t.name, t.slug, t.status, t.plan, t.max_events, t.max_participants_per_event, t.created_at, u.email AS owner_email,
  (SELECT COUNT(*) FROM tenant_members m WHERE m.tenant_id = t.id AND m.status = 'active') AS member_count,
  (SELECT COUNT(*) FROM events e WHERE e.tenant_id = t.id) AS event_count`;
function mapTenant(r: any): AdminTenantRow {
  return {
    id: Number(r.id),
    public_id: r.public_id,
    name: r.name,
    slug: r.slug,
    status: r.status,
    plan: r.plan,
    max_events: Number(r.max_events),
    max_participants_per_event: Number(r.max_participants_per_event),
    owner_email: r.owner_email ?? null,
    member_count: Number(r.member_count ?? 0),
    event_count: Number(r.event_count ?? 0),
    created_at: r.created_at,
  };
}
const USER_GRID: GridSpec = {
  sortMap: { id: "u.id", full_name: "u.full_name", email: "u.email", platform_role: "u.platform_role", status: "u.status", last_login_at: "u.last_login_at", created_at: "u.created_at" },
  defaultSort: "created_at",
  filters: { status: { column: "u.status", values: ["active", "suspended"] }, platform_role: { column: "u.platform_role", values: ["owner", "admin"] } },
  search: ["u.full_name", "u.email"],
};
function mapUser(r: any): AdminUserRow {
  return {
    id: Number(r.id),
    public_id: r.public_id,
    email: r.email,
    full_name: r.full_name,
    platform_role: r.platform_role ?? null,
    status: r.status,
    tenant_count: Number(r.tenant_count ?? 0),
    last_login_at: r.last_login_at ?? null,
    created_at: r.created_at,
  };
}
function mapAudit(r: any): AuditRow {
  let meta = r.meta;
  if (typeof meta === "string") {
    try {
      meta = JSON.parse(meta);
    } catch {
      meta = null;
    }
  }
  return { id: Number(r.id), tenant_id: r.tenant_id ? Number(r.tenant_id) : null, tenant_name: r.tenant_name ?? null, actor_email: r.actor_email ?? null, action: r.action, entity: r.entity, entity_id: r.entity_id ?? null, meta: meta ?? null, created_at: r.created_at };
}

function registerAdminRoutes(app: express.Express) {
  app.get(
    "/api/admin/overview",
    requirePlatform("overview"),
    route(async (_req, res) => {
      const [k, signups, byType, recent, auditRows] = await Promise.all([
        db.query(
          `SELECT (SELECT COUNT(*) FROM tenants) AS tenants, (SELECT COUNT(*) FROM tenants WHERE status = 'active') AS active_tenants,
                  (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM events) AS events,
                  (SELECT COUNT(*) FROM events WHERE status = 'open') AS open_events, (SELECT COUNT(*) FROM events WHERE status = 'drawn') AS drawn_events,
                  (SELECT COUNT(*) FROM participants WHERE status IN ('invited','joined')) AS participants,
                  (SELECT COUNT(*) FROM email_log WHERE created_at > UTC_TIMESTAMP() - INTERVAL 7 DAY) AS emails_7d,
                  (SELECT COUNT(*) FROM email_log WHERE status = 'failed' AND created_at > UTC_TIMESTAMP() - INTERVAL 7 DAY) AS email_failures_7d,
                  (SELECT COALESCE(SUM(amount_cents), 0) FROM payments WHERE status = 'succeeded') AS revenue_cents,
                  (SELECT COALESCE(SUM(amount_cents), 0) FROM payments WHERE status = 'succeeded' AND created_at > UTC_TIMESTAMP() - INTERVAL 30 DAY) AS revenue_30d_cents,
                  (SELECT COUNT(*) FROM events WHERE plan = 'pro') AS pro_events`,
        ),
        db.query(
          `SELECT d.day, COALESCE(t.c, 0) AS tenants, COALESCE(u.c, 0) AS users FROM
             (SELECT DATE(UTC_TIMESTAMP() - INTERVAL n DAY) AS day FROM (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9 UNION ALL SELECT 10 UNION ALL SELECT 11 UNION ALL SELECT 12 UNION ALL SELECT 13) nums) d
             LEFT JOIN (SELECT DATE(created_at) AS day, COUNT(*) c FROM tenants WHERE created_at > UTC_TIMESTAMP() - INTERVAL 14 DAY GROUP BY DATE(created_at)) t ON t.day = d.day
             LEFT JOIN (SELECT DATE(created_at) AS day, COUNT(*) c FROM users WHERE created_at > UTC_TIMESTAMP() - INTERVAL 14 DAY GROUP BY DATE(created_at)) u ON u.day = d.day
            ORDER BY d.day`,
        ),
        db.query("SELECT et.slug, et.name_en AS name, COUNT(e.id) AS count FROM event_types et LEFT JOIN events e ON e.event_type_id = et.id GROUP BY et.id, et.slug, et.name_en ORDER BY count DESC"),
        db.query(`SELECT ${TENANT_SELECT} FROM tenants t LEFT JOIN users u ON u.id = t.created_by ORDER BY t.created_at DESC LIMIT 6`),
        db.query(
          `SELECT a.*, t.name AS tenant_name, u.email AS actor_email FROM audit_log a LEFT JOIN tenants t ON t.id = a.tenant_id LEFT JOIN users u ON u.id = a.actor_user_id
            ORDER BY a.id DESC LIMIT 10`,
        ),
      ]);
      const kk = k[0] ?? {};
      const out: CommandCenterOverview = {
        kpis: Object.fromEntries(Object.entries(kk).map(([key, v]) => [key, Number(v ?? 0)])) as CommandCenterOverview["kpis"],
        signups_by_day: signups.map((r) => ({ day: String(r.day).slice(0, 10), tenants: Number(r.tenants), users: Number(r.users) })),
        events_by_type: byType.map((r) => ({ slug: r.slug, name: r.name, count: Number(r.count) })),
        recent_tenants: recent.map(mapTenant),
        recent_audit: auditRows.map(mapAudit),
      };
      res.json({ ok: true, ...out });
    }),
  );

  app.get(
    "/api/admin/tenants",
    requirePlatform("tenants.read"),
    route(async (req, res) => {
      const g = parseGridQuery(req.query as any, TENANT_GRID);
      res.json(await runGrid(g, TENANT_SELECT, "tenants t LEFT JOIN users u ON u.id = t.created_by", mapTenant));
    }),
  );

  app.get(
    "/api/admin/tenants/:id",
    requirePlatform("tenants.read"),
    route(async (req, res) => {
      const id = parseId(req.params.id);
      const [t, members, events] = await Promise.all([
        db.query(`SELECT ${TENANT_SELECT} FROM tenants t LEFT JOIN users u ON u.id = t.created_by WHERE t.id = ?`, [id]),
        db.query(
          "SELECT m.id, m.role, m.status, m.created_at, u.id AS user_id, u.email, u.full_name FROM tenant_members m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = ? ORDER BY m.role, u.full_name LIMIT 200",
          [id],
        ),
        db.query(`SELECT ${EVENT_SELECT} FROM events e JOIN event_types et ON et.id = e.event_type_id WHERE e.tenant_id = ? ORDER BY e.created_at DESC LIMIT 50`, [id]),
      ]);
      if (!t[0]) throw new HttpError(404, "errors.notFound");
      res.json({ ok: true, tenant: mapTenant(t[0]), members: members.map((m) => ({ ...m, id: Number(m.id), user_id: Number(m.user_id) })), events: events.map(mapEvent) });
    }),
  );

  app.patch(
    "/api/admin/tenants/:id",
    requirePlatform("tenants.write"),
    route(async (req, res) => {
      const id = parseId(req.params.id);
      const body = z
        .object({
          name: z.string().trim().min(2).max(120).optional(),
          status: z.enum(["active", "suspended", "archived"]).optional(),
          plan: z.enum(["free", "pro", "enterprise"]).optional(),
          max_events: z.number().int().min(0).max(100000).optional(),
          max_participants_per_event: z.number().int().min(2).max(100000).optional(),
        })
        .parse(req.body ?? {});
      const keys = Object.keys(body);
      if (!keys.length) return void res.json({ ok: true });
      const r = await db.exec(`UPDATE tenants SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [...keys.map((k) => (body as any)[k]), id]);
      if (!r.affectedRows) throw new HttpError(404, "errors.notFound");
      await audit(req, "admin.tenant.update", "tenant", id, { tenantId: id, actorId: authed(res).id, meta: body });
      res.json({ ok: true });
    }),
  );

  app.get(
    "/api/admin/users",
    requirePlatform("users.read"),
    route(async (req, res) => {
      const g = parseGridQuery(req.query as any, USER_GRID);
      res.json(
        await runGrid(
          g,
          "u.id, u.public_id, u.email, u.full_name, u.platform_role, u.status, u.last_login_at, u.created_at, (SELECT COUNT(*) FROM tenant_members m WHERE m.user_id = u.id AND m.status = 'active') AS tenant_count",
          "users u",
          mapUser,
        ),
      );
    }),
  );

  app.patch(
    "/api/admin/users/:id",
    requirePlatform("users.write"),
    route(async (req, res) => {
      const me = authed(res);
      const id = parseId(req.params.id);
      const body = z.object({ status: z.enum(["active", "suspended"]).optional(), platform_role: z.enum(["owner", "admin"]).nullable().optional(), full_name: z.string().trim().min(1).max(120).optional() }).parse(req.body ?? {});
      if (id === me.id && (body.status || body.platform_role !== undefined)) throw new HttpError(400, "errors.cannotChangeSelf");
      const target = (await db.query("SELECT id, platform_role FROM users WHERE id = ?", [id]))[0];
      if (!target) throw new HttpError(404, "errors.notFound");
      if (body.platform_role !== undefined && !platformCan(me.platform_role, "users.roles")) throw new HttpError(403, "errors.forbidden");
      // Admins can't touch owners.
      if (target.platform_role === "owner" && me.platform_role !== "owner") throw new HttpError(403, "errors.forbidden");
      if (target.platform_role === "owner" && (body.platform_role !== undefined && body.platform_role !== "owner" || body.status === "suspended")) {
        const owners = await db.query("SELECT COUNT(*) AS c FROM users WHERE platform_role = 'owner' AND status = 'active'");
        if (Number(owners[0]?.c) <= 1) throw new HttpError(400, "errors.lastOwner");
      }
      const keys = Object.keys(body);
      if (keys.length) await db.exec(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [...keys.map((k) => (body as any)[k]), id]);
      if (body.status === "suspended") await db.exec("UPDATE user_sessions SET is_active = 0 WHERE user_id = ?", [id]);
      await audit(req, "admin.user.update", "user", id, { actorId: me.id, meta: body });
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/admin/users/invite",
    requirePlatform("users.roles"),
    route(async (req, res) => {
      const body = z.object({ email: emailSchema, full_name: z.string().trim().min(1).max(120), platform_role: z.enum(["owner", "admin"]) }).parse(req.body ?? {});
      await db.exec(
        "INSERT INTO users (public_id, email, full_name, platform_role) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE platform_role = IF(platform_role = 'owner', 'owner', VALUES(platform_role))",
        [newPublicId(), body.email, body.full_name, body.platform_role],
      );
      await audit(req, "admin.user.grant", "user", body.email, { actorId: authed(res).id, meta: { role: body.platform_role } });
      res.status(201).json({ ok: true });
    }),
  );

  app.get(
    "/api/admin/events",
    requirePlatform("events.read"),
    route(async (req, res) => {
      const typeSlugs = (await db.query("SELECT slug FROM event_types")).map((r) => r.slug);
      const spec: GridSpec = {
        ...EVENT_GRID,
        sortMap: { ...EVENT_GRID.sortMap, tenant: "t.name" },
        filters: { ...EVENT_GRID.filters, type: { column: "et.slug", values: typeSlugs } },
        search: ["e.name", "t.name"],
      };
      const g = parseGridQuery(req.query as any, spec);
      res.json(
        await runGrid(g, `${EVENT_SELECT}, t.name AS tenant_name`, "events e JOIN event_types et ON et.id = e.event_type_id JOIN tenants t ON t.id = e.tenant_id", (r): AdminEventRow => ({
          ...mapEvent(r),
          tenant_name: r.tenant_name,
        })),
      );
    }),
  );

  app.get(
    "/api/admin/payments",
    requirePlatform("payments.read"),
    route(async (req, res) => {
      const g = parseGridQuery(req.query as any, {
        sortMap: { id: "p.id", created_at: "p.created_at", amount: "p.amount_cents", status: "p.status", tenant: "t.name" },
        defaultSort: "id",
        filters: { status: { column: "p.status", values: ["pending", "succeeded", "failed", "refunded"] } },
        search: ["t.name", "e.name", "u.email", "p.provider_payment_id"],
      });
      res.json(
        await runGrid(
          g,
          "p.id, p.amount_cents, p.currency, p.status, p.card_brand, p.card_last4, p.provider_payment_id, p.created_at, t.name AS tenant_name, e.name AS event_name, u.email AS payer_email",
          "payments p JOIN tenants t ON t.id = p.tenant_id JOIN events e ON e.id = p.event_id LEFT JOIN users u ON u.id = p.user_id",
          (r): PaymentRow => ({
            id: Number(r.id),
            amount_cents: Number(r.amount_cents),
            currency: r.currency,
            status: r.status,
            card_brand: r.card_brand ?? null,
            card_last4: r.card_last4 ?? null,
            provider_payment_id: r.provider_payment_id,
            tenant_name: r.tenant_name,
            event_name: r.event_name,
            payer_email: r.payer_email ?? null,
            created_at: r.created_at,
          }),
        ),
      );
    }),
  );

  app.get(
    "/api/admin/event-types",
    requirePlatform("overview"),
    route(async (_req, res) => {
      const rows = await db.query("SELECT et.*, (SELECT COUNT(*) FROM events e WHERE e.event_type_id = et.id) AS usage_count FROM event_types et ORDER BY sort_order, id");
      res.json({ ok: true, items: rows.map((r) => ({ ...mapEventType(r), usage_count: Number(r.usage_count ?? 0) })) });
    }),
  );

  const eventTypeSchema = z.object({
    slug: z.string().regex(/^[a-z0-9_]{2,40}$/),
    name_en: z.string().trim().min(2).max(80),
    name_es: z.string().trim().min(2).max(80),
    description_en: z.string().trim().max(255).default(""),
    description_es: z.string().trim().max(255).default(""),
    icon: z.string().regex(/^[a-z-]{2,40}$/).default("gift"),
    uses_draw: z.boolean().default(true),
    is_active: z.boolean().default(true),
    sort_order: z.number().int().min(0).max(10000).default(100),
  });

  app.post(
    "/api/admin/event-types",
    requirePlatform("catalog.write"),
    route(async (req, res) => {
      const b = eventTypeSchema.parse(req.body ?? {});
      const r = await db.exec(
        "INSERT INTO event_types (slug, name_en, name_es, description_en, description_es, icon, uses_draw, is_active, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [b.slug, b.name_en, b.name_es, b.description_en, b.description_es, b.icon, b.uses_draw ? 1 : 0, b.is_active ? 1 : 0, b.sort_order],
      );
      await audit(req, "admin.catalog.create", "event_type", b.slug, { actorId: authed(res).id });
      res.status(201).json({ ok: true, id: r.insertId });
    }),
  );

  app.patch(
    "/api/admin/event-types/:id",
    requirePlatform("catalog.write"),
    route(async (req, res) => {
      const id = parseId(req.params.id);
      const b = eventTypeSchema.partial().omit({ slug: true }).parse(req.body ?? {});
      const keys = Object.keys(b);
      if (!keys.length) return void res.json({ ok: true });
      const r = await db.exec(`UPDATE event_types SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [
        ...keys.map((k) => {
          const v = (b as any)[k];
          return typeof v === "boolean" ? (v ? 1 : 0) : v;
        }),
        id,
      ]);
      if (!r.affectedRows) throw new HttpError(404, "errors.notFound");
      await audit(req, "admin.catalog.update", "event_type", id, { actorId: authed(res).id, meta: b });
      res.json({ ok: true });
    }),
  );

  app.get(
    "/api/admin/audit",
    requirePlatform("audit.read"),
    route(async (req, res) => {
      const g = parseGridQuery(req.query as any, {
        sortMap: { id: "a.id", created_at: "a.created_at", action: "a.action" },
        defaultSort: "id",
        filters: { entity: { column: "a.entity", values: ["user", "tenant", "event", "participant", "member", "event_type"] } },
        search: ["a.action", "u.email", "t.name", "a.entity_id"],
      });
      res.json(await runGrid(g, "a.*, t.name AS tenant_name, u.email AS actor_email", "audit_log a LEFT JOIN tenants t ON t.id = a.tenant_id LEFT JOIN users u ON u.id = a.actor_user_id", mapAudit));
    }),
  );

  app.get(
    "/api/admin/emails",
    requirePlatform("emails.read"),
    route(async (req, res) => {
      const g = parseGridQuery(req.query as any, {
        sortMap: { id: "l.id", created_at: "l.created_at", to_email: "l.to_email", template: "l.template", status: "l.status" },
        defaultSort: "id",
        filters: { status: { column: "l.status", values: ["sent", "failed", "dry_run"] }, template: { column: "l.template", values: ["otp", "invite", "assignment"] } },
        search: ["l.to_email", "t.name"],
      });
      res.json(
        await runGrid(g, "l.id, l.to_email, l.template, l.status, l.error, l.created_at, t.name AS tenant_name", "email_log l LEFT JOIN tenants t ON t.id = l.tenant_id", (r): EmailLogRow => ({
          id: Number(r.id),
          tenant_name: r.tenant_name ?? null,
          to_email: r.to_email,
          template: r.template,
          status: r.status,
          error: r.error ?? null,
          created_at: r.created_at,
        })),
      );
    }),
  );

  const EDITABLE_SETTINGS = ["session_days", "default_max_events", "default_max_participants", "signups_enabled", "free_max_participants", "pro_max_participants", "pro_price_cents"] as const;
  app.get(
    "/api/admin/settings",
    requirePlatform("overview"),
    route(async (_req, res) => {
      const rows = await db.query(`SELECT setting_key, setting_value, description, updated_at FROM system_settings WHERE setting_key IN (${EDITABLE_SETTINGS.map(() => "?").join(",")}, 'app_version')`, [...EDITABLE_SETTINGS]);
      res.json({ ok: true, items: rows });
    }),
  );

  app.put(
    "/api/admin/settings",
    requirePlatform("settings.write"),
    route(async (req, res) => {
      const body = z.record(z.enum(EDITABLE_SETTINGS), z.string().max(50)).parse(req.body ?? {});
      for (const [k, v] of Object.entries(body)) {
        await db.exec("INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)", [k, v]);
        settingsCache.delete(k);
      }
      await audit(req, "admin.settings.update", "settings", null, { actorId: authed(res).id, meta: body });
      res.json({ ok: true });
    }),
  );
}

function registerCronRoutes(app: express.Express) {
  app.get(
    "/api/cron/cleanup",
    route(async (req, res) => {
      const secret = process.env.CRON_SECRET;
      if ((secret || IS_PROD) && req.headers.authorization !== `Bearer ${secret}`) throw new HttpError(401, "errors.unauthorized");
      const otp = await db.exec("DELETE FROM otp_codes WHERE created_at < UTC_TIMESTAMP() - INTERVAL 2 DAY");
      const sess = await db.exec("DELETE FROM user_sessions WHERE expires_at < UTC_TIMESTAMP() - INTERVAL 7 DAY OR (is_active = 0 AND created_at < UTC_TIMESTAMP() - INTERVAL 30 DAY)");
      res.json({ ok: true, otp_deleted: otp.affectedRows, sessions_deleted: sess.affectedRows });
    }),
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 7. App
// ════════════════════════════════════════════════════════════════════════════

function buildApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(
    express.json({
      limit: "1mb",
      verify: (req, _res, buf) => {
        // Stripe signs the exact bytes: keep them for /api/webhooks/stripe.
        if ((req as Request).url?.startsWith("/api/webhooks/stripe")) (req as any).rawBody = Buffer.from(buf);
      },
    }),
  );
  app.use(csrfOriginGuard);

  registerPublicRoutes(app);
  registerAuthRoutes(app);
  registerWizardRoutes(app);
  registerJoinRoutes(app);
  registerTenantRoutes(app);
  registerAdminRoutes(app);
  registerCronRoutes(app);

  app.use("/api", (_req, res) => res.status(404).json({ error: "errors.notFound" }));
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    if (err?.type === "entity.parse.failed" || err instanceof SyntaxError) return void res.status(400).json({ error: "validation.invalidJson" });
    if (err?.type === "entity.too.large") return void res.status(413).json({ error: "errors.tooLarge" });
    if (!IS_TEST) console.error(`[api] ${req.method} ${req.path} unhandled`, err);
    res.status(500).json({ error: "errors.server" });
  });
  return app;
}

const app = buildApp();

/** Fresh app (vite dev plugin + supertest). */
export function createServer() {
  return buildApp();
}

export default function handler(req: VercelRequest, res: VercelResponse) {
  return app(req as any, res as any);
}

/** Test seams (never used by production code paths). */
export const __test = {
  setDb,
  realDb: () => realDb,
  closePool: async () => {
    if (_pool) await _pool.end();
    _pool = null;
  },
  emailDryRuns,
  clearEmails: () => void emailDryRuns.splice(0),
  setEmailTransport: (fn: typeof emailTransport) => void (emailTransport = fn),
  clearSettingsCache: () => settingsCache.clear(),
  setPaymentsApi: (api: PaymentsApi | null) => void (paymentsOverride = api),
  platformCan,
  tenantCan,
};
