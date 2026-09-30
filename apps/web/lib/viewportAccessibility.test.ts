import { describe, expect, it } from "vitest";
import { viewport } from "../app/layout";

describe("phone viewport accessibility", () => {
  it("allows users to pinch zoom the application", () => {
    expect(viewport.maximumScale).toBeUndefined();
    expect(viewport.userScalable).not.toBe(false);
  });
});
