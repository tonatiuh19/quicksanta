import { expect, test } from "@playwright/test";
import { cleanup, forceOtp, mail, makeUser, noSidewaysScroll, SHOTS, signInAs } from "./helpers";

test.describe.configure({ mode: "serial" });
test.afterAll(async () => {
  await cleanup();
});

let eventId = 0;
let organizer: Awaited<ReturnType<typeof makeUser>>;
let code = "";

test("organizer turns on the invite link: code, QR, limits (desktop + phone)", async ({ page, context }) => {
  organizer = await makeUser("linkorg");
  await signInAs(context, organizer);
  const launch = await page.request.post("/api/wizard/launch", {
    headers: { Origin: "https://localhost:8080" },
    data: { eventTypeSlug: "secret_santa", name: "PW Link Party", currency: "USD", organizerName: "Link Org", includeMe: true, participants: [{ name: "Ana", email: mail("lana") }, { name: "Bo", email: mail("lbo") }], exclusions: [], sendInvites: false },
  });
  expect(launch.status()).toBe(201);
  eventId = (await launch.json()).event_id;

  await page.goto(`/app/events/${eventId}`);
  await expect(page.getByText(/turn it on to get a link/i)).toBeVisible();
  await page.getByText("Let people join with a link").click();
  const codeEl = page.locator(".qs-invite-code strong");
  await expect(codeEl).toHaveText(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  code = (await codeEl.textContent())!;
  await expect(page.getByLabel("Invite link")).toHaveValue(new RegExp(`/j/${code}$`));
  await expect(page.getByRole("link", { name: /whatsapp/i })).toHaveAttribute("href", /wa\.me/);
  await page.screenshot({ path: `${SHOTS}/invite-01-panel.png`, fullPage: true });

  await page.getByRole("button", { name: /qr code/i }).click();
  await expect(page.getByRole("img", { name: /qr code to join/i })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/invite-02-qr.png` });
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: /^limits$/i }).click();
  await page.getByLabel(/max people through the link/i).fill("5");
  await page.getByRole("button", { name: /^save$/i }).click();
  await expect(page.getByText(/cap 5/)).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator(".qs-invite-code strong")).toHaveText(code);
  await noSidewaysScroll(page);
  await page.locator(".qs-invite-link").scrollIntoViewIfNeeded();
  await page.locator(".qs-invite-link").screenshot({ path: `${SHOTS}/invite-03-panel-mobile.png` });
});

test("a stranger types the code, signs in with OTP and joins; organizer sees 'via link'", async ({ browser, page, context }) => {
  const phone = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } });
  const p = await phone.newPage();
  await p.goto("/login");
  await p.getByRole("link", { name: /join an exchange/i }).click();
  await p.getByLabel(/invite code/i).fill(code.toLowerCase().replace("-", ""));
  await p.getByRole("button", { name: /find exchange/i }).click();
  await expect(p.getByRole("heading", { name: "PW Link Party" })).toBeVisible();
  await expect(p.getByText(/link org invited you/i)).toBeVisible();
  await noSidewaysScroll(p);
  await p.screenshot({ path: `${SHOTS}/invite-04-join-mobile.png`, fullPage: true });

  const email = mail("stranger").toLowerCase();
  await p.getByLabel("Email").fill(email);
  await p.getByRole("button", { name: /email me a code/i }).click();
  const otp = await forceOtp(email);
  await p.getByLabel("Your name").fill("Sam Stranger");
  await p.getByLabel("Digit 1 of 6").fill(otp);
  await expect(p.getByText(`You'll join as ${email}`)).toBeVisible();
  await p.getByRole("button", { name: /join the exchange/i }).click();
  await p.waitForURL(/\/app\/my\//);
  await phone.close();

  // Organizer sees the newcomer, tagged "via link", and can filter by it.
  await signInAs(context, organizer);
  await page.goto(`/app/events/${eventId}`);
  const row = page.locator(".qs-grid tbody tr", { hasText: "Sam Stranger" });
  await expect(row).toBeVisible();
  await expect(row.getByText("via link")).toBeVisible();
  await expect(page.getByText(/1 person joined with the link/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/invite-05-organizer-grid.png`, fullPage: true });
});
