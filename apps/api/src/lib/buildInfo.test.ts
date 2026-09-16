import { describe, expect, it } from "vitest";
import { resolveBuildSha } from "./buildInfo.js";

describe("build identity", () => {
  it("prefers the explicit build SHA and falls back safely", () => {
    expect(resolveBuildSha({ BUILD_SHA: "abc", RAILWAY_GIT_COMMIT_SHA: "rail" })).toBe("abc");
    expect(resolveBuildSha({ RAILWAY_GIT_COMMIT_SHA: "rail" })).toBe("rail");
    expect(resolveBuildSha({})).toBe("unknown");
  });
});
