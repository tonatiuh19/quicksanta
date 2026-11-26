import { describe, expect, it } from "vitest";
import { drawAssignments, expandExclusions } from "./index";

function seeded(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 2 ** 32;
    return seed / 2 ** 32;
  };
}

function assertValid(ids: number[], out: Map<number, number>, excluded: Array<[number, number]> = []) {
  expect(out.size).toBe(ids.length);
  expect(new Set(out.values()).size).toBe(ids.length);
  for (const [g, r] of out) {
    expect(g).not.toBe(r);
    expect(excluded.some(([a, b]) => a === g && b === r)).toBe(false);
  }
}

describe("drawAssignments", () => {
  it("produces a valid derangement for many random seeds", () => {
    const ids = [1, 2, 3, 4, 5, 6, 7, 8];
    for (let s = 1; s < 200; s++) assertValid(ids, drawAssignments(ids, [], seeded(s))!);
  });

  it("honors bidirectional exclusions (couples never draw each other)", () => {
    const ids = [1, 2, 3, 4, 5, 6];
    const excluded = expandExclusions([
      { giver: 1, receiver: 2, bidirectional: true },
      { giver: 3, receiver: 4, bidirectional: true },
      { giver: 5, receiver: 6, bidirectional: false },
    ]);
    expect(excluded).toHaveLength(5);
    for (let s = 1; s < 100; s++) assertValid(ids, drawAssignments(ids, excluded, seeded(s))!, excluded);
  });

  it("returns null when constraints make a draw impossible", () => {
    // 1 can give to nobody.
    expect(drawAssignments([1, 2, 3], [[1, 2], [1, 3]])).toBeNull();
    expect(drawAssignments([1], [])).toBeNull();
  });

  it("handles large groups quickly", () => {
    const ids = Array.from({ length: 300 }, (_, i) => i + 1);
    const excluded = expandExclusions(ids.filter((i) => i % 2).map((i) => ({ giver: i, receiver: i + 1, bidirectional: true })));
    const t = Date.now();
    assertValid(ids, drawAssignments(ids, excluded)!, excluded);
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it("two-person draw is a swap", () => {
    const out = drawAssignments([1, 2], [])!;
    expect([...out.entries()]).toEqual(expect.arrayContaining([[1, 2], [2, 1]]));
  });
});
