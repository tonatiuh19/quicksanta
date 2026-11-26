import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import Legal from "./Legal";
import i18n from "@/i18n";
import { mockApi, renderApp } from "@/test/render";

describe("Legal pages", () => {
  it("renders the Privacy Policy (EN) with ARCO rights and processors", () => {
    mockApi({});
    renderApp(<Legal doc="privacy" />, { route: "/privacy", path: "/privacy" });
    expect(screen.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeInTheDocument();
    expect(screen.getByText(/Your ARCO rights/)).toBeInTheDocument();
    expect(screen.getByText(/Stripe/, { selector: "strong" })).toBeInTheDocument();
  });

  it("renders the Terms in Spanish with the $8.90/month plan and cancellation rules", async () => {
    mockApi({});
    await i18n.changeLanguage("es");
    renderApp(<Legal doc="terms" />, { route: "/terms", path: "/terms" });
    expect(screen.getByRole("heading", { level: 1, name: "Términos y Condiciones" })).toBeInTheDocument();
    expect(screen.getByText(/US\$8.90 al mes por espacio/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Aviso de Privacidad" })).toHaveAttribute("href", "/privacy");
    await i18n.changeLanguage("en");
  });
});
