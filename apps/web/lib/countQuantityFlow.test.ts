import { describe, expect, it } from "vitest";
import { buildConfirmedCountScan, normalizeCountQuantity, type PendingCountItem } from "./countQuantityFlow";

describe("normalizeCountQuantity", () => {
  it.each([["1", 1], ["12", 12], ["999", 999]])("accepts %s", (value, expected) => {
    expect(normalizeCountQuantity(value)).toBe(expected);
  });

  it.each(["", "0", "-1", "1.5", "1000", "abc"]) ("rejects %s", (value) => {
    expect(normalizeCountQuantity(value)).toBeNull();
  });
});

describe("buildConfirmedCountScan", () => {
  it("preserves the exact product and location identity", () => {
    const item: PendingCountItem = {
      barcodeValue: "012345678905",
      productId: "product-123",
      productName: "Widget",
      packageSize: "12 pack",
      known: true,
    };

    expect(buildConfirmedCountScan(item, 12, "location-456")).toEqual({
      ...item,
      locationId: "location-456",
      quantity: 12,
    });
  });

  it("preserves unknown product state", () => {
    const item: PendingCountItem = {
      barcodeValue: "unknown-barcode",
      productId: null,
      productName: null,
      packageSize: null,
      known: false,
    };

    expect(buildConfirmedCountScan(item, 1, "location-456")).toEqual({
      ...item,
      locationId: "location-456",
      quantity: 1,
    });
  });

  it.each([
    [0, "location-456"],
    [1.5, "location-456"],
    [Number.NaN, "location-456"],
    [1000, "location-456"],
    [1, ""],
  ])("rejects invalid confirmation (%s, %s)", (quantity, locationId) => {
    const item: PendingCountItem = {
      barcodeValue: "012345678905",
      productId: "product-123",
      productName: "Widget",
      packageSize: "12 pack",
      known: true,
    };

    expect(() => buildConfirmedCountScan(item, quantity, locationId)).toThrow(
      "Invalid confirmed count scan.",
    );
  });
});
