# QuickSanta Design System

Festive but calm: warm cream canvas, deep red brand, gold accents, generous radii, soft shadows. Manrope everywhere.
Source of truth for tokens: `:root` in `client/global.css` (semantic HSL vars feed Tailwind; `--qs-*` feed hand-written CSS).

## Tokens

| Token | Value | Use |
|---|---|---|
| `--qs-red` | `#b91c1c` | primary actions, links, active states |
| `--qs-red-deep` | `#7f1d1d` | tickets, danger buttons, email header |
| `--qs-gold` / `--qs-gold-soft` | `#d6a23a` / `#fde68a` | accents, section headings, active tab pill |
| `--qs-green` | `#166534` | success, switches on |
| `--qs-cream` | `#fdf6ec` | soft surfaces, mobile cards |
| `--qs-line` | `#f1e4cf` | borders |
| `--qs-sidebar` | `#2a0f0f` (workspace) / `#111827` (Command Center) | portal sidebar |
| radius | 14px base; cards 18px; hero cards 22px; pills 999px | |

Badges (`StatusBadge`): green = active/joined/open/sent, blue = drawn/organizer/pro, gold = invited, red = suspended/failed/declined/cancelled, purple = owner/enterprise, gray = everything else.

## Layout

- **Portal shell** (`PortalShell`, ported from groundwork): 264px dark sidebar with category headings (`portal-nav-section`, gold rule) → account strip → logout. Workspace sidebar includes the tenant switcher.
- **≤900px**: sticky translucent top bar (brand + section kicker), **bottom tab bar** (max 4 + "More"), full menu as a **bottom sheet** (grip, 2-column tiles, category headings). Zero document sideways scroll (`overflow-x: clip`).
- **≤640px**: forms single column, stats 2-up, wizard rule builder stacks, OTP boxes shrink.
- Pages: `portal-page` (max 1200px) → `PageHeader` (kicker, h1, sub, actions) → stats (`qs-stats`) → cards / grid.

## Components

- `Brand`, `PageHeader`, `StatCard` (tones default/red/green/gold), `StatusBadge`, `ErrorNote` (translates API keys), `EmptyState`, `Card`, `SearchBox` (300ms debounce), `FilterSelect` — `client/components/kit.tsx`
- `ServerGrid` + `DataGrid` (optimum-credit port): sortable headers with chevrons, sticky first column, skeleton rows, "Showing x–y of n" pager, `mobileCard` renderer under 640px.
- `Modal`, `SideDrawer` (right slide-over, full width on phones), `OtpCodeInput` (6 boxes, paste/autofill, verifying overlay) — groundwork ports.
- Wizard: step rail with dots (done = green check, current = red ring), gradient progress bar, animated panel, live **ticket preview** (sticky on desktop, on top on phones), choice cards, budget chips, people list with avatars, rule builder (⇄ / →), review tiles, confetti success.
- Reveal card: 3D flip from a striped red "gift" front to a gold-bordered back with the receiver name + wishlist.
- Command Center charts are CSS-only (stacked bars for signups, horizontal bars for services).

## Checkout

`CheckoutCard`: Stripe split card fields (number / expiry / CVC, brand-styled iframes) beside a live 3D card that floats, shows the detected brand (Visa blue, Mastercard graphite, Amex teal, default QuickSanta red), flips to the back while the CVC is focused and glows gold when complete. Pay button shows the amount; success overlay with pop animation. Wizard review has a Free/Pro plan picker (Pro forced above the free limit); event pages show a gold "Upgrade to Pro" banner or a red "Payment pending" banner.

## Billing portal

`/app/billing`: Pro "plan hero" (red gradient with a slow shine, crown icon, price/month, renewal line, usage meter that turns gold→red near the limit); Free shows the upgrade box. Payment-method card shows a mini credit card in brand colors. Invoices table with view/PDF icons. Banners: red past-due (fix card), gold scheduled-cancel (resume). Cancel flow is a 3-step modal with a progress bar: reason chips (optional) → save offer card (bobbing icon) → confirm by typing the workspace name (primary button = Keep Pro). Legal pages use `.qs-legal` (820px reading column, scrollable tables).

## Email chrome

`emailLayout()` in `api/index.ts`: cream background, 520px white card, red header "🎁 QuickSanta", red pill CTA, muted footer. Templates: OTP (big spaced code), invitation, assignment ready. EN/ES by `Accept-Language`.

## Copy

EN + ES for everything. No em dashes joining sentences in customer copy; use periods or " · ".
