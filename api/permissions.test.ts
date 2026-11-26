import { describe, expect, it } from "vitest";
import { PLATFORM_PERMS as API_PLATFORM, TENANT_PERMS as API_TENANT } from "./index";
import { PLATFORM_PERMS, TENANT_PERMS } from "../shared/api";

describe("permission matrix mirror", () => {
  it("api/index.ts inline copy matches shared/api.ts", () => {
    expect(API_PLATFORM).toEqual(PLATFORM_PERMS);
    expect(API_TENANT).toEqual(TENANT_PERMS);
  });
});
