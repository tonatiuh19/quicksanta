# QuickSanta

Multi-tenant platform for creative gift exchanges (Secret Santa, white elephant, wishlist exchange, book & cookie swaps…).
Passwordless (email OTP), Command Center for platform owners, server-side grids, EN/ES, mobile-first.

## Stack

Vite + React 18 + Redux Toolkit · single Express serverless function (`api/index.ts`) on Vercel · TiDB Cloud (MySQL) · Resend · Vitest · **npm only**.

## Develop

```bash
cp .env.example .env     # TiDB + Resend (without RESEND_API_KEY codes are printed to the console)
npm install
npm run db:migrate       # needs the mysql CLI
npm run dev              # https://localhost:8080 (API on :8081, proxied)
```

## Test

```bash
npm test                 # unit + API (fake DB) + UI (jsdom) — seconds, no network
npm run test:integration # real TiDB end-to-end (fixtures auto-purged)
npm run typecheck
npm run check:api-inline
```

## Deploy

```bash
npm run deploy:prod             # gates + mock tests + vercel --prod + version stamp + tag
npm run deploy:prod -- --full   # also run TiDB integration tests
```

See `AGENTS.md` (rules, roles, flows), `DESIGN_SYSTEM.md`, `api/swagger.yaml`.
