import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Login from "./Login";
import { fail, mockApi, renderApp, user } from "@/test/render";

describe("Login (passwordless OTP)", () => {
  it("validates the email locally before calling the API", async () => {
    const calls = mockApi({ get: { "/auth/me": fail(401, "errors.unauthorized") } });
    renderApp(<Login />, { route: "/login", path: "/login" });
    await userEvent.type(await screen.findByLabelText("Email"), "not-an-email");
    await userEvent.click(screen.getByRole("button", { name: /email me a code/i }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid email.");
    expect(calls.some((c) => c.url === "/auth/otp/request")).toBe(false);
  });

  it("requests a code, verifies it and redirects into the app", async () => {
    let verified = false;
    const calls = mockApi({
      get: { "/auth/me": () => (verified ? { user: user() } : fail(401, "errors.unauthorized")) },
      post: {
        "/auth/otp/request": { ok: true, sent: true, is_new: false },
        "/auth/otp/verify": () => ((verified = true), { ok: true }),
      },
    });
    renderApp(<Login />, { route: "/login", path: "/login" });
    await userEvent.type(await screen.findByLabelText("Email"), "Alex@Example.com");
    await userEvent.click(screen.getByRole("button", { name: /email me a code/i }));
    expect(await screen.findByText(/we sent a code to alex@example.com/i)).toBeInTheDocument();
    expect(calls.find((c) => c.url === "/auth/otp/request")!.body).toEqual({ email: "alex@example.com" });

    await userEvent.click(screen.getByLabelText("Digit 1 of 6"));
    await userEvent.paste("123456");
    await waitFor(() => expect(screen.getByText("app-page")).toBeInTheDocument());
    expect(calls.find((c) => c.url === "/auth/otp/verify")!.body).toMatchObject({ email: "alex@example.com", code: "123456" });
  });

  it("shows a translated error for a wrong code", async () => {
    mockApi({
      get: { "/auth/me": fail(401, "errors.unauthorized") },
      post: { "/auth/otp/request": { ok: true, sent: true }, "/auth/otp/verify": fail(400, "errors.otpInvalid", { attempts_left: 4 }) },
    });
    renderApp(<Login />, { route: "/login", path: "/login" });
    await userEvent.type(await screen.findByLabelText("Email"), "a@example.com");
    await userEvent.click(screen.getByRole("button", { name: /email me a code/i }));
    await userEvent.click(await screen.findByLabelText("Digit 1 of 6"));
    await userEvent.paste("000000");
    expect(await screen.findByText("That code is wrong or expired.")).toBeInTheDocument();
  });
});
