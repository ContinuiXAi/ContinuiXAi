import { describe, expect, it } from "vitest";
import { shouldAcceptCameraScan, shouldUseZxingCamera } from "./cameraScanGuard";

describe("shouldAcceptCameraScan", () => {
  it("accepts the first camera read", () => {
    expect(shouldAcceptCameraScan("123456789012", null, 1000)).toBe(true);
  });

  it("blocks the same UPC when two camera engines detect the same physical scan", () => {
    expect(shouldAcceptCameraScan("123456789012", { value: "123456789012", at: 1000 }, 1450)).toBe(false);
  });

  it("allows a different UPC immediately", () => {
    expect(shouldAcceptCameraScan("999999999999", { value: "123456789012", at: 1000 }, 1100)).toBe(true);
  });

  it("allows the same UPC again after the camera guard interval", () => {
    expect(shouldAcceptCameraScan("123456789012", { value: "123456789012", at: 1000 }, 2050)).toBe(true);
  });
});

describe("camera engine selection", () => {
  it("uses ZXing only while the retail assist is unavailable", () => {
    expect(shouldUseZxingCamera(false)).toBe(true);
    expect(shouldUseZxingCamera(true)).toBe(false);
  });
});
