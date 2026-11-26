import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("swagger.yaml", () => {
  it("documents every route registered in api/index.ts", () => {
    const src = readFileSync(path.join(import.meta.dirname, "index.ts"), "utf8");
    const yaml = readFileSync(path.join(import.meta.dirname, "swagger.yaml"), "utf8");
    const routes = [...src.matchAll(/app\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)].map(([, m, p]) => ({ m, p: p.replace(/:(\w+)/g, "{$1}") }));
    expect(routes.length).toBeGreaterThan(30);
    const missing = routes.filter(({ m, p }) => {
      const block = yaml.split(`\n  ${p}:\n`)[1]?.split(/\n  \/api/)[0] ?? "";
      return !new RegExp(`\\n    ${m}:`).test(`\n${block}`);
    });
    expect(missing).toEqual([]);
  });
});
