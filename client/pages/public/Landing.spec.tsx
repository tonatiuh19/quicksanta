import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Landing from "./Landing";
import { mockApi, renderApp } from "@/test/render";

describe("Landing", () => {
  it("shows hero, how-it-works, pricing plans and a working FAQ + examples", async () => {
    mockApi({});
    renderApp(<Landing />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Gift exchanges, made magical.");
    expect(screen.getByText("From idea to secret match in 4 steps")).toBeInTheDocument();
    for (const plan of ["Free", "Pro", "Enterprise"]) expect(screen.getByRole("heading", { name: plan })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: /family/i }));
    expect(screen.getByText("Gómez Family Christmas")).toBeInTheDocument();
    const q = screen.getByRole("button", { name: /can the organizer see/i });
    await userEvent.click(q);
    expect(q).toHaveAttribute("aria-expanded", "true");
  });
});
