# QuickSanta — Agent / Copilot Instructions

QuickSanta is a multi-tenant platform for creative gift-exchange services (Secret Santa, white elephant,
wishlist exchange, book swap, cookie swap, and more from the Command Center catalog). Same architecture as
groundwork / optimum-credit: Vite + React 18 SPA, one inline Express serverless function on Vercel, TiDB Cloud,
Resend, Redux Toolkit, i18next (EN/ES), Tailwind + hand-written CSS, Vitest, **npm only**.

## ⚠️ CRITICAL RULES - MUST FOLLOW

- **ALWAYS reference `database/schema.sql` for exact table structure and column names; never assume columns**
- **NEVER touch schema.sql directly for schema changes — write a migration in `database/migrations/` first, apply it, then sync schema.sql**
- **Multi-tenant**: every tenant-owned row has `tenant_id`; `/api/app/*` handlers scope every query by `tenantCtx(res).tenant_id` (from `requireTenant`), never from the body
- **ALL data fetching in Redux slices (`createApiThunk`)**; components only dispatch + select
- **Every list is a server-side grid** (`ServerGrid` + `createGridSlice` + `parseGridQuery`): filter, search, sort, paginate in SQL
- **All runtime API logic inline in `api/index.ts`** (Vercel serverless). `import type` only from `shared/`. `npm run check:api-inline`
- **If `api/index.ts` changes, update `api/swagger.yaml` in the same change**
- **If UI / branding / email chrome changes, update `DESIGN_SYSTEM.md` in the same change**
- **i18n**: every user-visible string in BOTH `client/locales/en` and `client/locales/es` (checked by `client/i18n.spec.ts`)
- **Mobile mandatory**: ~320px+, no document horizontal scroll; portal shell = top bar + bottom tab bar + bottom-sheet menu under 900px (`.cursor/rules/mobile-responsive.mdc`)
- **Passwordless only** (email OTP). Never add passwords/JWT
- **Tests & QA never send real email** (`VITEST=true` → dry-run). Integration fixtures: `qsit-<suite>-<ts>-…@example.com`
- **Fix root causes; no breaking changes; add reusable components instead of duplicating**
- **NO EXCEPTIONS to these rules**

## Roles

| Scope | Role | Can |
|---|---|---|
| Platform (Command Center `/admin`) | `owner` | everything, incl. granting platform roles + platform settings. First owner: **Alex Gomez (alex@disruptinglabs.com)**, seeded by migration |
| Platform | `admin` | manage tenants (status/plan/limits), users (suspend), catalog; read events, emails, audit. Cannot touch owners or grant roles |
| Tenant (workspace `/app`) | `organizer` | create exchanges, manage participants/rules, run/reset the draw, manage members/workspace |
| Tenant | `participant` | see own exchanges, reveal own match, edit own wishlist |

Matrix: `shared/api.ts` (`PLATFORM_PERMS`, `TENANT_PERMS`) mirrored inline in `api/index.ts` (drift test `api/permissions.test.ts`).
Guards: last owner can't be demoted/suspended; last organizer can't be removed; nobody changes their own access.

## Core flows

1. **Wizard** `/start` (exchange-only): service → details → people (paste lists) → rules (exclusions) → account (OTP, skipped when signed in) → review → `POST /api/wizard/launch`. Creates the tenant implicitly (first time), organizer membership, event, participants, exclusions, invites — one transaction. Draft persists in localStorage.
2. **Join** `/join/:token`: public preview → sign in with the invited email → accept → participant membership.
3. **Draw** `POST /api/app/events/:id/draw`: randomized backtracking derangement honoring exclusions (`drawAssignments`), atomic status lock (`open → drawn`), assignment emails.
4. **Reveal** `/app/my/:publicId`: flip card shows receiver + wishlist; marks `viewed_at`.
5. **Command Center** `/admin`: overview KPIs/charts, tenants (drawer with controls), users/roles, events, email log, audit log, service catalog, platform settings.

## Pricing & payments

| Plan | Price | People per exchange |
|---|---|---|
| Free | $0 | up to `free_max_participants` (20) |
| Pro | `pro_price_cents` (890 = $8.90 USD) once per exchange | up to `pro_max_participants` (100) |
| Enterprise | custom (tenant `plan = enterprise`, set in Command Center) | tenant `max_participants_per_event` |

- Pro checkout = Stripe PaymentIntent (`POST /api/app/events/:id/checkout`) + Stripe Elements card fields (`client/components/billing/CheckoutCard.tsx`) + server verification (`/checkout/confirm`) + webhook (`/api/webhooks/stripe`). `finalizePayment` is idempotent (guard `paid_at IS NULL`).
- Wizard Pro launches create the exchange as `pending_payment` with invites queued (`invites_pending`); payment opens it and sends them.
- Status changes go through `canTransition` (no reopening drawn/cancelled, no bypassing payment).
- All prices/limits are `system_settings` (Command Center → Platform settings). Stripe is faked in tests via `__test.setPaymentsApi`.

## Backend

- `api/index.ts`: sections = DB (swappable `Db`), utils (`HttpError`, `route`, `parseGridQuery`, cookies), settings/audit/email, draw engine, auth (OTP + sessions + guards), routes, `buildApp`.
- Sessions: random 32-byte token → `sha256` stored in `user_sessions`, cookie `qs_sid` (HttpOnly, SameSite=Lax, Secure in prod), default 30 days (`session_days`).
- CSRF: non-GET `/api/*` must come from our origin (`csrfOriginGuard`).
- Dev: `npm run dev` → Vite on :8080 proxies `/api` to the Express app on :8081 (vite.config.ts plugin).

### Running migrations (TiDB Cloud)

```bash
npm run db:migrate      # applies database/migrations/*.sql in order, ledger in schema_migrations
```

## Testing (mock-first, fast deploys) — full rule `.cursor/rules/testing.mdc`

- `npm test` → `unit` (pure helpers + every API route on the in-memory fake DB) + `ui` (jsdom pages with mocked API). Seconds, no network.
- `npm run test:integration` → real TiDB end-to-end (`api/*.integration.test.ts`), DB lock + fixture purge.
- `npm run deploy:prod` runs the mock suites; `npm run deploy:prod -- --full` also runs integration.

## Deploy

`npm run deploy:prod [version] [--full] [--skip-checks] [--allow-dirty]` (scripts/deploy-prod.ts, same as groundwork):
git gate (main, synced, no secrets) → api-inline → typecheck → tests → prod env check (`vercel env ls`) → version prompt
(terminal or Telegram) → `vercel --prod` → stamp `system_settings.app_version` → git tag → release notes (Slack).

## Frontend

- `client/App.tsx` routes: `/`, `/login`, `/start`, `/join/:token`, `/app/*` (AppLayout), `/admin/*` (AdminLayout). Portals are lazy-loaded.
- Shell: `client/components/portal/PortalShell.tsx` (nav items carry `section`, `perm`, `roles`).
- Grids: `client/components/ServerGrid.tsx` → `client/components/ui/data-grid.tsx` (ported from optimum-credit).
- Kit: `client/components/kit.tsx`; Modal / SideDrawer / OtpCodeInput ported from groundwork.
