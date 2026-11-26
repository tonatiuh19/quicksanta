import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import en from "./locales/en/translation.json";
import es from "./locales/es/translation.json";

function keys(o: any, p = ""): string[] {
  return Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? keys(v, `${p}${k}.`) : [`${p}${k}`]));
}
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const full = path.join(dir, f);
    return statSync(full).isDirectory() ? files(full) : /\.(ts|tsx)$/.test(f) && !/\.spec\./.test(f) ? [full] : [];
  });
}

describe("i18n catalogs", () => {
  it("EN and ES have exactly the same keys", () => {
    expect(keys(es).sort()).toEqual(keys(en).sort());
  });

  it("every literal t(\"…\") key used in the client and every API error key exists", () => {
    const enKeys = new Set(keys(en));
    const root = path.resolve(import.meta.dirname, "..");
    const src = [...files(path.join(root, "client")), path.join(root, "api/index.ts")].map((f) => readFileSync(f, "utf8")).join("\n");
    const used = new Set<string>();
    for (const m of src.matchAll(/\bt\(\s*"([a-zA-Z][\w]*(?:\.[\w]+)+)"/g)) used.add(m[1]);
    for (const m of src.matchAll(/(?:labelKey|section|titleKey)[:=]\s*"([a-zA-Z][\w]*(?:\.[\w]+)+)"/g)) used.add(m[1]);
    for (const m of src.matchAll(/"((?:errors|validation)\.[a-zA-Z]+)"/g)) used.add(m[1]);
    const missing = [...used].filter((k) => !enKeys.has(k));
    expect(missing).toEqual([]);
  });
});
