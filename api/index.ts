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
  ExchangeTemplate,
  BillingOverview,
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
  WizardDraftRecord,
  InviteLinkInfo,
  InviteLinkState,
  JoinCodePreview,
  LeadRow,
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

/** Keyed hash for IPs we only need to compare (spam control): plain sha256 of an IPv4 is brute-forceable. */
function ipHash(req: Request): string {
  const key = process.env.IP_HASH_SECRET || process.env.CRON_SECRET || "quicksanta-dev";
  return crypto.createHmac("sha256", key).update(clientIp(req)).digest("hex");
}

/** Text that lands in an email subject/title: no control chars or newlines, collapsed spaces, short. */
export function cleanSubjectText(v: string, max = 60): string {
  const t = String(v ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
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

type EmailMsg = { to: string; subject: string; html: string; text: string; template: string; tenantId?: number | null; replyTo?: string | null };
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
        ...(m.replyTo ? { replyTo: m.replyTo } : {}),
      });
      if ((r as any)?.error) throw new Error((r as any).error.message || "resend error");
      providerId = (r as any)?.data?.id ?? null;
    }
  } catch (e) {
    status = "failed";
    error = (e as Error).message?.slice(0, 500) ?? "error";
  }
  // Awaited: serverless functions freeze after the response, dropping un-awaited writes.
  await db.exec("INSERT INTO email_log (tenant_id, to_email, template, status, provider_id, error) VALUES (?, ?, ?, ?, ?, ?)", [
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

// ── Email design system (minimal & clean). One layout, structured blocks → HTML + plain text from the same content.
// Rules: every user-supplied string is escaped here; `html` blocks are for trusted markup only. Keep ≤ 560px, system
// fonts, one accent (#b91c1c), bulletproof (VML) button for Outlook, dark-mode overrides for clients that support them.
export type EmailBlock =
  | { p: string }
  | { details: Array<[string, string | null | undefined]> }
  | { code: string }
  | { quote: string }
  | { note: string }
  | { html: string; text: string };
export interface EmailSpec {
  subject: string;
  /** Inbox preview line (hidden in the body). */
  preheader: string;
  kicker?: string;
  title: string;
  blocks: EmailBlock[];
  cta?: { href: string; label: string };
  /** Why the recipient got this email (footer). */
  reason: string;
}
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const EMAIL_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const EMAIL_MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

export function fmtEmailDate(lang: Lang, v: string | null | undefined): string | null {
  if (!v) return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T12:00:00Z` : `${String(v).replace(" ", "T")}${/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? "" : "Z"}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return v;
  return new Intl.DateTimeFormat(lang === "es" ? "es-MX" : "en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(d);
}

function emailButton(href: string, label: string) {
  const h = esc(href);
  const l = esc(label);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 0"><tr><td>
<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${h}" style="height:46px;v-text-anchor:middle;width:260px" arcsize="22%" stroke="f" fillcolor="#b91c1c"><center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold">${l}</center></v:roundrect><![endif]-->
<!--[if !mso]><!--><a href="${h}" style="display:inline-block;background:#b91c1c;color:#ffffff;text-decoration:none;font:600 15px/1 ${EMAIL_FONT};padding:15px 26px;border-radius:10px">${l}</a><!--<![endif]-->
</td></tr></table>`;
}

function blockHtml(b: EmailBlock): string {
  if ("p" in b) return `<p class="qs-text" style="margin:0 0 14px;font:15px/1.65 ${EMAIL_FONT};color:#3f3a36">${esc(b.p)}</p>`;
  if ("note" in b) return `<p class="qs-muted" style="margin:18px 0 0;font:13px/1.6 ${EMAIL_FONT};color:#8a8079">${esc(b.note)}</p>`;
  if ("quote" in b)
    return `<p class="qs-text" style="margin:4px 0 16px;padding:2px 0 2px 14px;border-left:3px solid #e9d7d4;font:italic 15px/1.6 ${EMAIL_FONT};color:#3f3a36">${esc(b.quote).replace(/\r?\n/g, "<br>")}</p>`;
  if ("code" in b)
    return `<div class="qs-box" style="margin:8px 0 6px;padding:18px;border:1px solid #ebe5de;border-radius:12px;background:#faf8f5;text-align:center"><span style="font:700 34px/1 ${EMAIL_MONO};letter-spacing:10px;color:#1f1a17" class="qs-text">${esc(b.code)}</span></div>`;
  if ("details" in b) {
    const rows = b.details
      .filter(([, v]) => v != null && String(v).trim() !== "")
      .map(
        ([k, v], i) =>
          `<tr><td class="qs-muted qs-row" style="padding:10px 0;${i ? "border-top:1px solid #efe9e2;" : ""}font:13px/1.4 ${EMAIL_FONT};color:#8a8079;width:38%;vertical-align:top">${esc(k)}</td><td class="qs-text qs-row" style="padding:10px 0;${i ? "border-top:1px solid #efe9e2;" : ""}font:600 14px/1.4 ${EMAIL_FONT};color:#1f1a17">${esc(v)}</td></tr>`,
      )
      .join("");
    return `<table role="presentation" class="qs-box" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 10px;padding:4px 18px;border:1px solid #ebe5de;border-radius:12px;background:#faf8f5">${rows}</table>`;
  }
  return b.html;
}

function blockText(b: EmailBlock): string {
  if ("p" in b) return b.p;
  if ("note" in b) return b.note;
  if ("quote" in b) return `“${b.quote}”`;
  if ("code" in b) return b.code;
  if ("details" in b) return b.details.filter(([, v]) => v != null && String(v).trim() !== "").map(([k, v]) => `${k}: ${v}`).join("\n");
  return b.text;
}

export function renderEmail(lang: Lang, e: EmailSpec): RenderedEmail {
  const es = lang === "es";
  const app = appUrl();
  const help = es ? "¿Dudas? Escríbenos a" : "Questions? Write to";
  const privacy = es ? "Privacidad" : "Privacy";
  const fallback = es ? "¿El botón no funciona? Copia este enlace:" : "Button not working? Copy this link:";
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${esc(e.subject)}</title>
<style>
@media (prefers-color-scheme: dark){.qs-bg{background:#141110!important}.qs-card{background:#1d1917!important;border-color:#2e2926!important}.qs-text{color:#f3ede7!important}.qs-muted{color:#a99e95!important}.qs-box{background:#262120!important;border-color:#3a332f!important}.qs-row{border-color:#3a332f!important}.qs-brand{color:#f3ede7!important}}
@media only screen and (max-width:600px){.qs-pad{padding:28px 22px!important}.qs-h1{font-size:22px!important}}
</style></head>
<body class="qs-bg" style="margin:0;padding:0;background:#f6f4f1;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all">${esc(e.preheader)}${"&nbsp;&zwnj;".repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="qs-bg" style="background:#f6f4f1"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="padding:0 6px 18px"><a href="${esc(app)}" style="text-decoration:none"><img src="${esc(app)}/icon-192.png" width="28" height="28" alt="" style="vertical-align:middle;border:0;border-radius:7px"> <span class="qs-brand" style="vertical-align:middle;font:700 16px/1 ${EMAIL_FONT};color:#1f1a17">QuickSanta</span></a></td></tr>
<tr><td class="qs-card qs-pad" style="background:#ffffff;border:1px solid #ebe5de;border-radius:16px;padding:36px 40px">
${e.kicker ? `<p style="margin:0 0 8px;font:700 11px/1.4 ${EMAIL_FONT};letter-spacing:.12em;text-transform:uppercase;color:#b91c1c">${esc(e.kicker)}</p>` : ""}
<h1 class="qs-text qs-h1" style="margin:0 0 16px;font:700 24px/1.3 ${EMAIL_FONT};letter-spacing:-.01em;color:#1f1a17">${esc(e.title)}</h1>
${e.blocks.map(blockHtml).join("\n")}
${e.cta ? `${emailButton(e.cta.href, e.cta.label)}<p class="qs-muted" style="margin:18px 0 0;font:12px/1.5 ${EMAIL_FONT};color:#8a8079">${fallback}<br><a href="${esc(e.cta.href)}" style="color:#8a8079;word-break:break-all">${esc(e.cta.href)}</a></p>` : ""}
</td></tr>
<tr><td class="qs-muted" style="padding:20px 10px 0;font:12px/1.7 ${EMAIL_FONT};color:#8a8079">${esc(e.reason)}<br>${help} <a href="mailto:alex@disruptinglabs.com" style="color:#8a8079">alex@disruptinglabs.com</a> · <a href="${esc(app)}/privacy" style="color:#8a8079">${privacy}</a><br>QuickSanta · Disrupting Labs · México</td></tr>
</table></td></tr></table></body></html>`;
  const text = [
    e.title,
    "",
    ...e.blocks.map(blockText).flatMap((t) => [t, ""]),
    ...(e.cta ? [`${e.cta.label}: ${e.cta.href}`, ""] : []),
    "—",
    e.reason,
    `${help} alex@disruptinglabs.com`,
    "QuickSanta · Disrupting Labs · México",
  ].join("\n");
  return { subject: e.subject, html, text };
}

// ── Templates (EN/ES). Each returns { subject, html, text }. ──

export function tplOtp(lang: Lang, code: string): RenderedEmail {
  const es = lang === "es";
  return renderEmail(lang, {
    subject: es ? `${code} es tu código de QuickSanta` : `${code} is your QuickSanta code`,
    preheader: es ? "Úsalo para entrar. Vence en 10 minutos." : "Use it to sign in. It expires in 10 minutes.",
    title: es ? "Tu código de acceso" : "Your sign-in code",
    blocks: [
      { p: es ? "Escribe este código en QuickSanta para entrar:" : "Enter this code in QuickSanta to sign in:" },
      { code },
      { note: es ? "Vence en 10 minutos. Si no lo pediste, ignora este correo: nadie puede entrar sin el código." : "It expires in 10 minutes. If you didn't ask for it, ignore this email: nobody can sign in without the code." },
    ],
    reason: es ? "Recibiste este correo porque alguien (ojalá tú) pidió entrar con esta dirección." : "You got this because someone (hopefully you) asked to sign in with this address.",
  });
}

type InviteData = { organizer: string; eventName: string; typeName: string; date: string | null; budget: string | null; themeRules?: string | null; people?: number | null; link: string };

function inviteDetails(lang: Lang, o: InviteData): EmailBlock {
  const es = lang === "es";
  return {
    details: [
      [es ? "Intercambio" : "Exchange", o.typeName],
      [es ? "Fecha" : "Date", fmtEmailDate(lang, o.date)],
      [es ? "Presupuesto" : "Budget", o.budget],
      [es ? "Personas" : "People", o.people ? String(o.people) : null],
    ],
  };
}

export function tplInvite(lang: Lang, o: InviteData): RenderedEmail {
  const es = lang === "es";
  return renderEmail(lang, {
    subject: es ? `${o.organizer} te invitó a “${o.eventName}”` : `${o.organizer} invited you to “${o.eventName}”`,
    preheader: es ? `Únete al intercambio${o.date ? ` del ${fmtEmailDate(lang, o.date)}` : ""}. Solo necesitas tu correo.` : `Join the exchange${o.date ? ` on ${fmtEmailDate(lang, o.date)}` : ""}. All you need is your email.`,
    kicker: es ? "Invitación" : "You're invited",
    title: o.eventName,
    blocks: [
      { p: es ? `${o.organizer} te invitó a participar.` : `${o.organizer} invited you to take part.` },
      inviteDetails(lang, o),
      ...(o.themeRules ? [{ quote: o.themeRules }] : []),
      { note: es ? "Entras con un código que te enviamos por correo: sin contraseñas ni apps. Puedes responder a este correo para escribirle a quien organiza." : "You'll sign in with a code we email you: no passwords or apps. Reply to this email to reach the organizer." },
    ],
    cta: { href: o.link, label: es ? "Unirme al intercambio" : "Join the exchange" },
    reason: es ? `${o.organizer} te agregó a este intercambio en QuickSanta.` : `${o.organizer} added you to this exchange on QuickSanta.`,
  });
}

export function tplReminder(lang: Lang, o: InviteData): RenderedEmail {
  const es = lang === "es";
  return renderEmail(lang, {
    subject: es ? `Recordatorio: únete a “${o.eventName}”` : `Reminder: join “${o.eventName}”`,
    preheader: es ? `${o.organizer} sigue esperándote. Toma un minuto.` : `${o.organizer} is still saving you a spot. It takes a minute.`,
    kicker: es ? "Recordatorio" : "Friendly reminder",
    title: es ? "Todavía hay un lugar para ti" : "There's still a spot for you",
    blocks: [{ p: es ? `${o.organizer} te invitó a “${o.eventName}” y aún no te has unido.` : `${o.organizer} invited you to “${o.eventName}” and you haven't joined yet.` }, inviteDetails(lang, o)],
    cta: { href: o.link, label: es ? "Unirme ahora" : "Join now" },
    reason: es ? `${o.organizer} te agregó a este intercambio en QuickSanta.` : `${o.organizer} added you to this exchange on QuickSanta.`,
  });
}

export function tplAssignment(lang: Lang, o: { eventName: string; link: string; revealOn?: string | null; wishlists?: boolean }): RenderedEmail {
  const es = lang === "es";
  const on = fmtEmailDate(lang, o.revealOn);
  return renderEmail(lang, {
    subject: es ? `¡El sorteo de “${o.eventName}” está listo!` : `The draw for “${o.eventName}” is ready!`,
    preheader: on ? (es ? `Se revela a todos juntos el ${on}.` : `Everyone finds out together on ${on}.`) : es ? "Entra para ver a quién le regalas. Es secreto." : "Sign in to see who you're gifting. Keep it secret.",
    kicker: es ? "Sorteo listo" : "Draw complete",
    title: es ? "Ya tienes a quién regalarle" : "You've got your match",
    blocks: [
      {
        p: on
          ? es
            ? `Tu asignación en “${o.eventName}” ya está lista, pero todos la descubren juntos el ${on}. Te avisaremos ese día.`
            : `Your match in “${o.eventName}” is set, but everyone finds out together on ${on}. We'll email you that day.`
          : es
            ? `Tu asignación en “${o.eventName}” está lista. Solo tú puedes verla, ni siquiera quien organiza.`
            : `Your match in “${o.eventName}” is ready. Only you can see it, not even the organizer.`,
      },
      ...(o.wishlists ? [{ p: es ? "Este intercambio usa listas de deseos: agrega la tuya para darle ideas a quien te regala." : "This exchange uses wishlists: add yours to give your gifter some ideas." }] : []),
      { note: es ? "Shhh… no se lo digas a nadie 🤫" : "Shhh… don't tell anyone 🤫" },
    ],
    cta: { href: o.link, label: on ? (es ? "Ver el intercambio" : "View the exchange") : es ? "Ver mi asignación" : "Reveal my match" },
    reason: es ? `Participas en “${o.eventName}” en QuickSanta.` : `You're part of “${o.eventName}” on QuickSanta.`,
  });
}

export function tplRevealDay(lang: Lang, o: { eventName: string; link: string }): RenderedEmail {
  const es = lang === "es";
  return renderEmail(lang, {
    subject: es ? `🎁 ¡Hoy es el día! Descubre a quién le regalas en “${o.eventName}”` : `🎁 It's reveal day! See who you're gifting in “${o.eventName}”`,
    preheader: es ? "Las asignaciones ya se pueden ver." : "Matches are unlocked for everyone.",
    kicker: es ? "Día de la revelación" : "Reveal day",
    title: es ? "Llegó el gran momento" : "The big moment is here",
    blocks: [{ p: es ? `Las asignaciones de “${o.eventName}” ya están abiertas para todos. Entra y voltea tu tarjeta.` : `Matches for “${o.eventName}” are now unlocked for everyone. Sign in and flip your card.` }],
    cta: { href: o.link, label: es ? "Ver mi asignación" : "Reveal my match" },
    reason: es ? `Participas en “${o.eventName}” en QuickSanta.` : `You're part of “${o.eventName}” on QuickSanta.`,
  });
}

export function tplLinkJoined(lang: Lang, o: { who: string; email?: string; eventName: string; link: string; people?: number | null }): RenderedEmail {
  const es = lang === "es";
  // The name is chosen by the joiner (callers pass it through cleanSubjectText); the email shows who it really is.
  return renderEmail(lang, {
    subject: es ? `Nueva persona en “${o.eventName}”: ${o.who}` : `New person in “${o.eventName}”: ${o.who}`,
    preheader: es ? "Se unió con tu enlace de invitación." : "They joined with your invite link.",
    kicker: es ? "Enlace de invitación" : "Invite link",
    title: es ? `${o.who} se unió` : `${o.who} joined`,
    blocks: [
      { details: [[es ? "Nombre" : "Name", o.who], [es ? "Correo" : "Email", o.email ?? null], [es ? "Intercambio" : "Exchange", o.eventName], [es ? "Personas ahora" : "People now", o.people ? String(o.people) : null]] },
      { note: es ? "¿No lo conoces? Puedes quitarlo desde la lista de participantes antes del sorteo." : "Don't know them? You can remove them from the participant list before the draw." },
    ],
    cta: { href: o.link, label: es ? "Ver participantes" : "View participants" },
    reason: es ? `Organizas “${o.eventName}” en QuickSanta.` : `You organize “${o.eventName}” on QuickSanta.`,
  });
}

export function tplLead(o: { name: string; email: string; company: string | null; teamSize: string; message: string | null; link: string }): RenderedEmail {
  // Internal notification to platform owners: English.
  return renderEmail("en", {
    subject: `New Enterprise inquiry: ${o.company || o.name}`,
    preheader: `${o.name} · ${o.teamSize}`,
    kicker: "Command Center · Leads",
    title: o.company || o.name,
    blocks: [{ details: [["Name", o.name], ["Email", o.email], ["Company", o.company], ["Team size", o.teamSize]] }, ...(o.message ? [{ quote: o.message }] : [])],
    cta: { href: o.link, label: "Open in Command Center" },
    reason: "You're a QuickSanta platform owner.",
  });
}

// ── Billing (to the workspace's organizers) ──
type BillingData = { workspace: string; link: string };
const billingReason = (lang: Lang, ws: string) => (lang === "es" ? `Organizas el espacio “${ws}” en QuickSanta.` : `You're an organizer of the “${ws}” workspace on QuickSanta.`);

export function tplProWelcome(lang: Lang, o: BillingData & { maxPeople: number; renewsOn?: string | null; price: string }): RenderedEmail {
  const es = lang === "es";
  return renderEmail(lang, {
    subject: es ? `Bienvenido a Pro, ${o.workspace} ✨` : `Welcome to Pro, ${o.workspace} ✨`,
    preheader: es ? `Hasta ${o.maxPeople} personas por intercambio y todos los servicios.` : `Up to ${o.maxPeople} people per exchange and every service.`,
    kicker: "QuickSanta Pro",
    title: es ? "Tu espacio ya es Pro" : "Your workspace is now Pro",
    blocks: [
      { p: es ? "Gracias por apoyar QuickSanta. Esto es lo que se desbloqueó:" : "Thanks for supporting QuickSanta. Here's what you unlocked:" },
      {
        details: [
          [es ? "Personas" : "People", es ? `Hasta ${o.maxPeople} por intercambio` : `Up to ${o.maxPeople} per exchange`],
          [es ? "Servicios" : "Services", es ? "Todos, incluido Crea el tuyo" : "All of them, including Create your own"],
          [es ? "Plantillas" : "Templates", es ? "Guarda y reutiliza tus diseños" : "Save and reuse your designs"],
          [es ? "Precio" : "Price", o.price],
          [es ? "Se renueva" : "Renews", fmtEmailDate(lang, o.renewsOn)],
        ],
      },
      { note: es ? "Puedes cambiar tu tarjeta o cancelar cuando quieras desde Plan y facturación." : "Change your card or cancel anytime from Plan & billing." },
    ],
    cta: { href: o.link, label: es ? "Ir a mi espacio" : "Go to my workspace" },
    reason: billingReason(lang, o.workspace),
  });
}

export function tplPaymentFailed(lang: Lang, o: BillingData & { graceEnds: string | null; graceDays: number }): RenderedEmail {
  const es = lang === "es";
  const until = fmtEmailDate(lang, o.graceEnds);
  return renderEmail(lang, {
    subject: es ? `Acción necesaria: no pudimos cobrar Pro de ${o.workspace}` : `Action needed: we couldn't charge Pro for ${o.workspace}`,
    preheader: until ? (es ? `Pro sigue activo hasta el ${until}. Actualiza tu tarjeta.` : `Pro stays on until ${until}. Update your card.`) : es ? "Actualiza tu tarjeta para mantener Pro." : "Update your card to keep Pro.",
    kicker: es ? "Pago fallido" : "Payment failed",
    title: es ? "Tu renovación de Pro no se pudo cobrar" : "Your Pro renewal didn't go through",
    blocks: [
      {
        p: es
          ? `El banco rechazó el cobro. No pasa nada todavía: Pro sigue activo ${until ? `hasta el ${until}` : `por ${o.graceDays} días`} para que actualices tu tarjeta.`
          : `Your bank declined the charge. Nothing changes yet: Pro stays on ${until ? `until ${until}` : `for ${o.graceDays} days`} while you update your card.`,
      },
      { p: es ? "Si no se actualiza, el espacio vuelve a Gratis: tus intercambios siguen funcionando, pero no podrán crecer más allá del límite gratuito." : "If it isn't updated, the workspace returns to Free: your exchanges keep working, but they can't grow beyond the Free limit." },
    ],
    cta: { href: o.link, label: es ? "Actualizar tarjeta" : "Update card" },
    reason: billingReason(lang, o.workspace),
  });
}

export function tplProEnded(lang: Lang, o: BillingData & { freeMax: number }): RenderedEmail {
  const es = lang === "es";
  return renderEmail(lang, {
    subject: es ? `${o.workspace} volvió al plan Gratis` : `${o.workspace} is back on the Free plan`,
    preheader: es ? "Tus intercambios siguen funcionando. Reactiva Pro cuando quieras." : "Your exchanges keep working. Reactivate Pro anytime.",
    kicker: es ? "Cambio de plan" : "Plan change",
    title: es ? "Tu espacio volvió a Gratis" : "Your workspace is back on Free",
    blocks: [
      { p: es ? "Pro terminó. Nada se borró: tus intercambios, participantes y plantillas siguen ahí." : "Pro has ended. Nothing was deleted: your exchanges, participants and templates are all still there." },
      { p: es ? `Mientras estés en Gratis, cada intercambio admite hasta ${o.freeMax} personas y solo Amigo secreto y Elefante blanco.` : `While on Free, each exchange holds up to ${o.freeMax} people, with Secret Santa and White Elephant.` },
    ],
    cta: { href: o.link, label: es ? "Reactivar Pro" : "Reactivate Pro" },
    reason: billingReason(lang, o.workspace),
  });
}

export function tplCancelScheduled(lang: Lang, o: BillingData & { endsOn: string | null }): RenderedEmail {
  const es = lang === "es";
  const on = fmtEmailDate(lang, o.endsOn);
  return renderEmail(lang, {
    subject: es ? `Cancelaste Pro de ${o.workspace}` : `You cancelled Pro for ${o.workspace}`,
    preheader: on ? (es ? `Pro sigue activo hasta el ${on}.` : `Pro stays on until ${on}.`) : es ? "Pro sigue activo hasta el fin del periodo." : "Pro stays on until the end of the period.",
    kicker: es ? "Cancelación programada" : "Cancellation scheduled",
    title: es ? "Lamentamos verte partir" : "Sorry to see you go",
    blocks: [
      { p: es ? `Tu suscripción no se renovará. Pro sigue activo ${on ? `hasta el ${on}` : "hasta el fin del periodo pagado"} y no se te cobrará de nuevo.` : `Your subscription won't renew. Pro stays on ${on ? `until ${on}` : "until the end of the paid period"} and you won't be charged again.` },
      { p: es ? "¿Cambiaste de opinión? Puedes reactivarla antes de esa fecha con un clic." : "Changed your mind? You can resume before then in one click." },
    ],
    cta: { href: o.link, label: es ? "Reactivar suscripción" : "Resume subscription" },
    reason: billingReason(lang, o.workspace),
  });
}

export function tplResumed(lang: Lang, o: BillingData & { renewsOn: string | null }): RenderedEmail {
  const es = lang === "es";
  const on = fmtEmailDate(lang, o.renewsOn);
  return renderEmail(lang, {
    subject: es ? `Pro sigue activo para ${o.workspace} 🎉` : `Pro is back on for ${o.workspace} 🎉`,
    preheader: es ? "Tu suscripción se renovará normalmente." : "Your subscription will renew as usual.",
    kicker: "QuickSanta Pro",
    title: es ? "¡Qué bueno que te quedas!" : "Glad you're staying!",
    blocks: [{ p: es ? `Reactivaste tu suscripción. ${on ? `Se renovará el ${on}.` : ""}` : `You resumed your subscription. ${on ? `It renews on ${on}.` : ""}` }],
    cta: { href: o.link, label: es ? "Ver mi plan" : "View my plan" },
    reason: billingReason(lang, o.workspace),
  });
}

/** Sample data for every template (Command Center → Email gallery). Keys = email_log.template. */
export const EMAIL_PREVIEWS: Record<string, (lang: Lang) => RenderedEmail> = {
  otp: (l) => tplOtp(l, "482913"),
  invite: (l) => tplInvite(l, { organizer: "Olga Ruiz", eventName: l === "es" ? "Intercambio de la oficina" : "Office Secret Santa", typeName: l === "es" ? "Amigo secreto" : "Secret Santa", date: "2026-12-18", budget: "25 USD", themeRules: l === "es" ? "Algo hecho a mano" : "Something handmade", people: 14, link: `${appUrl()}/join/sample-token` }),
  reminder: (l) => tplReminder(l, { organizer: "Olga Ruiz", eventName: l === "es" ? "Intercambio de la oficina" : "Office Secret Santa", typeName: l === "es" ? "Amigo secreto" : "Secret Santa", date: "2026-12-18", budget: "25 USD", people: 14, link: `${appUrl()}/join/sample-token` }),
  assignment: (l) => tplAssignment(l, { eventName: l === "es" ? "Navidad Gómez" : "Gómez Family Christmas", link: `${appUrl()}/app/my/SAMPLE`, wishlists: true }),
  assignment_together: (l) => tplAssignment(l, { eventName: l === "es" ? "Navidad Gómez" : "Gómez Family Christmas", link: `${appUrl()}/app/my/SAMPLE`, revealOn: "2026-12-24" }),
  reveal_day: (l) => tplRevealDay(l, { eventName: l === "es" ? "Navidad Gómez" : "Gómez Family Christmas", link: `${appUrl()}/app/my/SAMPLE` }),
  link_joined: (l) => tplLinkJoined(l, { who: "Sam Rivera", email: "sam@example.com", eventName: l === "es" ? "Intercambio de la oficina" : "Office Secret Santa", people: 15, link: `${appUrl()}/app/events/1` }),
  pro_welcome: (l) => tplProWelcome(l, { workspace: "Acme", maxPeople: 100, renewsOn: "2026-12-27", price: l === "es" ? "US$8.90 al mes" : "US$8.90 / month", link: `${appUrl()}/app` }),
  payment_failed: (l) => tplPaymentFailed(l, { workspace: "Acme", graceEnds: "2026-11-30 09:00:00", graceDays: 3, link: `${appUrl()}/app/billing` }),
  pro_ended: (l) => tplProEnded(l, { workspace: "Acme", freeMax: 20, link: `${appUrl()}/app/billing` }),
  cancel_scheduled: (l) => tplCancelScheduled(l, { workspace: "Acme", endsOn: "2026-12-27", link: `${appUrl()}/app/billing` }),
  resumed: (l) => tplResumed(l, { workspace: "Acme", renewsOn: "2026-12-27", link: `${appUrl()}/app/billing` }),
  contact: () => tplLead({ name: "Ana Pérez", email: "ana@acme.com", company: "Acme", teamSize: "100_500", message: "3 offices, 400 people, one draw per office.", link: `${appUrl()}/admin/leads` }),
};

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
/** Wishlists are a property of the service: off / always on / organizer's choice. */
export function effectiveWishlists(mode: string | null | undefined, requested: boolean | undefined): boolean {
  if (mode === "required") return true;
  if (mode === "optional") return requested !== false;
  return false;
}

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
  "leads.manage": ["owner", "admin"],
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
    `SELECT t.id AS tenant_id, t.public_id AS tenant_public_id, t.name AS tenant_name, t.slug AS tenant_slug, t.status AS tenant_status, m.role,
            t.plan AS plan_raw, t.subscription_status, t.past_due_since, t.current_period_end AS period_end
       FROM tenant_members m JOIN tenants t ON t.id = m.tenant_id
      WHERE m.user_id = ? AND m.status = 'active' AND t.status <> 'archived'
      ORDER BY FIELD(m.role, 'organizer', 'participant'), t.name`,
    [userId],
  );
  const grace = rows.length ? (await pricingInfo()).grace_days : 3;
  return rows.map(({ plan_raw, subscription_status, past_due_since, period_end, ...r }) => ({
    ...r,
    tenant_id: Number(r.tenant_id),
    tenant_plan: effectiveTenantPlan({ plan: plan_raw, subscription_status, past_due_since, current_period_end: period_end }, grace),
  }));
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
function requireTenant(perm: TenantPerm, opts: { allowSuspended?: boolean } = {}) {
  const auth = requireAuth();
  return (req: Request, res: Response, next: NextFunction) =>
    auth(req, res, (err?: unknown) => {
      if (err) return next(err);
      const u = authed(res);
      const hdr = Number(req.headers["x-tenant-id"]);
      const tenantId = Number.isInteger(hdr) && hdr > 0 ? hdr : u.active_tenant_id;
      const m = u.memberships.find((x) => x.tenant_id === tenantId);
      if (!m) return void res.status(403).json({ error: "errors.noTenantAccess" });
      // Suspended workspaces can still see invoices, fix their card or cancel (never trap a paying customer).
      if (m.tenant_status !== "active" && !(opts.allowSuspended && m.tenant_status === "suspended")) return void res.status(423).json({ error: "errors.tenantSuspended" });
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
/** Codes are bearer secrets: cap guessing per IP (32^8 space + this limit makes enumeration impractical). */
const joinCodeLimiter = limiter(15 * 60_000, 60);
/** Public contact form: a handful per hour per IP is plenty for humans. */
const contactLimiter = limiter(60 * 60_000, 5);

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
// 5b. Pricing + Stripe subscriptions (Free ≤ free_max · Pro = $8.90/month per workspace · Enterprise = tenant plan)
// ════════════════════════════════════════════════════════════════════════════

export async function pricingInfo(): Promise<PricingInfo> {
  const [freeMax, proMax, cents, currency, grace, offer] = await Promise.all([
    readSetting("free_max_participants", "20"),
    readSetting("pro_max_participants", "100"),
    readSetting("pro_price_cents", "890"),
    readSetting("pro_currency", "usd"),
    readSetting("subscription_grace_days", "3"),
    readSetting("save_offer_percent", "50"),
  ]);
  return {
    free_max_participants: Number(freeMax) || 20,
    pro_max_participants: Number(proMax) || 100,
    pro_price_cents: Number(cents) || 890,
    pro_currency: String(currency || "usd").toLowerCase(),
    pro_interval: "month",
    grace_days: Number(grace) || 3,
    save_offer_percent: Math.min(100, Math.max(0, Number(offer) || 0)),
  };
}

type TenantBillingRow = { plan?: string | null; subscription_status?: string | null; current_period_end?: string | null; past_due_since?: string | null };

/**
 * The plan that applies right now. A Pro workspace whose renewal failed (past_due) keeps Pro for
 * `grace_days` after the FIRST failure (`past_due_since`; Stripe already advanced current_period_end),
 * then drops to Free (exchanges keep running; growth is locked).
 */
export function effectiveTenantPlan(t: TenantBillingRow, graceDays: number, now = Date.now()): "free" | "pro" | "enterprise" {
  if (t.plan === "enterprise") return "enterprise";
  if (t.plan !== "pro") return "free";
  if (t.subscription_status === "past_due") {
    const since = t.past_due_since ?? t.current_period_end;
    if (!since) return "pro";
    const end = Date.parse(String(since).replace(" ", "T") + (String(since).endsWith("Z") ? "" : "Z"));
    if (Number.isFinite(end) && now > end + graceDays * 86_400_000) return "free";
  }
  return "pro";
}

/** Effective people limit for one exchange. Legacy per-exchange Pro purchases are still honored. */
export function participantLimit(p: PricingInfo, eventPlan: EventPlan, tenantPlan: string | null | undefined, tenantMax: number): number {
  if (tenantPlan === "enterprise") return Math.max(tenantMax || 0, p.pro_max_participants);
  return tenantPlan === "pro" || eventPlan === "pro" ? p.pro_max_participants : p.free_max_participants;
}

/** Subscription statuses that grant Pro (past_due is still Pro during the grace window). */
export function planFromSubscriptionStatus(status: string): "pro" | "free" {
  return ["active", "trialing", "past_due"].includes(status) ? "pro" : "free";
}

export type CardInfo = { brand: string | null; last4: string | null; exp: string | null };
export type SubscriptionInfo = {
  id: string;
  status: string;
  customer: string;
  current_period_end: number | null;
  cancel_at_period_end: boolean;
  client_secret: string | null;
  latest_invoice_id: string | null;
  card: CardInfo | null;
  discount_percent: number | null;
  metadata: Record<string, string>;
};
export type InvoiceInfo = {
  id: string;
  number: string | null;
  status: string | null;
  amount_cents: number;
  currency: string;
  created: number;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  subscription: string | null;
  customer: string;
  card: CardInfo | null;
};

/** The part of Stripe we use (swappable in tests via __test.setBillingApi). */
export interface BillingApi {
  createCustomer(o: { email: string; name: string; tenantId: number }): Promise<string>;
  createSubscription(o: { customer: string; price: string; tenantId: number; idempotencyKey: string }): Promise<SubscriptionInfo>;
  getSubscription(id: string): Promise<SubscriptionInfo>;
  updateSubscription(id: string, o: { cancel_at_period_end?: boolean; coupon?: string; default_payment_method?: string; cancel_reason?: string }): Promise<SubscriptionInfo>;
  /** Ends the subscription immediately and voids its open invoice (no more retries). */
  cancelNow(id: string, reason?: string): Promise<SubscriptionInfo>;
  createSetupIntent(customer: string): Promise<{ client_secret: string }>;
  setDefaultPaymentMethod(customer: string, paymentMethod: string): Promise<CardInfo>;
  listInvoices(customer: string): Promise<InvoiceInfo[]>;
  getInvoice(id: string): Promise<InvoiceInfo>;
  payInvoice(id: string): Promise<string>;
  ensureCoupon(percent: number): Promise<string>;
  constructWebhookEvent(raw: Buffer, signature: string, secret: string): { type: string; data: { object: any } };
}

let billingOverride: BillingApi | null = null;
let stripeClient: Stripe | null = null;

function cardOf(pm: any): CardInfo | null {
  const c = pm && typeof pm === "object" ? pm.card : null;
  if (!c) return null;
  return { brand: c.brand ?? null, last4: c.last4 ?? null, exp: c.exp_month && c.exp_year ? `${String(c.exp_month).padStart(2, "0")}/${c.exp_year}` : null };
}

function normalizeSubscription(s: any): SubscriptionInfo {
  const item = s.items?.data?.[0];
  const inv = s.latest_invoice && typeof s.latest_invoice === "object" ? s.latest_invoice : null;
  const secret = inv?.confirmation_secret?.client_secret ?? inv?.payment_intent?.client_secret ?? null;
  const discount = Array.isArray(s.discounts) ? s.discounts[0] : s.discount;
  return {
    id: s.id,
    status: s.status,
    customer: typeof s.customer === "string" ? s.customer : s.customer?.id,
    current_period_end: Number(item?.current_period_end ?? s.current_period_end ?? 0) || null,
    cancel_at_period_end: Boolean(s.cancel_at_period_end),
    client_secret: secret,
    latest_invoice_id: inv?.id ?? (typeof s.latest_invoice === "string" ? s.latest_invoice : null),
    card: cardOf(s.default_payment_method),
    discount_percent: discount && typeof discount === "object" ? Number(discount.coupon?.percent_off ?? discount.source?.coupon?.percent_off ?? 0) || null : null,
    metadata: (s.metadata ?? {}) as Record<string, string>,
  };
}

function normalizeInvoice(i: any): InvoiceInfo {
  return {
    id: i.id,
    number: i.number ?? null,
    status: i.status ?? null,
    amount_cents: Number(i.status === "paid" ? i.amount_paid : i.amount_due) || 0,
    currency: String(i.currency || "usd"),
    created: Number(i.created) || 0,
    hosted_invoice_url: i.hosted_invoice_url ?? null,
    invoice_pdf: i.invoice_pdf ?? null,
    subscription: typeof i.subscription === "string" ? i.subscription : i.subscription?.id ?? i.parent?.subscription_details?.subscription ?? null,
    customer: typeof i.customer === "string" ? i.customer : i.customer?.id,
    card: null,
  };
}

function billingApi(): BillingApi {
  if (billingOverride) return billingOverride;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || IS_TEST) throw new HttpError(503, "errors.paymentsUnavailable");
  stripeClient ??= new Stripe(key);
  const st = stripeClient;
  const SUB_EXPAND = ["latest_invoice.confirmation_secret", "default_payment_method", "discounts.source.coupon"];
  return {
    async createCustomer(o) {
      const c = await st.customers.create({ email: o.email, name: o.name, metadata: { tenant_id: String(o.tenantId) } }, { idempotencyKey: `qs-cus-${o.tenantId}` });
      return c.id;
    },
    async createSubscription(o) {
      const s = await st.subscriptions.create(
        {
          customer: o.customer,
          items: [{ price: o.price }],
          payment_behavior: "default_incomplete",
          payment_settings: { save_default_payment_method: "on_subscription", payment_method_types: ["card"] },
          metadata: { tenant_id: String(o.tenantId) },
          expand: SUB_EXPAND,
        },
        { idempotencyKey: o.idempotencyKey },
      );
      return normalizeSubscription(s);
    },
    async getSubscription(id) {
      return normalizeSubscription(await st.subscriptions.retrieve(id, { expand: SUB_EXPAND }));
    },
    async updateSubscription(id, o) {
      const params: any = { expand: SUB_EXPAND };
      if (o.cancel_at_period_end !== undefined) params.cancel_at_period_end = o.cancel_at_period_end;
      if (o.cancel_reason) params.cancellation_details = { feedback: o.cancel_reason };
      if (o.coupon) params.discounts = [{ coupon: o.coupon }];
      if (o.default_payment_method) params.default_payment_method = o.default_payment_method;
      return normalizeSubscription(await st.subscriptions.update(id, params));
    },
    async cancelNow(id, reason) {
      const before = await st.subscriptions.retrieve(id);
      const s = await st.subscriptions.cancel(id, { invoice_now: false, prorate: false, ...(reason ? { cancellation_details: { feedback: reason as any } } : {}) });
      const invId = typeof before.latest_invoice === "string" ? before.latest_invoice : before.latest_invoice?.id;
      if (invId) {
        const inv = await st.invoices.retrieve(invId);
        if (inv.status === "open") await st.invoices.voidInvoice(invId).catch(() => undefined);
      }
      return normalizeSubscription(await st.subscriptions.retrieve(s.id, { expand: SUB_EXPAND }));
    },
    async createSetupIntent(customer) {
      const si = await st.setupIntents.create({ customer, usage: "off_session", automatic_payment_methods: { enabled: true, allow_redirects: "never" } });
      return { client_secret: si.client_secret! };
    },
    async setDefaultPaymentMethod(customer, paymentMethod) {
      const pm = await st.paymentMethods.retrieve(paymentMethod);
      if (pm.customer && pm.customer !== customer) throw new HttpError(400, "errors.paymentMismatch");
      if (!pm.customer) await st.paymentMethods.attach(paymentMethod, { customer });
      await st.customers.update(customer, { invoice_settings: { default_payment_method: paymentMethod } });
      return cardOf(pm) ?? { brand: null, last4: null, exp: null };
    },
    async listInvoices(customer) {
      const list = await st.invoices.list({ customer, limit: 24 });
      return list.data.map(normalizeInvoice);
    },
    async getInvoice(id) {
      return normalizeInvoice(await st.invoices.retrieve(id));
    },
    async payInvoice(id) {
      const inv = await st.invoices.pay(id);
      return inv.status ?? "open";
    },
    async ensureCoupon(percent) {
      const id = `qs-save-${percent}`;
      try {
        await st.coupons.retrieve(id);
      } catch (e: any) {
        if (e?.code !== "resource_missing") throw e;
        await st.coupons.create({ id, percent_off: percent, duration: "once", name: `QuickSanta stay offer ${percent}%` });
      }
      return id;
    },
    constructWebhookEvent(raw, signature, secret) {
      return st.webhooks.constructEvent(raw, signature, secret) as any;
    },
  };
}

function priceId(): string {
  const id = process.env.STRIPE_PLATFORM_PRICE_ID;
  if (!id && !billingOverride) throw new HttpError(503, "errors.paymentsUnavailable");
  return id || "price_test";
}

const toSqlDate = (unix: number | null) => (unix ? new Date(unix * 1000).toISOString().slice(0, 19).replace("T", " ") : null);

/** Opens exchanges that were waiting for Pro and sends their queued invitations (idempotent). */
async function openPendingExchanges(req: Request | null, tenantId: number, lang: Lang) {
  const pending = await db.query(
    `SELECT e.id, e.name, e.exchange_date, e.budget_min, e.budget_max, e.currency, e.invites_pending, e.custom_name, e.theme_rules, et.name_en, et.name_es, u.full_name AS organizer, u.email AS organizer_email
       FROM events e JOIN event_types et ON et.id = e.event_type_id LEFT JOIN users u ON u.id = e.created_by
      WHERE e.tenant_id = ? AND (e.status = 'pending_payment' OR (e.status = 'open' AND e.invites_pending = 1))`,
    [tenantId],
  );
  for (const ev of pending) {
    // Open first (idempotent); queued invites are retried on every sync/webhook until all are sent.
    await db.exec("UPDATE events SET status = 'open' WHERE id = ? AND tenant_id = ? AND status = 'pending_payment'", [ev.id, tenantId]);
    if (!toBool(ev.invites_pending) || !req) continue;
    const people = await db.query("SELECT id, email FROM participants WHERE event_id = ? AND tenant_id = ? AND status = 'invited' AND invite_token_hash IS NULL", [ev.id, tenantId]);
    let failedSends = 0;
    await inBatches(people, 8, async (p) => {
      const ok = await sendInvite(req, db, {
        tenantId,
        participantId: Number(p.id),
        email: p.email,
        organizer: ev.organizer || "QuickSanta",
        replyTo: ev.organizer_email ?? null,
        event: { name: ev.name, exchange_date: ev.exchange_date, budget_min: toNum(ev.budget_min), budget_max: toNum(ev.budget_max), currency: ev.currency },
        typeName: serviceLabel(ev, lang),
        themeRules: ev.theme_rules ?? null,
        lang,
      });
      if (!ok) failedSends++;
    });
    if (!failedSends) await db.exec("UPDATE events SET invites_pending = 0 WHERE id = ?", [ev.id]);
  }
}

/** Mirror a Stripe subscription onto its workspace (single source of truth = Stripe). Idempotent. */
async function syncTenantSubscription(req: Request | null, sub: SubscriptionInfo): Promise<{ tenantId: number; changed: boolean } | null> {
  const rows = await db.query("SELECT id, name, plan, locale, stripe_subscription_id, subscription_status, past_due_since, cancel_at_period_end FROM tenants WHERE stripe_customer_id = ? LIMIT 1", [sub.customer]);
  const t = rows[0];
  if (!t) return null;
  const tenantId = Number(t.id);
  // Ignore stale events for an older subscription of the same customer.
  if (t.stripe_subscription_id && t.stripe_subscription_id !== sub.id && !["active", "trialing", "past_due"].includes(sub.status)) return { tenantId, changed: false };
  const plan = t.plan === "enterprise" ? "enterprise" : planFromSubscriptionStatus(sub.status);
  const pastDueSince = sub.status === "past_due" ? t.past_due_since ?? new Date().toISOString().slice(0, 19).replace("T", " ") : null;
  // Compare-and-set first: only the caller that actually flips the status / cancel flag sends the matching email
  // (the webhook and /billing/sync often process the same change within milliseconds).
  const statusFlipped = (await db.exec("UPDATE tenants SET subscription_status = ? WHERE id = ? AND NOT (subscription_status <=> ?)", [sub.status, tenantId, sub.status])).affectedRows === 1;
  const cancelFlag = sub.cancel_at_period_end ? 1 : 0;
  const cancelFlipped = (await db.exec("UPDATE tenants SET cancel_at_period_end = ? WHERE id = ? AND cancel_at_period_end <> ?", [cancelFlag, tenantId, cancelFlag])).affectedRows === 1;
  await db.exec(
    `UPDATE tenants SET stripe_subscription_id = ?, subscription_status = ?, current_period_end = ?, past_due_since = ?, cancel_at_period_end = ?, plan = ?,
            card_brand = COALESCE(?, card_brand), card_last4 = COALESCE(?, card_last4), card_exp = COALESCE(?, card_exp)
      WHERE id = ?`,
    [sub.id, sub.status, toSqlDate(sub.current_period_end), pastDueSince, sub.cancel_at_period_end ? 1 : 0, plan, sub.card?.brand ?? null, sub.card?.last4 ?? null, sub.card?.exp ?? null, tenantId],
  );
  const grace = (await pricingInfo()).grace_days;
  const effective = effectiveTenantPlan({ plan, subscription_status: sub.status, past_due_since: pastDueSince }, grace);
  // Waiting exchanges open only while Pro actually applies (never for an expired grace period).
  if (effective !== "free") await openPendingExchanges(req, tenantId, t.locale === "es" ? "es" : "en");
  await billingNotices(tenantId, String(t.name ?? ""), {
    oldStatus: t.subscription_status ?? null,
    newStatus: sub.status,
    statusFlipped,
    cancelFlipped,
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
    periodEnd: toSqlDate(sub.current_period_end),
    // Ending after a failed renewal: keep the original past_due_since so the grace-ended cron and this path share one ref.
    pastDueSince: pastDueSince ?? t.past_due_since ?? null,
    enterprise: t.plan === "enterprise",
  }).catch((e) => console.warn("[billing-notices]", (e as Error).message));
  return { tenantId, changed: t.subscription_status !== sub.status };
}

// ── Billing emails (to the workspace's active organizers, each in their own language) ──
const LIVE_STATUSES = ["active", "trialing"];
const ENDED_STATUSES = ["canceled", "unpaid", "incomplete_expired"];

async function emailOrganizers(tenantId: number, template: string, build: (lang: Lang) => RenderedEmail) {
  const orgs = await db.query(
    "SELECT u.email, u.locale FROM tenant_members m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = ? AND m.role = 'organizer' AND m.status = 'active' AND u.status = 'active'",
    [tenantId],
  );
  for (const o of orgs) await sendEmail({ to: String(o.email), ...build(o.locale === "es" ? "es" : "en"), template, tenantId });
  return orgs.length;
}

/** First caller wins: INSERT IGNORE on (kind, ref). */
async function claimNotice(kind: string, ref: string, tenantId: number | null): Promise<boolean> {
  return (await db.exec("INSERT IGNORE INTO email_notices (tenant_id, kind, ref) VALUES (?, ?, ?)", [tenantId, kind, ref.slice(0, 160)])).affectedRows === 1;
}

const proPriceLabel = (lang: Lang, p: { pro_price_cents: number; pro_currency: string }) => {
  const amount = `${p.pro_currency.toUpperCase() === "USD" ? "US$" : `${p.pro_currency.toUpperCase()} `}${(p.pro_price_cents / 100).toFixed(2)}`;
  return lang === "es" ? `${amount} al mes` : `${amount} / month`;
};

export async function billingNotices(
  tenantId: number,
  workspace: string,
  c: { oldStatus: string | null; newStatus: string; statusFlipped: boolean; cancelFlipped: boolean; cancelAtPeriodEnd: boolean; periodEnd: string | null; pastDueSince: string | null; enterprise: boolean },
) {
  const pricing = await pricingInfo();
  const billing = `${appUrl()}/app/billing`;
  const wasLive = c.oldStatus != null && [...LIVE_STATUSES, "past_due"].includes(c.oldStatus);
  if (c.statusFlipped && LIVE_STATUSES.includes(c.newStatus) && !wasLive) {
    await emailOrganizers(tenantId, "pro_welcome", (l) =>
      tplProWelcome(l, { workspace, maxPeople: pricing.pro_max_participants, renewsOn: c.periodEnd, price: proPriceLabel(l, pricing), link: `${appUrl()}/app` }),
    );
  }
  if (c.statusFlipped && c.newStatus === "past_due") {
    const since = c.pastDueSince ? Date.parse(`${c.pastDueSince.replace(" ", "T")}Z`) : Date.now();
    const graceEnds = new Date(since + pricing.grace_days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
    await emailOrganizers(tenantId, "payment_failed", (l) => tplPaymentFailed(l, { workspace, graceEnds, graceDays: pricing.grace_days, link: billing }));
  }
  if (c.statusFlipped && ENDED_STATUSES.includes(c.newStatus) && wasLive && !c.enterprise) {
    // Shared ref with the grace-ended cron: whichever notices first sends it, once.
    if (await claimNotice("pro_ended", `${tenantId}:${c.pastDueSince ?? c.periodEnd ?? "end"}`, tenantId)) {
      await emailOrganizers(tenantId, "pro_ended", (l) => tplProEnded(l, { workspace, freeMax: pricing.free_max_participants, link: billing }));
    }
  }
  if (c.cancelFlipped && LIVE_STATUSES.includes(c.newStatus)) {
    if (c.cancelAtPeriodEnd) await emailOrganizers(tenantId, "cancel_scheduled", (l) => tplCancelScheduled(l, { workspace, endsOn: c.periodEnd, link: billing }));
    else await emailOrganizers(tenantId, "resumed", (l) => tplResumed(l, { workspace, renewsOn: c.periodEnd, link: billing }));
  }
}

/** "Reveal together" exchanges: on the exchange date (UTC; yesterday too, in case a cron run was missed), email every joined person once. */
export async function sendRevealDayEmails(): Promise<number> {
  const events = await db.query(
    `SELECT e.id, e.tenant_id, e.public_id, e.name, t.locale FROM events e JOIN tenants t ON t.id = e.tenant_id
      WHERE e.reveal_mode = 'together' AND e.status = 'drawn' AND t.status = 'active'
        AND e.exchange_date BETWEEN UTC_DATE() - INTERVAL 1 DAY AND UTC_DATE()`,
  );
  let sent = 0;
  for (const ev of events) {
    if (!(await claimNotice("reveal_day", String(ev.id), Number(ev.tenant_id)))) continue;
    const people = await db.query(
      "SELECT p.email, u.locale FROM participants p LEFT JOIN users u ON u.id = p.user_id WHERE p.event_id = ? AND p.tenant_id = ? AND p.status = 'joined'",
      [ev.id, ev.tenant_id],
    );
    const link = `${appUrl()}/app/my/${ev.public_id}`;
    await inBatches(people, 10, async (p) => {
      const lang: Lang = (p.locale ?? ev.locale) === "es" ? "es" : "en";
      if ((await sendEmail({ to: String(p.email), ...tplRevealDay(lang, { eventName: ev.name, link }), template: "reveal_day", tenantId: Number(ev.tenant_id) })).ok) sent++;
    });
  }
  return sent;
}

/** A failed renewal whose grace period ran out: the workspace is effectively Free now (no Stripe event marks that moment). */
export async function sendGraceEndedEmails(): Promise<number> {
  const pricing = await pricingInfo();
  const rows = await db.query(
    `SELECT id, name, past_due_since FROM tenants
      WHERE subscription_status = 'past_due' AND plan <> 'enterprise' AND status = 'active' AND past_due_since IS NOT NULL
        AND past_due_since < UTC_TIMESTAMP() - INTERVAL ${Number(pricing.grace_days) || 0} DAY`,
  );
  let sent = 0;
  for (const t of rows) {
    if (!(await claimNotice("pro_ended", `${t.id}:${t.past_due_since}`, Number(t.id)))) continue;
    sent += await emailOrganizers(Number(t.id), "pro_ended", (l) => tplProEnded(l, { workspace: String(t.name), freeMax: pricing.free_max_participants, link: `${appUrl()}/app/billing` }));
  }
  return sent;
}

async function recordInvoice(inv: InvoiceInfo, status: "succeeded" | "failed") {
  const t = (await db.query("SELECT id FROM tenants WHERE stripe_customer_id = ? LIMIT 1", [inv.customer]))[0];
  if (!t) return;
  await db.exec(
    `INSERT INTO payments (tenant_id, event_id, provider, kind, provider_payment_id, amount_cents, currency, status, hosted_invoice_url)
     VALUES (?, NULL, 'stripe', 'invoice', ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE status = IF(status = 'succeeded', status, VALUES(status)), amount_cents = VALUES(amount_cents), hosted_invoice_url = VALUES(hosted_invoice_url)`,
    [t.id, inv.id, inv.amount_cents, inv.currency.toUpperCase(), status, inv.hosted_invoice_url],
  );
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
    requires_pro: toBool(r.requires_pro),
    wishlist_mode: r.wishlist_mode === "required" || r.wishlist_mode === "optional" ? r.wishlist_mode : "off",
    is_active: toBool(r.is_active),
    sort_order: Number(r.sort_order ?? 0),
  };
}

const EVENT_SELECT = `e.id, e.public_id, e.tenant_id, et.slug AS event_type_slug, et.name_en AS event_type_name, et.name_es AS event_type_name_es, e.name, e.description, e.status,
  e.plan, e.paid_at, e.budget_min, e.budget_max, e.currency, e.exchange_date, e.rsvp_deadline, e.location, e.allow_wishlists, e.drawn_at, e.created_at,
  e.custom_name, e.custom_icon, e.custom_color, e.match_mode, e.theme_rules, e.reveal_mode, et.requires_pro, et.wishlist_mode,
  IF(e.match_mode IS NULL, et.uses_draw, e.match_mode = 'draw') AS uses_draw,
  (SELECT COUNT(*) FROM participants p WHERE p.event_id = e.id AND p.status IN ('invited','joined')) AS participant_count,
  (SELECT COUNT(*) FROM participants p WHERE p.event_id = e.id AND p.status = 'joined') AS joined_count`;

/** Service label for emails/join page: custom name, else the catalog name in the right language. */
function serviceLabel(r: { custom_name?: string | null; event_type_name?: string; event_type_name_es?: string; name_en?: string; name_es?: string }, lang: Lang): string {
  if (r.custom_name) return r.custom_name;
  return lang === "es" ? r.event_type_name_es ?? r.name_es ?? r.event_type_name ?? "" : r.event_type_name ?? r.name_en ?? "";
}

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
    wishlist_mode: r.wishlist_mode === "required" || r.wishlist_mode === "optional" ? r.wishlist_mode : "off",
    participant_count: Number(r.participant_count ?? 0),
    joined_count: Number(r.joined_count ?? 0),
    drawn_at: r.drawn_at ?? null,
    created_at: r.created_at,
    custom: r.custom_name ? { name: r.custom_name, icon: r.custom_icon ?? "sparkles", color: r.custom_color ?? "red" } : null,
    uses_draw: toBool(r.uses_draw),
    theme_rules: r.theme_rules ?? null,
    reveal_mode: r.reveal_mode === "together" ? "together" : "private",
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
    joined_via: r.joined_via === "link" ? "link" : "email",
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
  o: {
    tenantId: number;
    participantId: number;
    email: string;
    organizer: string;
    /** Organizer's email: Reply-To, so invitees can just hit Reply. */
    replyTo?: string | null;
    people?: number | null;
    /** Friendlier "still a spot for you" copy (organizer's Remind button). */
    reminder?: boolean;
    event: { name: string; exchange_date: string | null; budget_min: number | null; budget_max: number | null; currency: string; theme_rules?: string | null };
    typeName: string;
    themeRules?: string | null;
    lang?: Lang;
  },
) {
  const token = crypto.randomBytes(24).toString("base64url");
  await dbx.exec("UPDATE participants SET invite_token_hash = ?, invited_at = UTC_TIMESTAMP() WHERE id = ? AND tenant_id = ?", [sha256(token), o.participantId, o.tenantId]);
  const data = {
    organizer: cleanSubjectText(o.organizer, 60) || "QuickSanta",
    eventName: cleanSubjectText(o.event.name, 80),
    typeName: o.typeName,
    date: o.event.exchange_date,
    budget: budgetLabel(o.event.budget_min, o.event.budget_max, o.event.currency),
    themeRules: o.themeRules ?? o.event.theme_rules ?? null,
    people: o.people ?? null,
    link: `${appUrl()}/join/${token}`,
  };
  const lang = o.lang ?? reqLang(req);
  const tpl = o.reminder ? tplReminder(lang, data) : tplInvite(lang, data);
  const r = await sendEmail({ to: o.email, ...tpl, template: o.reminder ? "reminder" : "invite", tenantId: o.tenantId, replyTo: o.replyTo ?? null });
  // Not delivered: drop the token again so queued sends retry this person.
  if (!r.ok) await dbx.exec("UPDATE participants SET invite_token_hash = NULL WHERE id = ? AND tenant_id = ? AND invite_token_hash = ?", [o.participantId, o.tenantId, sha256(token)]).catch(() => undefined);
  return r.ok;
}

async function loadTenantEvent(tenantId: number, eventId: number) {
  const rows = await db.query(
    `SELECT ${EVENT_SELECT}, t.max_participants_per_event, t.plan AS tenant_plan_raw, t.subscription_status, t.current_period_end, t.past_due_since FROM events e
       JOIN event_types et ON et.id = e.event_type_id JOIN tenants t ON t.id = e.tenant_id
      WHERE e.id = ? AND e.tenant_id = ? LIMIT 1`,
    [eventId, tenantId],
  );
  if (!rows[0]) throw new HttpError(404, "errors.notFound");
  const event = mapEvent(rows[0]);
  const pricing = await pricingInfo();
  rows[0].tenant_plan = effectiveTenantPlan({ plan: rows[0].tenant_plan_raw, subscription_status: rows[0].subscription_status, current_period_end: rows[0].current_period_end, past_due_since: rows[0].past_due_since }, pricing.grace_days);
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

  /** Landing-page Enterprise contact form → contact_requests + email to the platform owners. */
  app.post(
    "/api/contact",
    contactLimiter,
    route(async (req, res) => {
      const body = z
        .object({
          name: z.string().trim().min(2).max(120),
          email: emailSchema,
          company: z.string().trim().max(160).optional().default(""),
          team_size: z.enum(["lt50", "50_100", "100_500", "500_plus"]),
          message: z.string().trim().max(2000).optional().default(""),
          website: z.string().optional().default(""),
        })
        .parse(req.body ?? {});
      // Honeypot filled → a bot. Pretend success so it doesn't retry; store nothing.
      if (body.website.trim()) return void res.status(201).json({ ok: true });
      const ins = await db.exec("INSERT INTO contact_requests (name, email, company, team_size, message, locale, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?)", [
        body.name,
        body.email,
        body.company || null,
        body.team_size,
        body.message || null,
        reqLang(req),
        ipHash(req),
      ]);
      const owners = await db.query("SELECT email FROM users WHERE platform_role = 'owner' AND status = 'active'");
      const tpl = tplLead({ name: body.name, email: body.email, company: body.company || null, teamSize: body.team_size, message: body.message || null, link: `${appUrl()}/admin/leads` });
      for (const o of owners) await sendEmail({ to: String(o.email), ...tpl, template: "contact" }).catch(() => undefined);
      await audit(req, "lead.create", "contact_request", ins.insertId, { meta: { team_size: body.team_size } });
      res.status(201).json({ ok: true });
    }),
  );

  /** Stripe webhook: subscription lifecycle + invoices (signature verified on the raw body). */
  app.post(
    "/api/webhooks/stripe",
    route(async (req, res) => {
      const secret = process.env.STRIPE_WEBHOOK_SECRET;
      const sig = String(req.headers["stripe-signature"] || "");
      const raw = (req as any).rawBody as Buffer | undefined;
      if (!secret || !sig || !raw) throw new HttpError(400, "errors.badSignature");
      let evt: { type: string; data: { object: any } };
      try {
        evt = billingApi().constructWebhookEvent(raw, sig, secret);
      } catch {
        throw new HttpError(400, "errors.badSignature");
      }
      const obj = evt.data.object ?? {};
      try {
      if (evt.type.startsWith("customer.subscription.")) {
        // Re-read from Stripe: event payloads can arrive out of order.
        await syncTenantSubscription(req, await billingApi().getSubscription(String(obj.id)));
      } else if (evt.type === "invoice.paid" || evt.type === "invoice.payment_failed") {
        const inv = await billingApi().getInvoice(String(obj.id));
        await recordInvoice(inv, evt.type === "invoice.paid" ? "succeeded" : "failed");
        if (inv.subscription) await syncTenantSubscription(req, await billingApi().getSubscription(inv.subscription));
      }
      } catch (e: any) {
        // Objects deleted in Stripe (or from another app on a shared account) are acknowledged, not retried forever.
        if (e?.code === "resource_missing" || e?.statusCode === 404) return void res.json({ received: true, ignored: true });
        throw e;
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
      // Reserve the attempt atomically BEFORE comparing, so parallel guesses can't all see "0 attempts".
      const reserved = await db.exec("UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ? AND attempts < ? AND consumed_at IS NULL", [otp.id, OTP_MAX_ATTEMPTS]);
      if (reserved.affectedRows !== 1) throw new HttpError(429, "errors.authLocked");
      const hash = sha256(body.code);
      if (hash !== otp.code_hash) {
        throw new HttpError(400, "errors.otpInvalid", { attempts_left: Math.max(0, OTP_MAX_ATTEMPTS - Number(otp.attempts) - 1) });
      }
      // Atomic consume: two parallel verifies can't both mint a session (the right guess doesn't count as a failure).
      const consumed = await db.exec("UPDATE otp_codes SET consumed_at = UTC_TIMESTAMP(), attempts = GREATEST(attempts - 1, 0) WHERE id = ? AND consumed_at IS NULL AND code_hash = ?", [otp.id, hash]);
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

export const CUSTOM_ICONS = ["sparkles", "gift", "heart", "star", "tree", "music", "coffee", "palette", "book", "cookie", "party", "snowflake"] as const;
export const CUSTOM_COLORS = ["red", "green", "gold", "blue", "purple", "pink", "teal", "slate"] as const;

const DRAFT_TTL_DAYS = 30;
const DRAFT_MAX_BYTES = 64 * 1024;
const WIZARD_DRAFT_STEPS = ["service", "design", "details", "people", "rules", "account", "review"] as const;
const draftSchema = z.object({ step: z.enum(WIZARD_DRAFT_STEPS).default("service"), data: z.record(z.string(), z.unknown()) });

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
  custom: z
    .object({
      name: z.string().trim().min(2).max(80),
      icon: z.enum(CUSTOM_ICONS),
      color: z.enum(CUSTOM_COLORS),
      matchMode: z.enum(["draw", "none"]),
      themeRules: z.string().trim().max(500).optional().default(""),
      revealMode: z.enum(["private", "together"]).default("private"),
    })
    .optional(),
  saveTemplate: z.boolean().default(false),
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
      // "Create your own": the design decides the mechanics; other services ignore any custom payload.
      const custom = type.slug === "custom" ? (input as any).custom ?? null : null;
      if (type.slug === "custom" && !custom) throw new HttpError(400, "validation.customDesign");
      if (custom && custom.matchMode === "none") custom.revealMode = "private"; // nothing to reveal without a draw
      if (custom?.revealMode === "together" && !input.exchangeDate) throw new HttpError(400, "validation.revealNeedsDate");
      const usesDraw = custom ? custom.matchMode === "draw" : type.uses_draw;

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
      const minPeople = usesDraw ? 3 : 1;
      if (people.length < minPeople) throw new HttpError(400, "validation.minParticipants", { min: minPeople });
      // Exclusions reference people by email ("me" = the organizer), so list edits / login can't shift them.
      const indexOf = (ref: string) => people.findIndex((p) => (ref === "me" ? p.isMe : p.email === ref));
      const excl = (usesDraw ? input.exclusions : []).map((x) => ({ a: indexOf(x.a), b: indexOf(x.b), bidirectional: x.bidirectional }));
      for (const x of excl) {
        if (x.a < 0 || x.b < 0 || x.a === x.b) throw new HttpError(400, "validation.exclusion");
      }
      if (usesDraw && !drawAssignments(people.map((_, i) => i + 1), expandExclusions(excl.map((x) => ({ giver: x.a + 1, receiver: x.b + 1, bidirectional: x.bidirectional }))))) {
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
          const lim = await tx.query("SELECT plan, subscription_status, current_period_end, past_due_since, max_events, max_participants_per_event, (SELECT COUNT(*) FROM events WHERE tenant_id = ? AND status NOT IN ('cancelled','completed')) AS active FROM tenants WHERE id = ?", [tenantId, tenantId]);
          if (lim[0] && Number(lim[0].active) >= Number(lim[0].max_events)) throw new HttpError(402, "errors.eventLimit");
          tenantPlan = lim[0] ? effectiveTenantPlan(lim[0], pricing.grace_days) : "free";
          tenantMax = Number(lim[0]?.max_participants_per_event ?? tenantMax);
        }
        const maxParticipants = participantLimit(pricing, plan, tenantPlan, tenantMax);
        if (people.length > maxParticipants) {
          // Free exchange too big → the client offers Pro; Pro too big → Enterprise.
          const needs = plan === "free" && people.length <= participantLimit(pricing, "pro", tenantPlan, tenantMax) ? "errors.needsPro" : "errors.participantLimit";
          throw new HttpError(402, needs, { max: maxParticipants, free_max: pricing.free_max_participants, pro_max: pricing.pro_max_participants });
        }
        // Pro needs an active workspace subscription; Pro/Enterprise workspaces are already covered.
        // Pro-only services (and "Create your own") always need Pro.
        const payNow = (plan === "pro" || type.requires_pro) && tenantPlan === "free";

        const publicId = newPublicId();
        const ev = await tx.exec(
          `INSERT INTO events (public_id, tenant_id, event_type_id, name, custom_name, custom_icon, custom_color, match_mode, theme_rules, reveal_mode, description, status, plan, invites_pending, budget_min, budget_max, currency, exchange_date, rsvp_deadline, location, allow_wishlists, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            publicId, tenantId, type.id, input.name,
            custom?.name ?? null, custom?.icon ?? null, custom?.color ?? null, custom?.matchMode ?? null, custom?.themeRules || null, custom?.revealMode ?? "private",
            input.description || null, payNow ? "pending_payment" : "open", "free", payNow && input.sendInvites ? 1 : 0,
            input.budgetMin ?? null, input.budgetMax ?? null, input.currency, input.exchangeDate ?? null, input.rsvpDeadline ?? null, input.location ?? null, effectiveWishlists(type.wishlist_mode, input.allowWishlists) ? 1 : 0, u.id,
          ],
        );
        if (custom && (input as any).saveTemplate) {
          // Reusable design for this workspace (Pro feature; the exchange itself already requires Pro).
          await tx.exec(
            `INSERT INTO event_templates (tenant_id, created_by, name, icon, color, match_mode, allow_wishlists, budget_min, budget_max, currency, theme_rules, reveal_mode)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE icon = VALUES(icon), color = VALUES(color), match_mode = VALUES(match_mode), allow_wishlists = VALUES(allow_wishlists),
               budget_min = VALUES(budget_min), budget_max = VALUES(budget_max), currency = VALUES(currency), theme_rules = VALUES(theme_rules), reveal_mode = VALUES(reveal_mode)`,
            [tenantId, u.id, custom.name, custom.icon, custom.color, custom.matchMode, effectiveWishlists(type.wishlist_mode, input.allowWishlists) ? 1 : 0, input.budgetMin ?? null, input.budgetMax ?? null, input.currency, custom.themeRules || null, custom.revealMode],
          );
        }
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
            replyTo: u.email,
            people: people.length,
            event: { name: input.name, exchange_date: input.exchangeDate ?? null, budget_min: input.budgetMin ?? null, budget_max: input.budgetMax ?? null, currency: input.currency },
            typeName: custom?.name ?? (reqLang(req) === "es" ? type.name_es : type.name_en),
            themeRules: custom?.themeRules || null,
          });
          if (ok) invited++;
        });
      }
      await audit(req, "event.create", "event", result.eventId, { tenantId: result.tenantId, actorId: u.id, meta: { via: "wizard", participants: people.length, type: type.slug } });
      // The draft became an exchange: drop it (best effort — the 30-day purge is the backstop).
      await db.exec("DELETE FROM wizard_drafts WHERE user_id = ?", [u.id]).catch(() => undefined);
      res.status(201).json({ ok: true, tenant_id: result.tenantId, event_id: result.eventId, event_public_id: result.publicId, invited, payment_required: result.payNow });
    }),
  );

  // ── Drafts: one active wizard draft per signed-in user (signed-out drafts stay in the browser). ──
  // Opaque JSON (the client merges it over an empty draft); never counted toward limits; 30-day expiry.
  app.get(
    "/api/wizard/draft",
    requireAuth(),
    route(async (_req, res) => {
      const rows = await db.query(
        `SELECT step, data, updated_at FROM wizard_drafts WHERE user_id = ? AND updated_at > UTC_TIMESTAMP() - INTERVAL ${DRAFT_TTL_DAYS} DAY LIMIT 1`,
        [authed(res).id],
      );
      const r = rows[0];
      let data: unknown = null;
      try {
        data = r ? (typeof r.data === "string" ? JSON.parse(r.data) : r.data) : null;
      } catch {
        data = null;
      }
      const draft: WizardDraftRecord | null = r && data && typeof data === "object" && !Array.isArray(data) ? { step: r.step, data: data as WizardDraftRecord["data"], updated_at: r.updated_at } : null;
      res.json({ ok: true, draft });
    }),
  );

  app.put(
    "/api/wizard/draft",
    requireAuth(),
    route(async (req, res) => {
      const body = draftSchema.parse(req.body ?? {});
      const json = JSON.stringify(body.data);
      if (json.length > DRAFT_MAX_BYTES) throw new HttpError(413, "errors.draftTooLarge");
      await db.exec(
        "INSERT INTO wizard_drafts (user_id, step, data) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE step = VALUES(step), data = VALUES(data), updated_at = CURRENT_TIMESTAMP",
        [authed(res).id, body.step, json],
      );
      res.json({ ok: true });
    }),
  );

  app.delete(
    "/api/wizard/draft",
    requireAuth(),
    route(async (_req, res) => {
      await db.exec("DELETE FROM wizard_drafts WHERE user_id = ?", [authed(res).id]);
      res.json({ ok: true });
    }),
  );
}


// ── Invite links (shareable link + short code per exchange) ──
/** Unambiguous alphabet (no 0/O/1/I): codes are read aloud and typed from screenshots. 32^8 ≈ 1.1e12. */
const JOIN_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export function newJoinCode(): string {
  const bytes = crypto.randomBytes(8);
  return Array.from(bytes, (b) => JOIN_CODE_ALPHABET[b % 32]).join("");
}
/** "7k4p-qx9m", " 7K4P QX9M " → "7K4PQX9M"; null when it can't be a code. */
export function normalizeJoinCode(raw: string): string | null {
  const c = String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return c.length === 8 && [...c].every((ch) => JOIN_CODE_ALPHABET.includes(ch)) ? c : null;
}
export const formatJoinCode = (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`;
const joinUrl = (c: string) => `${appUrl()}/j/${formatJoinCode(c)}`;
const JOINABLE_STATUSES = new Set(["open"]);
/** "2026-02-31" or "25:99" pass a regex but aren't real: round-trip through Date to be sure (UTC). */
export function isRealUtcDateTime(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
  if (!m) return false;
  const [y, mo, d, h = "0", mi = "0", se = "0"] = m.slice(1);
  const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +se));
  return dt.getUTCFullYear() === +y && dt.getUTCMonth() === +mo - 1 && dt.getUTCDate() === +d && dt.getUTCHours() === +h && dt.getUTCMinutes() === +mi && dt.getUTCSeconds() === +se;
}
const isPast = (utc: string | null | undefined) => Boolean(utc) && Date.parse(`${String(utc).replace(" ", "T")}Z`) <= Date.now();

/** Why the link can (not) be used right now, in priority order. */
export function inviteLinkState(o: { enabled: boolean; status: string; expires_at: string | null; max: number | null; joined_via_link: number; seats_left: number }): InviteLinkState {
  if (!JOINABLE_STATUSES.has(o.status)) return "closed";
  if (!o.enabled) return "off";
  if (isPast(o.expires_at)) return "expired";
  if (o.seats_left <= 0 || (o.max != null && o.joined_via_link >= o.max)) return "full";
  return "active";
}

/** New unique code for this exchange (retries on the unique key; collisions are astronomically rare). */
async function assignJoinCode(tenantId: number, eventId: number): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const code = newJoinCode();
    try {
      await db.exec("UPDATE events SET join_code = ? WHERE id = ? AND tenant_id = ?", [code, eventId, tenantId]);
      return code;
    } catch (e: any) {
      if (e?.code !== "ER_DUP_ENTRY") throw e;
    }
  }
  throw new HttpError(500, "errors.server");
}

async function inviteLinkInfo(tenantId: number, eventId: number): Promise<InviteLinkInfo> {
  const { event, row, maxParticipants } = await loadTenantEvent(tenantId, eventId);
  const [r] = await db.query(
    "SELECT e.join_code, e.join_enabled, e.join_max, e.join_expires_at, (SELECT COUNT(*) FROM participants p WHERE p.event_id = e.id AND p.joined_via = 'link' AND p.status IN ('invited','joined')) AS via_link FROM events e WHERE e.id = ? AND e.tenant_id = ?",
    [eventId, tenantId],
  );
  void row;
  const info = {
    enabled: toBool(r?.join_enabled),
    code: r?.join_code ? formatJoinCode(r.join_code) : null,
    url: r?.join_code ? joinUrl(r.join_code) : null,
    max: r?.join_max == null ? null : Number(r.join_max),
    expires_at: r?.join_expires_at ?? null,
    joined_via_link: Number(r?.via_link ?? 0),
    seats_left: Math.max(0, maxParticipants - event.participant_count),
  };
  return { ...info, state: inviteLinkState({ ...info, status: event.status }) };
}

function registerJoinRoutes(app: express.Express) {
  const findInvite = async (token: string) => {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw new HttpError(404, "errors.inviteInvalid");
    const rows = await db.query(
      `SELECT p.id, p.tenant_id, p.event_id, p.name, p.email, p.status, e.name AS event_name, e.status AS event_status, e.exchange_date,
              e.budget_min, e.budget_max, e.currency, e.public_id AS event_public_id, e.custom_name, e.theme_rules, et.name_en, et.name_es, t.name AS tenant_name, t.status AS tenant_status
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
          type_name: serviceLabel(r, reqLang(req)),
          theme_rules: r.theme_rules ?? null,
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
      if (accept && r.event_status === "drawn") {
        // Only people who were part of the draw can still join (they have a match waiting).
        const inDraw = await db.query("SELECT id FROM assignments WHERE event_id = ? AND giver_participant_id = ? LIMIT 1", [r.event_id, r.id]);
        if (!inDraw[0]) throw new HttpError(409, "errors.alreadyDrawn");
      }
      if (accept && r.status === "declined") {
        // A decliner coming back takes a seat again: respect the plan limit.
        const { event, maxParticipants } = await loadTenantEvent(Number(r.tenant_id), Number(r.event_id));
        if (event.participant_count + 1 > maxParticipants) throw new HttpError(402, "errors.participantLimit", { max: maxParticipants });
      }
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

  // ── Join with the exchange's shareable link / code ──
  const findByCode = async (raw: string) => {
    const code = normalizeJoinCode(raw);
    if (!code) throw new HttpError(404, "errors.joinCodeInvalid");
    const rows = await db.query(
      `SELECT e.id, e.tenant_id, e.public_id, e.name, e.status, e.exchange_date, e.budget_min, e.budget_max, e.currency, e.theme_rules, e.custom_name,
              e.join_enabled, e.join_max, e.join_expires_at, e.created_by, et.name_en, et.name_es, t.name AS tenant_name, t.status AS tenant_status, u.full_name AS organizer, u.email AS organizer_email, u.locale AS organizer_locale,
              (SELECT COUNT(*) FROM participants p WHERE p.event_id = e.id AND p.status IN ('invited','joined')) AS people,
              (SELECT COUNT(*) FROM participants p WHERE p.event_id = e.id AND p.joined_via = 'link' AND p.status IN ('invited','joined')) AS via_link
         FROM events e JOIN event_types et ON et.id = e.event_type_id JOIN tenants t ON t.id = e.tenant_id LEFT JOIN users u ON u.id = e.created_by
        WHERE e.join_code = ? LIMIT 1`,
      [code],
    );
    const r = rows[0];
    // A regenerated (old) code, a cancelled exchange or a suspended workspace look the same as a wrong code.
    if (!r || r.status === "cancelled" || r.tenant_status !== "active") throw new HttpError(404, "errors.joinCodeInvalid");
    return { code, r };
  };
  const previewState = async (r: any): Promise<JoinCodePreview["state"]> => {
    if (!toBool(r.join_enabled)) return "paused";
    const { maxParticipants } = await loadTenantEvent(Number(r.tenant_id), Number(r.id));
    const st = inviteLinkState({ enabled: true, status: r.status, expires_at: r.join_expires_at, max: r.join_max == null ? null : Number(r.join_max), joined_via_link: Number(r.via_link), seats_left: maxParticipants - Number(r.people) });
    return st === "active" ? "open" : (st as JoinCodePreview["state"]);
  };

  app.get(
    "/api/join-code/:code",
    joinCodeLimiter,
    route(async (req, res) => {
      const { r } = await findByCode(String(req.params.code));
      // Link turned off (e.g. it leaked): say so, but reveal nothing about the exchange.
      if (!toBool(r.join_enabled)) throw new HttpError(404, "errors.joinPaused");
      const u = await loadSessionUser(req).catch(() => null);
      const mine = u ? (await db.query("SELECT status FROM participants WHERE event_id = ? AND email = ? LIMIT 1", [r.id, u.email]))[0] : null;
      const preview: JoinCodePreview = {
        event_name: r.name,
        type_name: serviceLabel(r, reqLang(req)),
        tenant_name: r.tenant_name,
        organizer: r.organizer ?? r.tenant_name,
        exchange_date: r.exchange_date ?? null,
        budget: budgetLabel(toNum(r.budget_min), toNum(r.budget_max), r.currency),
        theme_rules: r.theme_rules ?? null,
        people: Number(r.people),
        state: await previewState(r),
        my_status: mine?.status ?? null,
        // Only someone already in the exchange gets the link to it.
        event_public_id: mine && mine.status === "joined" ? r.public_id : null,
      };
      res.json({ ok: true, preview });
    }),
  );

  app.post(
    "/api/join-code/:code",
    joinCodeLimiter,
    requireAuth(),
    route(async (req, res) => {
      const u = authed(res);
      const body = z.object({ name: z.string().trim().min(1).max(120).optional() }).parse(req.body ?? {});
      const { code, r } = await findByCode(String(req.params.code));
      const tenantId = Number(r.tenant_id);
      const eventId = Number(r.id);
      const { maxParticipants } = await loadTenantEvent(tenantId, eventId);
      const name = cleanSubjectText(body.name || (u.full_name && !u.full_name.includes("@") ? u.full_name : "") || u.email.split("@")[0], 120) || u.email.split("@")[0];

      const out = await db.tx(async (tx) => {
        // Serialize joins on this exchange (cap + plan limit are checked against a locked, fresh count).
        const [ev] = await tx.query("SELECT id, status, join_enabled, join_max, join_expires_at FROM events WHERE id = ? AND join_code = ? FOR UPDATE", [eventId, code]);
        if (!ev) throw new HttpError(404, "errors.joinCodeInvalid");
        const [mine] = await tx.query("SELECT id, status, user_id FROM participants WHERE event_id = ? AND email = ? LIMIT 1 FOR UPDATE", [eventId, u.email]);
        if (mine?.status === "joined") return { id: Number(mine.id), already: true };
        if (mine?.status === "removed") throw new HttpError(403, "errors.joinRemoved");
        if (!toBool(ev.join_enabled)) throw new HttpError(409, "errors.joinPaused");
        if (ev.status === "drawn" || ev.status === "completed") throw new HttpError(409, "errors.joinClosed");
        if (!JOINABLE_STATUSES.has(ev.status)) throw new HttpError(409, "errors.joinClosed");
        if (isPast(ev.join_expires_at)) throw new HttpError(409, "errors.joinExpired");
        // Locking read: TiDB/MySQL repeatable-read would otherwise count from this transaction's start snapshot,
        // so racing joins (serialized by the event lock above) could all see the old count and overfill.
        const seats = await tx.query("SELECT status, joined_via FROM participants WHERE event_id = ? FOR UPDATE", [eventId]);
        const active = seats.filter((p) => p.status === "invited" || p.status === "joined");
        const c = { people: active.length, via_link: active.filter((p) => p.joined_via === "link").length };
        // An already-invited person (by email) takes no new seat; everyone else does.
        const takesSeat = !mine || mine.status === "declined";
        if (takesSeat && Number(c?.people ?? 0) + 1 > maxParticipants) throw new HttpError(409, "errors.joinFull");
        if (!mine && ev.join_max != null && Number(c?.via_link ?? 0) >= Number(ev.join_max)) throw new HttpError(409, "errors.joinFull");
        let pid: number;
        if (mine) {
          await tx.exec("UPDATE participants SET user_id = ?, status = 'joined', joined_at = COALESCE(joined_at, UTC_TIMESTAMP()) WHERE id = ?", [u.id, mine.id]);
          pid = Number(mine.id);
        } else {
          const ins = await tx.exec(
            "INSERT INTO participants (public_id, tenant_id, event_id, user_id, name, email, status, joined_via, joined_at) VALUES (?, ?, ?, ?, ?, ?, 'joined', 'link', UTC_TIMESTAMP())",
            [newPublicId(), tenantId, eventId, u.id, name, u.email],
          );
          pid = ins.insertId;
        }
        await tx.exec("INSERT IGNORE INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, 'participant')", [tenantId, u.id]);
        await tx.exec("UPDATE tenant_members SET status = 'active', role = 'participant' WHERE tenant_id = ? AND user_id = ? AND status = 'removed'", [tenantId, u.id]);
        return { id: pid, already: false };
      });

      if (!out.already) {
        await db.exec("UPDATE user_sessions SET active_tenant_id = ? WHERE id = ?", [tenantId, u.session_id]);
        await audit(req, "participant.join_link", "participant", out.id, { tenantId, actorId: u.id, meta: { event_id: eventId } });
        // Tell the organizer (not when they join their own exchange).
        if (r.organizer_email && r.organizer_email !== u.email) {
          const lang: Lang = r.organizer_locale === "es" ? "es" : "en";
          const tpl = tplLinkJoined(lang, { who: cleanSubjectText(name, 40), email: u.email, eventName: cleanSubjectText(r.name, 60), people: Number(r.people) + 1, link: `${appUrl()}/app/events/${eventId}` });
          await sendEmail({ to: r.organizer_email, ...tpl, template: "link_joined", tenantId }).catch(() => undefined);
        }
      }
      res.json({ ok: true, status: "joined", already: out.already, tenant_id: tenantId, event_public_id: r.public_id });
    }),
  );
}

const EVENT_GRID: GridSpec = {
  sortMap: { id: "e.id", name: "e.name", exchange_date: "e.exchange_date", status: "e.status", created_at: "e.created_at" },
  defaultSort: "created_at",
  filters: { status: { column: "e.status", values: ["pending_payment", "draft", "open", "drawn", "completed", "cancelled"] }, type: { column: "et.slug", values: [] } },
  search: ["e.name", "e.location"],
};

const PARTICIPANT_GRID: GridSpec = {
  sortMap: { id: "p.id", name: "p.name", email: "p.email", status: "p.status", joined_at: "p.joined_at", created_at: "p.created_at" },
  defaultSort: "name",
  defaultDir: "ASC",
  filters: { status: { column: "p.status", values: ["invited", "joined", "declined", "removed"] }, joined_via: { column: "p.joined_via", values: ["email", "link"] } },
  search: ["p.name", "p.email"],
};

const eventPatchSchema = z.object({
  name: z.string().trim().min(2).max(140).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  exchange_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  rsvp_deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  budget_min: z.number().min(0).max(1_000_000).nullable().optional(),
  budget_max: z.number().min(0).max(1_000_000).nullable().optional(),
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
      // Fixed services: can't enable on "off" or disable on "required" (legacy "off" events may still switch theirs off).
      if (body.allow_wishlists !== undefined && ((event.wishlist_mode === "off" && body.allow_wishlists) || (event.wishlist_mode === "required" && !body.allow_wishlists))) {
        throw new HttpError(400, "errors.wishlistsFixed");
      }
      // "Reveal together" exchanges always keep a date (clearing it would reveal every match at once).
      if (event.reveal_mode === "together" && body.exchange_date === null) throw new HttpError(400, "validation.revealNeedsDate");
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

  // ── Remind everyone who hasn't joined yet (once per exchange per day). ──
  app.post(
    "/api/app/events/:id/remind",
    writeLimiter,
    requireTenant("participants.manage"),
    route(async (req, res) => {
      const { tenant_id } = tenantCtx(res);
      const u = authed(res);
      const eventId = parseId(req.params.id);
      const { event, row } = await loadTenantEvent(tenant_id, eventId);
      if (event.status === "pending_payment") throw new HttpError(409, "errors.paymentRequired");
      if (event.status !== "open") throw new HttpError(409, event.status === "drawn" ? "errors.alreadyDrawn" : "errors.eventClosed");
      const pending = await db.query("SELECT id, email FROM participants WHERE event_id = ? AND tenant_id = ? AND status = 'invited'", [eventId, tenant_id]);
      if (!pending.length) throw new HttpError(400, "errors.nobodyToRemind");
      const today = new Date().toISOString().slice(0, 10);
      if (!(await claimNotice("remind", `${eventId}:${today}`, tenant_id))) throw new HttpError(429, "errors.remindedToday");
      const lang = reqLang(req);
      let reminded = 0;
      await inBatches(pending, 8, async (p) => {
        const ok = await sendInvite(req, db, {
          tenantId: tenant_id,
          participantId: Number(p.id),
          email: String(p.email),
          organizer: u.full_name,
          replyTo: u.email,
          people: event.participant_count,
          reminder: true,
          event,
          typeName: serviceLabel(row, lang),
        });
        if (ok) reminded++;
      });
      await audit(req, "participant.remind", "event", eventId, { tenantId: tenant_id, actorId: u.id, meta: { pending: pending.length, reminded } });
      res.json({ ok: true, reminded, pending: pending.length });
    }),
  );

  // ── Invite link (organizer): on/off, optional cap + expiry, regenerate. Free on every plan. ──
  app.get(
    "/api/app/events/:id/invite-link",
    requireTenant("participants.manage"),
    route(async (req, res) => {
      res.json({ ok: true, link: await inviteLinkInfo(tenantCtx(res).tenant_id, parseId(req.params.id)) });
    }),
  );

  app.put(
    "/api/app/events/:id/invite-link",
    writeLimiter,
    requireTenant("participants.manage"),
    route(async (req, res) => {
      const { tenant_id } = tenantCtx(res);
      const eventId = parseId(req.params.id);
      const body = z
        .object({
          enabled: z.boolean().optional(),
          max: z.number().int().min(1).max(1000).nullable().optional(),
          expires_at: z.string().regex(/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/).nullable().optional(),
        })
        .parse(req.body ?? {});
      const { event } = await loadTenantEvent(tenant_id, eventId);
      if (body.enabled && ["drawn", "completed", "cancelled"].includes(event.status)) throw new HttpError(409, "errors.joinClosed");
      // A date alone means "through the end of that day (UTC)".
      const expires = body.expires_at == null ? body.expires_at : body.expires_at.length === 10 ? `${body.expires_at} 23:59:59` : body.expires_at;
      if (expires && !isRealUtcDateTime(expires)) throw new HttpError(400, "validation.date");
      if (expires && isPast(expires)) throw new HttpError(400, "validation.expiryPast");
      const [cur] = await db.query("SELECT join_code FROM events WHERE id = ? AND tenant_id = ?", [eventId, tenant_id]);
      if (body.enabled && !cur?.join_code) await assignJoinCode(tenant_id, eventId);
      const sets: string[] = [];
      const vals: unknown[] = [];
      if (body.enabled !== undefined) (sets.push("join_enabled = ?"), vals.push(body.enabled ? 1 : 0));
      if (body.max !== undefined) (sets.push("join_max = ?"), vals.push(body.max));
      if (expires !== undefined) (sets.push("join_expires_at = ?"), vals.push(expires));
      if (sets.length) await db.exec(`UPDATE events SET ${sets.join(", ")} WHERE id = ? AND tenant_id = ?`, [...vals, eventId, tenant_id]);
      await audit(req, "event.invite_link", "event", eventId, { tenantId: tenant_id, actorId: authed(res).id, meta: body });
      res.json({ ok: true, link: await inviteLinkInfo(tenant_id, eventId) });
    }),
  );

  app.post(
    "/api/app/events/:id/invite-link/regenerate",
    writeLimiter,
    requireTenant("participants.manage"),
    route(async (req, res) => {
      const { tenant_id } = tenantCtx(res);
      const eventId = parseId(req.params.id);
      await loadTenantEvent(tenant_id, eventId);
      await assignJoinCode(tenant_id, eventId); // the old link/code stops working immediately
      await audit(req, "event.invite_link_regenerate", "event", eventId, { tenantId: tenant_id, actorId: authed(res).id });
      res.json({ ok: true, link: await inviteLinkInfo(tenant_id, eventId) });
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
      // One transaction with the event row locked: serializes against invite-link joins and other adds, and
      // counts with a locking read (a plain SELECT would read the start snapshot and let concurrent adds overfill).
      const { added, toInvite } = await db.tx(async (tx) => {
        const [ev] = await tx.query("SELECT status FROM events WHERE id = ? AND tenant_id = ? FOR UPDATE", [eventId, tenant_id]);
        if (!ev) throw new HttpError(404, "errors.notFound");
        if (ev.status === "drawn") throw new HttpError(409, "errors.alreadyDrawn");
        if (ev.status === "cancelled" || ev.status === "completed") throw new HttpError(409, "errors.eventClosed");
        const activeRows = await tx.query("SELECT email FROM participants WHERE event_id = ? AND tenant_id = ? AND status IN ('invited','joined') FOR UPDATE", [eventId, tenant_id]);
        const active = new Set(activeRows.map((r) => String(r.email)));
        const incoming = uniq.filter((p) => !active.has(p.email));
        const total = active.size + incoming.length;
        if (total > maxParticipants) {
          const canUpgrade = event.plan === "free" && row.tenant_plan !== "enterprise" && total <= pricing.pro_max_participants;
          throw new HttpError(402, canUpgrade ? "errors.needsPro" : "errors.participantLimit", { max: maxParticipants, free_max: pricing.free_max_participants, pro_max: pricing.pro_max_participants });
        }
        let added = 0;
        const toInvite: Array<{ id: number; email: string }> = [];
        for (const p of incoming) {
          // New email → insert; previously removed/declined → back to invited by email (unique event+email).
          // joined_via is assigned before status so it still sees the old status.
          await tx.exec(
            `INSERT INTO participants (public_id, tenant_id, event_id, name, email) VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE name = VALUES(name), joined_via = IF(status IN ('removed','declined'), 'email', joined_via),
               status = IF(status IN ('removed','declined'), 'invited', status), joined_at = IF(status = 'invited', NULL, joined_at)`,
            [newPublicId(), tenant_id, eventId, p.name, p.email],
          );
          const row2 = (await tx.query("SELECT id FROM participants WHERE event_id = ? AND tenant_id = ? AND email = ? LIMIT 1", [eventId, tenant_id, p.email]))[0];
          if (!row2) continue;
          added++;
          toInvite.push({ id: Number(row2.id), email: p.email });
        }
        return { added, toInvite };
      });
      let invited = 0;
      if (body.send_invites && event.status === "pending_payment") {
        // Not paid yet: queue the invites; they go out when the workspace subscribes.
        if (toInvite.length) await db.exec("UPDATE events SET invites_pending = 1 WHERE id = ? AND tenant_id = ?", [eventId, tenant_id]);
      } else if (body.send_invites) {
        const lang = reqLang(req);
        await inBatches(toInvite, 8, async (p) => {
          if (await sendInvite(req, db, { tenantId: tenant_id, participantId: p.id, email: p.email, organizer: u.full_name, replyTo: u.email, event, typeName: serviceLabel(row, lang) })) invited++;
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
      const { event, maxParticipants, pricing, row } = await loadTenantEvent(tenant_id, eventId);
      if (body.status && event.status === "drawn") throw new HttpError(409, "errors.alreadyDrawn");
      if (body.status && (event.status === "cancelled" || event.status === "completed")) throw new HttpError(409, "errors.eventClosed");
      const sets: string[] = [];
      const params: unknown[] = [];
      if (body.name) (sets.push("name = ?"), params.push(body.name));
      // Re-invited by the organizer = an email invite now (frees the invite link's cap); before `status` so it sees the old value.
      if (body.status === "invited") sets.push("joined_via = IF(status IN ('removed','declined'), 'email', joined_via)");
      if (body.status) (sets.push("status = ?"), params.push(body.status));
      if (!sets.length) return void res.json({ ok: true });
      const r = await db.tx(async (tx) => {
        if (body.status === "invited") {
          // Re-inviting a removed/declined person takes a seat: lock the event and count with a locking read
          // (serialized against invite-link joins and adds; a plain SELECT would read a stale snapshot).
          await tx.query("SELECT id FROM events WHERE id = ? AND tenant_id = ? FOR UPDATE", [eventId, tenant_id]);
          const cur = (await tx.query("SELECT status FROM participants WHERE id = ? AND event_id = ? AND tenant_id = ? FOR UPDATE", [pid, eventId, tenant_id]))[0];
          if (cur && !["invited", "joined"].includes(cur.status)) {
            const seats = (await tx.query("SELECT id FROM participants WHERE event_id = ? AND tenant_id = ? AND status IN ('invited','joined') FOR UPDATE", [eventId, tenant_id])).length;
            if (seats + 1 > maxParticipants) {
              const canUpgrade = row.tenant_plan === "free" && seats + 1 <= pricing.pro_max_participants;
              throw new HttpError(402, canUpgrade ? "errors.needsPro" : "errors.participantLimit", { max: maxParticipants, free_max: pricing.free_max_participants, pro_max: pricing.pro_max_participants });
            }
          }
        }
        return tx.exec(`UPDATE participants SET ${sets.join(", ")} WHERE id = ? AND event_id = ? AND tenant_id = ?`, [...params, pid, eventId, tenant_id]);
      });
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
      const { event, row } = await loadTenantEvent(tenant_id, eventId);
      if (event.status === "pending_payment") throw new HttpError(402, "errors.paymentRequired");
      const rows = await db.query("SELECT id, email, status FROM participants WHERE id = ? AND event_id = ? AND tenant_id = ?", [pid, eventId, tenant_id]);
      if (!rows[0]) throw new HttpError(404, "errors.notFound");
      if (rows[0].status === "removed") throw new HttpError(409, "errors.participantRemoved");
      const ok = await sendInvite(req, db, { tenantId: tenant_id, participantId: pid, email: rows[0].email, organizer: authed(res).full_name, replyTo: authed(res).email, event, typeName: serviceLabel(row, reqLang(req)) });
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
        // The draw also switches the invite link off: resetting the draw never silently re-opens a shared link.
        const locked = await tx.exec("UPDATE events SET status = 'drawn', drawn_at = UTC_TIMESTAMP(), join_enabled = 0 WHERE id = ? AND tenant_id = ? AND status = 'open'", [eventId, tenant_id]);
        if (locked.affectedRows !== 1) throw new HttpError(409, "errors.alreadyDrawn");
        // Locking reads (FOR UPDATE): under TiDB/MySQL repeatable-read a plain SELECT here would read this
        // transaction's start snapshot and miss someone who joined (invite link) while we waited for the lock above.
        const people = await tx.query(
          `SELECT id, email, user_id, status FROM participants WHERE event_id = ? AND tenant_id = ? AND status IN (${includeInvited ? "'invited','joined'" : "'joined'"}) FOR UPDATE`,
          [eventId, tenant_id],
        );
        if (people.length < 3) throw new HttpError(400, "validation.minParticipants", { min: 3 });
        const excl = await tx.query("SELECT giver_participant_id, receiver_participant_id, bidirectional FROM exclusions WHERE event_id = ? AND tenant_id = ? FOR UPDATE", [eventId, tenant_id]);
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
      const tpl = tplAssignment(reqLang(req), { eventName: event.name, link, revealOn: event.reveal_mode === "together" ? event.exchange_date : null, wishlists: event.allow_wishlists });
      const { row: evRow } = await loadTenantEvent(tenant_id, eventId);
      const organizer = authed(res).full_name;
      await inBatches(people, 10, async (p) => {
        // Joined people go straight to their match; invited-but-not-joined get a fresh join link
        // (the match page needs a joined account, so a plain draw email would lead to a 404).
        const ok =
          p.status === "joined"
            ? (await sendEmail({ to: p.email, ...tpl, template: "assignment", tenantId: tenant_id })).ok
            : await sendInvite(req, db, { tenantId: tenant_id, participantId: Number(p.id), email: p.email, organizer, replyTo: authed(res).email, event, typeName: serviceLabel(evRow, reqLang(req)) });
        if (ok) notified++;
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
        // Status guard inside the transaction: a completed exchange can never be reopened by a racing reset.
        const r = await tx.exec("UPDATE events SET status = 'open', drawn_at = NULL WHERE id = ? AND tenant_id = ? AND status = 'drawn'", [eventId, tenant_id]);
        if (r.affectedRows !== 1) throw new HttpError(409, "errors.notDrawn");
        await tx.exec("DELETE FROM assignments WHERE event_id = ? AND tenant_id = ?", [eventId, tenant_id]);
      });
      await audit(req, "event.reset_draw", "event", eventId, { tenantId: tenant_id, actorId: authed(res).id });
      res.json({ ok: true });
    }),
  );


  // ── Billing: Pro subscription per workspace (organizers only) ──
  const loadBillingTenant = async (tenantId: number) => {
    const t = (await db.query(
      `SELECT id, name, plan, locale, stripe_customer_id, stripe_subscription_id, subscription_status, current_period_end, past_due_since, cancel_at_period_end,
              cancel_reason, save_offer_used_at, card_brand, card_last4, card_exp, max_participants_per_event
         FROM tenants WHERE id = ?`,
      [tenantId],
    ))[0];
    if (!t) throw new HttpError(404, "errors.notFound");
    return t;
  };

  app.get(
    "/api/app/billing",
    requireTenant("members.manage", { allowSuspended: true }),
    route(async (_req, res) => {
      const { tenant_id } = tenantCtx(res);
      const t = await loadBillingTenant(tenant_id);
      const pricing = await pricingInfo();
      const usage = (await db.query(
        `SELECT COUNT(*) AS events, COALESCE(MAX((SELECT COUNT(*) FROM participants p WHERE p.event_id = e.id AND p.status IN ('invited','joined'))), 0) AS largest,
                SUM(e.status = 'pending_payment') AS pending
           FROM events e WHERE e.tenant_id = ? AND e.status NOT IN ('cancelled','completed')`,
        [tenant_id],
      ))[0] ?? {};
      let invoices: InvoiceInfo[] = [];
      if (t.stripe_customer_id) {
        try {
          invoices = (await billingApi().listInvoices(t.stripe_customer_id)).filter((i) => i.status !== "draft");
        } catch (e) {
          if (!(e instanceof HttpError)) throw e;
        }
      }
      const effective = effectiveTenantPlan(t, pricing.grace_days);
      const out: BillingOverview = {
        plan: effective,
        status: t.subscription_status,
        current_period_end: t.current_period_end ?? null,
        cancel_at_period_end: toBool(t.cancel_at_period_end),
        save_offer_available: !t.save_offer_used_at && pricing.save_offer_percent > 0 && ["active", "trialing"].includes(t.subscription_status),
        card: t.card_last4 ? { brand: t.card_brand, last4: t.card_last4, exp: t.card_exp } : null,
        pricing,
        usage: { events: Number(usage.events ?? 0), largest: Number(usage.largest ?? 0), pending: Number(usage.pending ?? 0), limit: participantLimit(pricing, "free", effective, Number(t.max_participants_per_event)) },
        invoices: invoices.map((i) => ({ id: i.id, number: i.number, status: i.status, amount_cents: i.amount_cents, currency: i.currency, created: i.created, hosted_invoice_url: i.hosted_invoice_url, invoice_pdf: i.invoice_pdf })),
      };
      res.json({ ok: true, ...out });
    }),
  );

  /** Start (or resume an unfinished) Pro subscription; returns the client secret of its first invoice. */
  app.post(
    "/api/app/billing/subscribe",
    writeLimiter,
    requireTenant("members.manage"),
    route(async (req, res) => {
      const { tenant_id } = tenantCtx(res);
      const u = authed(res);
      const t = await loadBillingTenant(tenant_id);
      if (t.plan === "enterprise") throw new HttpError(409, "errors.alreadyPro");
      const api = billingApi();
      const price = priceId();
      let customer = t.stripe_customer_id as string | null;
      if (!customer) {
        customer = await api.createCustomer({ email: u.email, name: t.name, tenantId: tenant_id });
        await db.exec("UPDATE tenants SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL", [customer, tenant_id]);
      }
      if (t.stripe_subscription_id) {
        const cur = await api.getSubscription(t.stripe_subscription_id);
        if (["active", "trialing", "past_due"].includes(cur.status)) {
          await syncTenantSubscription(req, cur);
          throw new HttpError(409, "errors.alreadyPro");
        }
        if (cur.status === "incomplete" && cur.client_secret) {
          return void res.json({ ok: true, client_secret: cur.client_secret, subscription_id: cur.id });
        }
      }
      // Same key for concurrent clicks (Stripe returns the same subscription); a new attempt after the previous one ended gets a new key.
      const sub = await api.createSubscription({ customer, price, tenantId: tenant_id, idempotencyKey: `qs-sub-${tenant_id}-${t.stripe_subscription_id ?? "first"}` });
      await db.exec("UPDATE tenants SET stripe_subscription_id = ?, subscription_status = ? WHERE id = ?", [sub.id, sub.status, tenant_id]);
      await audit(req, "billing.subscribe_started", "tenant", tenant_id, { tenantId: tenant_id, actorId: u.id });
      if (!sub.client_secret) throw new HttpError(502, "errors.paymentsUnavailable");
      res.json({ ok: true, client_secret: sub.client_secret, subscription_id: sub.id });
    }),
  );

  /** Called by the client right after Stripe confirms; webhooks do the same in the background. */
  app.post(
    "/api/app/billing/sync",
    writeLimiter,
    requireTenant("members.manage", { allowSuspended: true }),
    route(async (req, res) => {
      const { tenant_id } = tenantCtx(res);
      const t = await loadBillingTenant(tenant_id);
      if (!t.stripe_subscription_id) throw new HttpError(404, "errors.notFound");
      const sub = await billingApi().getSubscription(t.stripe_subscription_id);
      if (sub.customer !== t.stripe_customer_id) throw new HttpError(400, "errors.paymentMismatch");
      const synced = await syncTenantSubscription(req, sub);
      if (sub.status === "active" && synced?.changed) await audit(req, "billing.subscribed", "tenant", tenant_id, { tenantId: tenant_id, actorId: authed(res).id });
      res.json({ ok: true, status: sub.status, plan: planFromSubscriptionStatus(sub.status) });
    }),
  );

  app.post(
    "/api/app/billing/payment-method/setup",
    writeLimiter,
    requireTenant("members.manage", { allowSuspended: true }),
    route(async (_req, res) => {
      const t = await loadBillingTenant(tenantCtx(res).tenant_id);
      if (!t.stripe_customer_id) throw new HttpError(409, "errors.noSubscription");
      res.json({ ok: true, ...(await billingApi().createSetupIntent(t.stripe_customer_id)) });
    }),
  );

  app.post(
    "/api/app/billing/payment-method",
    writeLimiter,
    requireTenant("members.manage", { allowSuspended: true }),
    route(async (req, res) => {
      const { tenant_id } = tenantCtx(res);
      const pm = z.string().regex(/^pm_[A-Za-z0-9_]{6,}$/).parse(req.body?.payment_method_id);
      const t = await loadBillingTenant(tenant_id);
      if (!t.stripe_customer_id) throw new HttpError(409, "errors.noSubscription");
      const api = billingApi();
      const card = await api.setDefaultPaymentMethod(t.stripe_customer_id, pm);
      if (t.stripe_subscription_id) await api.updateSubscription(t.stripe_subscription_id, { default_payment_method: pm });
      await db.exec("UPDATE tenants SET card_brand = ?, card_last4 = ?, card_exp = ? WHERE id = ?", [card.brand, card.last4, card.exp, tenant_id]);
      // A failed renewal is retried right away with the new card.
      let retried: string | null = null;
      if (t.subscription_status === "past_due" && t.stripe_subscription_id) {
        const sub = await api.getSubscription(t.stripe_subscription_id);
        if (sub.latest_invoice_id) {
          retried = await api.payInvoice(sub.latest_invoice_id).catch(() => "failed");
          await syncTenantSubscription(req, await api.getSubscription(t.stripe_subscription_id));
        }
      }
      await audit(req, "billing.card_updated", "tenant", tenant_id, { tenantId: tenant_id, actorId: authed(res).id, meta: { brand: card.brand, last4: card.last4 } });
      res.json({ ok: true, card, retried });
    }),
  );

  const cancelSchema = z.object({
    reason: z.enum(["too_expensive", "only_once", "missing_features", "too_complex", "switching", "other"]).default("other"),
    feedback: z.string().trim().max(1000).optional().default(""),
    confirm_name: z.string().trim().max(120),
  });

  /** Retention offer: one-time % off the next invoice (once per workspace). */
  app.post(
    "/api/app/billing/save-offer",
    writeLimiter,
    requireTenant("members.manage"),
    route(async (req, res) => {
      const { tenant_id } = tenantCtx(res);
      const t = await loadBillingTenant(tenant_id);
      const pricing = await pricingInfo();
      // Only for healthy subscriptions: the coupon discounts the NEXT invoice, not an unpaid one.
      if (!t.stripe_subscription_id || !["active", "trialing"].includes(t.subscription_status)) throw new HttpError(409, "errors.noSubscription");
      if (t.save_offer_used_at || !pricing.save_offer_percent) throw new HttpError(409, "errors.offerUsed");
      const claimed = await db.exec("UPDATE tenants SET save_offer_used_at = UTC_TIMESTAMP() WHERE id = ? AND save_offer_used_at IS NULL", [tenant_id]);
      if (claimed.affectedRows !== 1) throw new HttpError(409, "errors.offerUsed");
      const api = billingApi();
      let sub: SubscriptionInfo;
      try {
        const coupon = await api.ensureCoupon(pricing.save_offer_percent);
        sub = await api.updateSubscription(t.stripe_subscription_id, { coupon, cancel_at_period_end: false });
      } catch (e) {
        // Stripe failed: give the offer back.
        await db.exec("UPDATE tenants SET save_offer_used_at = NULL WHERE id = ?", [tenant_id]);
        throw e;
      }
      await syncTenantSubscription(req, sub);
      await audit(req, "billing.save_offer_accepted", "tenant", tenant_id, { tenantId: tenant_id, actorId: authed(res).id, meta: { percent: pricing.save_offer_percent } });
      res.json({ ok: true, percent: pricing.save_offer_percent });
    }),
  );

  app.post(
    "/api/app/billing/cancel",
    writeLimiter,
    requireTenant("members.manage", { allowSuspended: true }),
    route(async (req, res) => {
      const { tenant_id } = tenantCtx(res);
      const body = cancelSchema.parse(req.body ?? {});
      const t = await loadBillingTenant(tenant_id);
      if (!t.stripe_subscription_id || !["active", "trialing", "past_due"].includes(t.subscription_status)) throw new HttpError(409, "errors.noSubscription");
      // Confirmation "puzzle": type the workspace name (case/space-insensitive).
      const norm = (v: string) => v.toLowerCase().replace(/\s+/g, " ").trim();
      if (norm(body.confirm_name) !== norm(t.name)) throw new HttpError(400, "errors.confirmNameMismatch");
      const stripeReason: Record<string, string> = { too_expensive: "too_expensive", only_once: "unused", missing_features: "missing_features", too_complex: "too_complex", switching: "switched_service", other: "other" };
      const api = billingApi();
      // past_due: there is no paid period left to keep. End it now and void the unpaid invoice so Stripe stops retrying the card.
      const sub =
        t.subscription_status === "past_due"
          ? await api.cancelNow(t.stripe_subscription_id, stripeReason[body.reason])
          : await api.updateSubscription(t.stripe_subscription_id, { cancel_at_period_end: true, cancel_reason: stripeReason[body.reason] });
      await db.exec("UPDATE tenants SET cancel_reason = ?, cancel_feedback = ? WHERE id = ?", [body.reason, body.feedback || null, tenant_id]);
      await syncTenantSubscription(req, sub);
      await audit(req, "billing.cancel_scheduled", "tenant", tenant_id, { tenantId: tenant_id, actorId: authed(res).id, meta: { reason: body.reason } });
      res.json({ ok: true, current_period_end: toSqlDate(sub.current_period_end) });
    }),
  );

  app.post(
    "/api/app/billing/resume",
    writeLimiter,
    requireTenant("members.manage"),
    route(async (req, res) => {
      const { tenant_id } = tenantCtx(res);
      const t = await loadBillingTenant(tenant_id);
      if (!t.stripe_subscription_id || !toBool(t.cancel_at_period_end)) throw new HttpError(409, "errors.noSubscription");
      const sub = await billingApi().updateSubscription(t.stripe_subscription_id, { cancel_at_period_end: false });
      await syncTenantSubscription(req, sub);
      await audit(req, "billing.resumed", "tenant", tenant_id, { tenantId: tenant_id, actorId: authed(res).id });
      res.json({ ok: true });
    }),
  );

  // ── Custom exchange templates (organizers; created from the wizard) ──
  app.get(
    "/api/app/templates",
    requireTenant("events.manage"),
    route(async (_req, res) => {
      // Saved designs are a Pro feature (kept in the DB while lapsed; shown again on resubscribe).
      const ws = authed(res).memberships.find((m) => m.tenant_id === tenantCtx(res).tenant_id);
      if (!ws || ws.tenant_plan === "free") return void res.json({ ok: true, items: [], locked: true });
      const rows = await db.query(
        "SELECT id, name, icon, color, match_mode, allow_wishlists, budget_min, budget_max, currency, theme_rules, reveal_mode, created_at FROM event_templates WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT 50",
        [tenantCtx(res).tenant_id],
      );
      res.json({
        ok: true,
        items: rows.map(
          (r): ExchangeTemplate => ({
            id: Number(r.id),
            name: r.name,
            icon: r.icon,
            color: r.color,
            match_mode: r.match_mode,
            allow_wishlists: toBool(r.allow_wishlists),
            budget_min: toNum(r.budget_min),
            budget_max: toNum(r.budget_max),
            currency: r.currency,
            theme_rules: r.theme_rules ?? null,
            reveal_mode: r.reveal_mode,
          }),
        ),
      });
    }),
  );

  app.delete(
    "/api/app/templates/:id",
    requireTenant("events.manage"),
    route(async (req, res) => {
      const { tenant_id } = tenantCtx(res);
      const r = await db.exec("DELETE FROM event_templates WHERE id = ? AND tenant_id = ?", [parseId(req.params.id), tenant_id]);
      if (!r.affectedRows) throw new HttpError(404, "errors.notFound");
      res.json({ ok: true });
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
      // "Reveal together": matches stay hidden until the exchange day (UTC date).
      const revealAt = r.reveal_mode === "together" && r.exchange_date ? String(r.exchange_date).slice(0, 10) : null;
      // No date on a "together" exchange (legacy data) → stay hidden rather than leak.
      const hiddenUntilDay = r.reveal_mode === "together" && (!revealAt || revealAt > new Date().toISOString().slice(0, 10));
      if ((r.status === "drawn" || r.status === "completed") && !hiddenUntilDay) {
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
      const out: MyAssignment = {
        event: mapEvent(r),
        me: { participant_id: Number(r.me_id), name: r.me_name, wishlist: r.me_wishlist ?? null, status: r.me_status },
        receiver,
        reveal_at: hiddenUntilDay && (r.status === "drawn" || r.status === "completed") ? revealAt : null,
      };
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
  filters: {
    status: { column: "t.status", values: ["active", "suspended", "archived"] },
    plan: { column: "t.plan", values: ["free", "pro", "enterprise"] },
    subscription: { column: "t.subscription_status", values: ["none", "active", "past_due", "canceled", "incomplete", "trialing", "unpaid"] },
  },
  search: ["t.name", "t.slug", "u.email"],
};
const TENANT_SELECT = `t.id, t.public_id, t.name, t.slug, t.status, t.plan, t.max_events, t.max_participants_per_event, t.created_at, u.email AS owner_email,
  t.subscription_status, t.current_period_end, t.cancel_at_period_end,
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
    subscription_status: r.subscription_status ?? "none",
    current_period_end: r.current_period_end ?? null,
    cancel_at_period_end: toBool(r.cancel_at_period_end),
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
                  (SELECT COUNT(*) FROM events WHERE plan = 'pro') AS pro_events,
                  (SELECT COUNT(*) FROM tenants WHERE subscription_status IN ('active','trialing','past_due')) AS active_subscriptions,
                  (SELECT COUNT(*) FROM tenants WHERE subscription_status = 'past_due') AS past_due_subscriptions`,
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
      const kk = { ...(k[0] ?? {}) };
      kk.mrr_cents = Number(kk.active_subscriptions ?? 0) * (await pricingInfo()).pro_price_cents;
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
          "p.id, p.kind, p.amount_cents, p.currency, p.status, p.card_brand, p.card_last4, p.provider_payment_id, p.hosted_invoice_url, p.created_at, t.name AS tenant_name, e.name AS event_name, u.email AS payer_email",
          "payments p JOIN tenants t ON t.id = p.tenant_id LEFT JOIN events e ON e.id = p.event_id LEFT JOIN users u ON u.id = p.user_id",
          (r): PaymentRow => ({
            id: Number(r.id),
            amount_cents: Number(r.amount_cents),
            currency: r.currency,
            status: r.status,
            card_brand: r.card_brand ?? null,
            card_last4: r.card_last4 ?? null,
            provider_payment_id: r.provider_payment_id,
            tenant_name: r.tenant_name,
            event_name: r.event_name ?? null,
            kind: r.kind === "invoice" ? "invoice" : "one_time",
            hosted_invoice_url: r.hosted_invoice_url ?? null,
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
    requires_pro: z.boolean().default(false),
    wishlist_mode: z.enum(["off", "required", "optional"]).default("off"),
    is_active: z.boolean().default(true),
    sort_order: z.number().int().min(0).max(10000).default(100),
  });

  app.post(
    "/api/admin/event-types",
    requirePlatform("catalog.write"),
    route(async (req, res) => {
      const b = eventTypeSchema.parse(req.body ?? {});
      const r = await db.exec(
        "INSERT INTO event_types (slug, name_en, name_es, description_en, description_es, icon, uses_draw, requires_pro, wishlist_mode, is_active, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [b.slug, b.name_en, b.name_es, b.description_en, b.description_es, b.icon, b.uses_draw ? 1 : 0, b.requires_pro ? 1 : 0, b.wishlist_mode, b.is_active ? 1 : 0, b.sort_order],
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
      // "Create your own" is a Pro feature by product definition.
      const slugRow = (await db.query("SELECT slug FROM event_types WHERE id = ?", [id]))[0];
      if (slugRow?.slug === "custom" && b.requires_pro === false) throw new HttpError(400, "errors.customIsPro");
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
    "/api/admin/leads",
    requirePlatform("leads.manage"),
    route(async (req, res) => {
      const g = parseGridQuery(req.query as any, {
        sortMap: { id: "c.id", created_at: "c.created_at", name: "c.name", company: "c.company", team_size: "c.team_size", status: "c.status" },
        defaultSort: "created_at",
        filters: { status: { column: "c.status", values: ["new", "contacted", "won", "lost"] }, team_size: { column: "c.team_size", values: ["lt50", "50_100", "100_500", "500_plus"] } },
        search: ["c.name", "c.email", "c.company"],
      });
      res.json(
        await runGrid(g, "c.*, u.full_name AS handled_by_name", "contact_requests c LEFT JOIN users u ON u.id = c.handled_by", (r): LeadRow => ({
          id: Number(r.id),
          name: r.name,
          email: r.email,
          company: r.company ?? null,
          team_size: r.team_size,
          message: r.message ?? null,
          locale: r.locale === "es" ? "es" : "en",
          status: r.status,
          notes: r.notes ?? null,
          handled_by_name: r.handled_by_name ?? null,
          created_at: r.created_at,
        })),
      );
    }),
  );

  app.patch(
    "/api/admin/leads/:id",
    writeLimiter,
    requirePlatform("leads.manage"),
    route(async (req, res) => {
      const id = parseId(req.params.id);
      const body = z.object({ status: z.enum(["new", "contacted", "won", "lost"]).optional(), notes: z.string().trim().max(1000).nullable().optional() }).parse(req.body ?? {});
      const sets: string[] = ["handled_by = ?"];
      const vals: unknown[] = [authed(res).id];
      if (body.status) (sets.push("status = ?"), vals.push(body.status));
      if (body.notes !== undefined) (sets.push("notes = ?"), vals.push(body.notes || null));
      const r = await db.exec(`UPDATE contact_requests SET ${sets.join(", ")} WHERE id = ?`, [...vals, id]);
      if (!r.affectedRows) throw new HttpError(404, "errors.notFound");
      await audit(req, "lead.update", "contact_request", id, { actorId: authed(res).id, meta: body });
      res.json({ ok: true });
    }),
  );

  // ── Email gallery: every template with sample data (EN/ES), plus "send a test to me". ──
  app.get(
    "/api/admin/email-previews",
    requirePlatform("emails.read"),
    route(async (_req, res) => {
      res.json({ ok: true, items: Object.keys(EMAIL_PREVIEWS).map((key) => ({ key, subject: EMAIL_PREVIEWS[key]("en").subject })) });
    }),
  );

  app.get(
    "/api/admin/email-previews/:key",
    requirePlatform("emails.read"),
    route(async (req, res) => {
      const build = EMAIL_PREVIEWS[String(req.params.key)];
      if (!build || !Object.hasOwn(EMAIL_PREVIEWS, String(req.params.key))) throw new HttpError(404, "errors.notFound");
      const lang: Lang = req.query.lang === "es" ? "es" : "en";
      res.json({ ok: true, ...build(lang) });
    }),
  );

  app.post(
    "/api/admin/email-previews/:key/send",
    writeLimiter,
    requirePlatform("emails.read"),
    route(async (req, res) => {
      const key = String(req.params.key);
      if (!Object.hasOwn(EMAIL_PREVIEWS, key)) throw new HttpError(404, "errors.notFound");
      const lang: Lang = req.body?.lang === "es" ? "es" : "en";
      const mail = EMAIL_PREVIEWS[key](lang);
      // Only ever to the signed-in admin's own address.
      const r = await sendEmail({ to: authed(res).email, ...mail, subject: `[Test] ${mail.subject}`, template: "test" });
      res.json({ ok: r.ok, dry_run: r.dryRun, to: authed(res).email });
    }),
  );

  app.get(
    "/api/admin/emails",
    requirePlatform("emails.read"),
    route(async (req, res) => {
      const g = parseGridQuery(req.query as any, {
        sortMap: { id: "l.id", created_at: "l.created_at", to_email: "l.to_email", template: "l.template", status: "l.status" },
        defaultSort: "id",
        filters: { status: { column: "l.status", values: ["sent", "failed", "dry_run"] }, template: { column: "l.template", values: ["otp", "invite", "reminder", "assignment", "reveal_day", "link_joined", "contact", "pro_welcome", "payment_failed", "pro_ended", "cancel_scheduled", "resumed", "test"] } },
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

  const EDITABLE_SETTINGS = ["session_days", "default_max_events", "default_max_participants", "signups_enabled", "free_max_participants", "pro_max_participants", "pro_price_cents", "subscription_grace_days", "save_offer_percent"] as const;
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
      if (!secret) {
        if (IS_PROD) throw new HttpError(503, "errors.cronNotConfigured");
      } else {
        const given = Buffer.from(String(req.headers.authorization || ""));
        const want = Buffer.from(`Bearer ${secret}`);
        if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) throw new HttpError(401, "errors.unauthorized");
      }
      const otp = await db.exec("DELETE FROM otp_codes WHERE created_at < UTC_TIMESTAMP() - INTERVAL 2 DAY");
      const sess = await db.exec("DELETE FROM user_sessions WHERE expires_at < UTC_TIMESTAMP() - INTERVAL 7 DAY OR (is_active = 0 AND created_at < UTC_TIMESTAMP() - INTERVAL 30 DAY)");
      const drafts = await db.exec(`DELETE FROM wizard_drafts WHERE updated_at < UTC_TIMESTAMP() - INTERVAL ${DRAFT_TTL_DAYS} DAY`);
      const reveal = await sendRevealDayEmails();
      const graceEnded = await sendGraceEndedEmails();
      // Daily-limit markers are only needed for a day; keep the rest (one row per one-off email) as an audit trail.
      await db.exec("DELETE FROM email_notices WHERE kind = 'remind' AND created_at < UTC_TIMESTAMP() - INTERVAL 7 DAY");
      res.json({ ok: true, otp_deleted: otp.affectedRows, sessions_deleted: sess.affectedRows, drafts_deleted: drafts.affectedRows, reveal_day_emails: reveal, grace_ended_emails: graceEnded });
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
  // Same headers as vercel.json (also covers local dev and any non-Vercel host).
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });
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
  setBillingApi: (api: BillingApi | null) => void (billingOverride = api),
  platformCan,
  tenantCan,
  /** Run the subscription → tenant sync directly (billing-email race tests). */
  syncSubscriptionForTest: (sub: SubscriptionInfo) => syncTenantSubscription(null, sub),
};
