import { expect, test } from "@playwright/test";
import { answer3ds, cleanup, fillCard, forceOtp, mail, makeUser, pool, SHOTS, signInAs } from "./helpers";

test.describe.configure({ mode: "serial" });
test.afterAll(async () => {
  await cleanup();
});

let organizer: Awaited<ReturnType<typeof makeUser>>;
let freeEventId = 0;
let proEventId = 0;

const pasteList = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} ${i} <${mail(`${tag}${i}`)}>`).join("\n");

test("landing: hero demo, how it works, pricing $8.90, examples, FAQ, Spanish", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Gift exchanges");
  await expect(page.locator(".qs-hero-person")).toHaveCount(6);
  await expect(page.locator(".qs-hero-lines path").first()).toBeVisible({ timeout: 8000 }); // draw animation runs
  await page.getByRole("link", { name: "Pricing" }).click();
  const pro = page.locator(".qs-plan.is-featured");
  await expect(pro).toContainText("$8.90");
  await expect(pro).toContainText("Up to 100 people per exchange");
  await expect(page.locator(".qs-plan").first()).toContainText("Up to 20 people per exchange");
  await page.getByRole("tab", { name: /family/i }).click();
  await expect(page.getByText("Gómez Family Christmas")).toBeVisible();
  await page.getByRole("button", { name: /can the organizer see/i }).click();
  await expect(page.getByText(/Matches are private/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/01-landing.png`, fullPage: true });
  await page.getByRole("button", { name: /language/i }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Intercambios de regalos");
  await page.getByRole("button", { name: /idioma|language/i }).click();
});

test("login with OTP: bad email, wrong code, right code", async ({ page }) => {
  const email = mail("otp");
  await page.goto("/login");
  await page.getByLabel("Email").fill("not-an-email");
  await page.getByRole("button", { name: /email me a code/i }).click();
  await expect(page.getByRole("alert")).toContainText("valid email");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: /email me a code/i }).click();
  await expect(page.getByText(`We sent a code to ${email}`)).toBeVisible();
  const code = await forceOtp(email);
  await page.getByLabel("Digit 1 of 6").fill("000000");
  await expect(page.getByText("That code is wrong or expired.")).toBeVisible();
  await page.getByLabel("Digit 1 of 6").fill(code);
  await page.waitForURL(/\/(start|app|admin)/);
  await expect(page).toHaveURL(/\/start/); // brand-new user has no workspace → wizard
});

test("wizard (free): service → details → paste people → rule → launch", async ({ page, context }) => {
  organizer = await makeUser("organizer");
  await signInAs(context, organizer);
  await page.goto("/start");
  await page.getByRole("radio", { name: /^secret santa/i }).click();
  await page.getByRole("button", { name: /continue/i }).click();
  await page.getByRole("button", { name: /continue/i }).click();
  await expect(page.getByRole("alert")).toContainText("Give your exchange a name");
  await page.getByLabel(/exchange name/i).fill("PW Free Santa");
  await page.getByRole("button", { name: /~50 USD/ }).click();
  await page.getByRole("button", { name: /continue/i }).click();
  await page.getByLabel("Your name").fill("Organizer PW");
  await page.getByRole("button", { name: /paste a list/i }).click();
  await page.getByRole("textbox", { name: /paste a list/i }).fill(pasteList(5, "Free") + "\nnot valid line");
  await page.getByRole("button", { name: /add all/i }).click();
  await expect(page.getByText(/1 line\(s\) without a valid email/)).toBeVisible();
  await page.getByRole("button", { name: /continue/i }).click();
  await page.getByLabel("Person").selectOption(mail("Free0").toLowerCase());
  await page.getByLabel("Can't get").selectOption(mail("Free1").toLowerCase());
  await page.getByRole("button", { name: /add rule/i }).click();
  await expect(page.getByText(/never paired/)).toBeVisible();
  await page.getByRole("button", { name: /continue/i }).click();
  await expect(page.getByText(/ready to launch/i)).toBeVisible();
  await expect(page.getByRole("radio", { name: /free/i })).toHaveAttribute("aria-checked", "true");
  await page.getByText("Email invitations now").click(); // keep it quiet
  await page.screenshot({ path: `${SHOTS}/02-wizard-review.png`, fullPage: true });
  await page.getByRole("button", { name: /launch exchange/i }).click();
  await expect(page.getByText(/your exchange is live/i)).toBeVisible();
  await page.getByRole("button", { name: /manage exchange/i }).click();
  await page.waitForURL(/\/app\/events\/\d+/);
  freeEventId = Number(page.url().split("/").pop());
  await expect(page.getByText("6/20 people on the free plan")).toBeVisible();
  await expect(page.locator(".qs-rules, .qs-tabs")).toBeVisible();
});

test("participants grid: search, filter, sort (server-side)", async ({ page, context }) => {
  await signInAs(context, organizer);
  await page.goto(`/app/events/${freeEventId}`);
  const grid = page.locator(".qs-grid");
  await expect(grid.locator("tbody tr")).toHaveCount(6);
  const req = page.waitForRequest((r) => r.url().includes("/participants") && r.url().includes("q=Free+3"));
  await grid.getByRole("searchbox").fill("Free 3");
  await req;
  await expect(grid.locator("tbody tr")).toHaveCount(1);
  await grid.getByRole("searchbox").fill("");
  const sortReq = page.waitForRequest((r) => r.url().includes("sort_by=email") && r.url().includes("sort_dir=ASC"));
  await grid.getByRole("button", { name: "Email" }).click();
  await sortReq;
  const filterReq = page.waitForRequest((r) => r.url().includes("status=joined"));
  await grid.getByLabel("Status").selectOption("joined");
  await filterReq;
  await expect(grid.locator("tbody tr")).toHaveCount(1); // only the organizer joined
});

test("upgrade free → Pro from the banner with a declined card, then Visa", async ({ page, context }) => {
  await signInAs(context, organizer);
  await page.goto(`/app/events/${freeEventId}`);
  await page.getByRole("button", { name: "Upgrade to Pro" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/Pay \$8\.90 securely/)).toBeVisible();
  await fillCard(page, "4000 0000 0000 0002");
  await expect(dialog.locator(".qs-cc.is-ready")).toBeVisible(); // 3D card glows when complete
  await page.screenshot({ path: `${SHOTS}/03-checkout.png` });
  await dialog.getByRole("button", { name: /pay \$8\.90/i }).click();
  await expect(dialog.getByRole("alert")).toContainText(/declined/i);
  await fillCard(page, "4242 4242 4242 4242");
  await dialog.getByRole("button", { name: /pay \$8\.90/i }).click();
  await expect(page.getByText(/Pro unlocked/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Pro exchange · up to 100 people/)).toBeVisible();
});

test("wizard (Pro): 25 people forces Pro, 3-D Secure fails then succeeds, invites queued", async ({ page, context }) => {
  await signInAs(context, organizer);
  await page.goto("/start");
  await page.getByRole("radio", { name: /^secret santa/i }).click();
  await page.getByRole("button", { name: /continue/i }).click();
  await page.getByLabel(/exchange name/i).fill("PW Pro Santa");
  await page.getByRole("button", { name: /continue/i }).click();
  await page.getByRole("button", { name: /paste a list/i }).click();
  await page.getByRole("textbox", { name: /paste a list/i }).fill(pasteList(24, "Pro"));
  await page.getByRole("button", { name: /add all/i }).click();
  await page.getByRole("button", { name: /continue/i }).click();
  await page.getByRole("button", { name: /continue/i }).click(); // no rules
  await expect(page.getByText(/25 people is above the free limit of 20/)).toBeVisible();
  await expect(page.getByRole("radio", { name: /free/i })).toBeDisabled();
  await page.getByRole("button", { name: /launch & pay \$8\.90/i }).click();
  await expect(page.getByText("Unlock Pro for this exchange")).toBeVisible();
  const [row] = (await pool.query("SELECT id, status, invites_pending FROM events WHERE name = 'PW Pro Santa' ORDER BY id DESC LIMIT 1")) as any;
  proEventId = Number(row[0].id);
  expect(row[0].status).toBe("pending_payment");

  await fillCard(page, "4000 0025 0000 3155");
  await page.getByRole("button", { name: /pay \$8\.90/i }).click();
  await answer3ds(page, "fail");
  await expect(page.locator(".qs-checkout .qs-error")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: /pay \$8\.90/i }).click();
  await answer3ds(page, "complete");
  await expect(page.getByText(/your exchange is live/i)).toBeVisible({ timeout: 30_000 });
  const [after] = (await pool.query("SELECT status, plan, paid_at FROM events WHERE id = ?", [proEventId])) as any;
  expect(after[0]).toMatchObject({ status: "open", plan: "pro" });
  expect(after[0].paid_at).toBeTruthy();
});

test("pending payment banner + 'pay later' keeps the exchange closed", async ({ page, context }) => {
  await signInAs(context, organizer);
  const [r] = (await pool.query("INSERT INTO events (public_id, tenant_id, event_type_id, name, status) SELECT ?, e.tenant_id, e.event_type_id, 'PW Unpaid', 'pending_payment' FROM events e WHERE e.id = ?", [
    `PWUNPAID${Date.now()}`.slice(0, 26),
    freeEventId,
  ])) as any;
  await page.goto(`/app/events/${r.insertId}`);
  await expect(page.getByText("Payment pending")).toBeVisible();
  await expect(page.getByRole("button", { name: /run the draw/i })).toHaveCount(0);
  await page.getByRole("button", { name: "Pay $8.90" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("draw → participant reveals their match and saves a wishlist", async ({ page, context, browser }) => {
  await signInAs(context, organizer);
  await page.goto(`/app/events/${freeEventId}`);
  await page.getByRole("button", { name: /run the draw/i }).click();
  await page.getByRole("dialog").getByRole("button", { name: /draw now/i }).click();
  await expect(page.getByText(/Draw done!/)).toBeVisible();
  await expect(page.getByRole("button", { name: /reset draw/i })).toBeVisible();

  // Link a participant to a real account, then open their reveal page in a separate browser session.
  const ana = await makeUser("Free2");
  await pool.query("UPDATE participants SET user_id = ?, status = 'joined', joined_at = UTC_TIMESTAMP() WHERE event_id = ? AND email = ?", [ana.id, freeEventId, mail("Free2").toLowerCase()]);
  await pool.query("INSERT INTO tenant_members (tenant_id, user_id, role) SELECT tenant_id, ?, 'participant' FROM events WHERE id = ?", [ana.id, freeEventId]);
  const [ev] = (await pool.query("SELECT public_id FROM events WHERE id = ?", [freeEventId])) as any;
  const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
  await signInAs(ctx2, ana);
  const p2 = await ctx2.newPage();
  await p2.goto(`/app/my/${ev[0].public_id}`);
  await p2.getByRole("button", { name: /reveal my match/i }).click();
  await expect(p2.locator(".qs-reveal.is-revealed .qs-reveal-name")).not.toHaveText("");
  const name = await p2.locator(".qs-reveal-name").textContent();
  expect(name).not.toBe("Free 2");
  await p2.getByRole("textbox", { name: /my wishlist/i }).fill("Books and socks");
  await p2.getByRole("button", { name: /^save$/i }).click();
  await expect(p2.getByText("✓ Saved")).toBeVisible();
  await p2.screenshot({ path: `${SHOTS}/04-reveal.png` });
  // A participant can't reach organizer pages.
  await p2.goto("/app/events");
  await expect(p2.getByText(/don't have access|not a member/i)).toBeVisible();
  await ctx2.close();
});

test("Command Center: overview, tenants grid + drawer, payments, non-admin blocked", async ({ page, context, browser }) => {
  const admin = await makeUser("admin", "admin");
  await signInAs(context, admin);
  await page.goto("/admin");
  await expect(page.getByText("Revenue")).toBeVisible();
  for (const s of ["Tenants & people", "Activity", "Platform"]) await expect(page.locator(".portal-sidebar .portal-nav-section").getByText(s, { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Tenants" }).click();
  await page.locator(".qs-grid").getByRole("searchbox").fill("Organizer");
  await expect(page.locator(".qs-grid tbody tr")).toHaveCount(1);
  await page.locator(".qs-grid tbody tr").first().click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByText(mail("organizer"))).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/05-admin-tenant.png` });
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "Payments" }).click();
  await page.locator(".qs-grid").getByRole("searchbox").fill("PW ");
  // Declined / failed-3DS attempts are recorded as Failed (webhook), next to the two Paid ones.
  await expect(page.locator(".qs-grid tbody tr")).toHaveCount(4);
  await expect(page.locator(".qs-grid tbody")).toContainText("Failed");
  await page.locator(".qs-grid").getByLabel("Status").selectOption("succeeded");
  await expect(page.locator(".qs-grid tbody tr")).toHaveCount(2);
  await expect(page.locator(".qs-grid tbody")).not.toContainText("Failed");
  await expect(page.locator(".qs-grid")).toContainText("VISA •••• 4242");
  await page.screenshot({ path: `${SHOTS}/06-admin-payments.png` });

  const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
  await signInAs(ctx2, organizer);
  const p2 = await ctx2.newPage();
  await p2.goto("/admin");
  await p2.waitForURL(/\/app/);
  await ctx2.close();
});
