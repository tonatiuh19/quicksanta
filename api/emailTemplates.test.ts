import { describe, expect, it } from "vitest";
import { generateOtpCode, newPublicId, parseCookies, slugify, tplAssignment, tplInvite, tplOtp } from "./index";

describe("email templates", () => {
  it("OTP email contains the code in EN and ES", () => {
    expect(tplOtp("en", "123456").subject).toContain("123456");
    expect(tplOtp("es", "123456").text).toContain("Tu código");
  });
  it("invite escapes HTML from user input", () => {
    const t = tplInvite("en", { organizer: "<b>x</b>", eventName: "Office", typeName: "Secret Santa", date: null, budget: "20–30 USD", link: "https://x/join/abc" });
    expect(t.html).not.toContain("<b>x</b>");
    expect(t.html).toContain("&lt;b&gt;");
    expect(t.html).toContain("https://x/join/abc");
  });
  it("assignment email links to the reveal page", () => {
    expect(tplAssignment("es", { eventName: "Familia", link: "https://x/app/my/1" }).text).toContain("https://x/app/my/1");
  });
});

describe("utils", () => {
  it("generateOtpCode is always 6 digits", () => {
    for (let i = 0; i < 500; i++) expect(generateOtpCode()).toMatch(/^\d{6}$/);
  });
  it("newPublicId is 26 sortable chars", () => {
    const a = newPublicId(1_700_000_000_000);
    const b = newPublicId(1_700_000_000_001);
    expect(a).toHaveLength(26);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
  });
  it("slugify strips accents and symbols", () => {
    expect(slugify("Navidad Pérez & Co.!")).toBe("navidad-perez-co");
    expect(slugify("🎁")).toBe("team");
  });
  it("parseCookies", () => {
    expect(parseCookies("a=1; qs_sid=abc%20d; bad")).toEqual({ a: "1", qs_sid: "abc d" });
  });
});
