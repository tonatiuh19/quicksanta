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

## Mobile (≤ 900px) — app-like patterns

- **Wizard:** sticky translucent header; 3px progress bar pinned under it; "Step N of M · Label" instead of the dot rail; a slim **mini ticket** (service, exchange name, people count; takes the custom color) replaces the big preview; panel is full-bleed (no card); **sticky bottom action bar** (Back + full-width primary, safe-area aware, text wraps); service cards become compact rows (icon left, 2-line description); people list never scrolls inside the page; review tiles 2-up (1-up ≤ 380px).
- **Landing:** nav keeps brand + language + Sign in; the hero carries the CTA (full-width buttons).
- **Portal shell:** bottom tab bar uses short labels (`tabLabelKey`: Home, Mine…); closed bottom sheet is `visibility: hidden` (not focusable); page headers shrink, header actions stretch, grid filters 2-up.
- Inputs are ≥ 44px tall and 16px font (no iOS zoom). Verified by `e2e/mobile-audit.spec.ts` at 390px and 320px (`MOBILE_W=320`): fails on any sideways overflow and screenshots every screen.

## Components

- `Brand`, `PageHeader`, `StatCard` (tones default/red/green/gold), `StatusBadge`, `ErrorNote` (translates API keys), `EmptyState`, `Card`, `SearchBox` (300ms debounce), `FilterSelect` — `client/components/kit.tsx`
- `ServerGrid` + `DataGrid` (optimum-credit port): sortable headers with chevrons, sticky first column, skeleton rows, "Showing x–y of n" pager, `mobileCard` renderer under 640px.
- `Modal`, `SideDrawer` (right slide-over, full width on phones), `OtpCodeInput` (6 boxes, paste/autofill, verifying overlay) — groundwork ports.
- Wizard: step rail with dots (done = green check, current = red ring), gradient progress bar, animated panel, live **ticket preview** (sticky on desktop, on top on phones), choice cards, budget chips, people list with avatars, rule builder (⇄ / →), review tiles, confetti success.
- Reveal card: 3D flip from a striped red "gift" front to a gold-bordered back with the receiver name + wishlist.
- Command Center charts are CSS-only (stacked bars for signups, horizontal bars for services).

## Checkout

`CheckoutCard`: Stripe split card fields (number / expiry / CVC, brand-styled iframes) beside a live 3D card that floats, shows the detected brand (Visa blue, Mastercard graphite, Amex teal, default QuickSanta red), flips to the back while the CVC is focused and glows gold when complete. Pay button shows the amount; success overlay with pop animation. Wizard review has a Free/Pro plan picker (Pro forced above the free limit); event pages show a gold "Upgrade to Pro" banner or a red "Payment pending" banner.

## Pro services + Create your own

Service cards: Pro-only cards carry a red→gold "Pro" pill (lock icon on Free workspaces, crown when covered). "Create your own" is a dashed card with a bobbing gradient icon. The Design step has an icon grid (12), color swatches (8 gradients), match-mode and reveal cards, rules textarea and a "save as template" switch; the ticket preview takes the chosen gradient, icon and rules live. Saved designs show as gradient pills above the grid. Keyboard focus = gold outline; selection = red border.

## Wizard · People step

- Ask for a piece of information once. The organizer's name lives only in the "You, the organizer" card (`.qs-me-card`, dashed gold): name field + hint (shown on invitations / signed-in email) + "I'm taking part too" switch. It is required even when the organizer doesn't take part, and the OTP account step sends it with the code instead of asking again.
- Guests are added under their own heading ("Add the people you're inviting", `.qs-subhead`) with fields labelled "Their name" / "Their email" — never a bare "Name" next to "Your name".
- Validation follows field order (name, then email) and clears as soon as the user types. Avatars without a name show a person icon, not "?".

## Invite link (exchange → People)

- `InviteLinkPanel` (`.qs-invite-link`): one switch ("Let people join with a link"); when on, a red code ticket (`.qs-invite-code`, monospace, letter-spaced `XXXX-XXXX`, state badge; grey gradient when closed/expired/full), the read-only URL + Copy, then actions: WhatsApp (green `.qs-btn-whatsapp`; a disabled *button* when the link can't be used), native Share (only where `navigator.share` exists), QR (modal, PNG download), Copy code. Stats line: joined via link · seats left · cap · until date. "Limits" (cap + date) and "New link" (two-step, destructive) sit in the footer.
- Join page (`/j/:code`, `/join`): the same invite ticket as email invites, then exactly one next step — OTP card (signed out), "Join the exchange" (signed in), "already in" link, or a plain explanation (paused / closed / expired / full). Code input `.qs-code-input` auto-formats to `XXXX-XXXX`.
- People grid tags link joiners with a purple "via link" badge and can filter by "How they joined".
- Under 560px the URL row stacks and the actions become a 2-column grid.

## Home sections (newer features)

- Order: hero → "Have a code?" strip (`.qs-code-strip`, white card, gold key icon, monospace code input) → how it works (step 2 shows a dashed link chip next to the envelopes) → invite-link showcase → Create-your-own showcase → examples → trust → pricing → FAQ → final CTA.
- Showcases (`.qs-showcase`, `.is-reverse` flips sides): kicker + h2 + lead + 2×2 icon points (or a check list) + one primary CTA, next to a live visual. Visuals are decorative (`aria-hidden`) or real controls with labels; all animation stops under `prefers-reduced-motion`.
- Invite visual: a phone (`.qs-phone`) looping code ticket + QR → group chat bubbles → people popping in "via link".
- Create-your-own visual: a gradient ticket that restyles from icon / color radios and a draw switch (`.qs-designer`); Pro tag inline in the kicker.
- Enterprise "Contact sales" opens a modal form (focus starts on the first field; honeypot `.qs-hp` off-screen). Leads in Command Center use colored status selects (`.qs-lead-status.is-*`).
- Under 860px showcases stack (copy first, then the visual); under 560px points go single-column and the phone shrinks.

## Drafts

- `DraftCard` (`client/components/DraftCard.tsx`, `.qs-draft`): a ticket with a coloured stub (service icon; custom designs use their own gradient via `--draft-accent`), a gold "Draft" pill, the exchange name (or "Untitled exchange"), people count, next step, relative "Edited …" time, where it is saved + days left, and a `ProgressRing` (`.qs-ring`, share of steps done).
- Actions: primary **Continue**; destructive actions are two-step (link button → red "Yes, delete it").
- Shown on the dashboard (above the KPIs, also for users without a workspace) and on the `/start` resume screen (`.qs-resume`: "Pick up where you left off" + "Start a new exchange"). Entering `/start` with a draft always shows the resume screen unless the user came through **Continue**.
- Under 560px the ring moves to the top-right corner and the buttons stack full width. Entry animation respects `prefers-reduced-motion`.

## Billing portal

`/app/billing`: Pro "plan hero" (red gradient with a slow shine, crown icon, price/month, renewal line, usage meter that turns gold→red near the limit); Free shows the upgrade box. Payment-method card shows a mini credit card in brand colors. Invoices table with view/PDF icons. Banners: red past-due (fix card), gold scheduled-cancel (resume). Cancel flow is a 3-step modal with a progress bar: reason chips (optional) → save offer card (bobbing icon) → confirm by typing the workspace name (primary button = Keep Pro). Legal pages use `.qs-legal` (820px reading column, scrollable tables).

## Email chrome

`emailLayout()` in `api/index.ts`: cream background, 520px white card, red header "🎁 QuickSanta", red pill CTA, muted footer. Templates: OTP (big spaced code), invitation, assignment ready. EN/ES by `Accept-Language`.

## Copy

EN + ES for everything. No em dashes joining sentences in customer copy; use periods or " · ".
