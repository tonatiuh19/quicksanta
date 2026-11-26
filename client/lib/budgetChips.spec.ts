import { describe, expect, it } from "vitest";
import { budgetChips } from "@/pages/public/Wizard";

describe("budget chips follow the currency", () => {
  it("USD keeps small amounts; MXN / COP scale to sensible local numbers", () => {
    expect(budgetChips("USD")).toEqual([10, 20, 25, 50, 100]);
    expect(budgetChips("MXN")).toEqual([200, 400, 500, 1000, 2000]);
    expect(budgetChips("COP")).toEqual([40000, 80000, 100000, 200000, 400000]);
    expect(budgetChips("XYZ")).toEqual([10, 20, 25, 50, 100]);
  });
});
