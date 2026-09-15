import { describe, expect, it } from "vitest";
import {
  MAX_INVENTORY_QUANTITY,
  expandComposition,
  expandVersionedComposition,
  resolvePackagingQuantity,
} from "./packagingResolution.js";

describe("resolvePackagingQuantity", () => {
  it("keeps each quantities unchanged", () => {
    expect(resolvePackagingQuantity({ unitsOfEach: 1 }, 7)).toBe(7);
  });

  it("multiplies a standard case pack into eaches", () => {
    expect(resolvePackagingQuantity({ unitsOfEach: 12 }, 3)).toBe(36);
  });

  it("rejects missing or non-positive pack quantities instead of guessing", () => {
    expect(() => resolvePackagingQuantity({ unitsOfEach: 0 }, 1)).toThrow(/pack quantity/i);
    expect(() => resolvePackagingQuantity({ unitsOfEach: 12 }, 0)).toThrow(/requested quantity/i);
  });

  it("rejects pack multiplication beyond the supported business maximum", () => {
    expect(() => resolvePackagingQuantity({ unitsOfEach: MAX_INVENTORY_QUANTITY }, 2)).toThrow(/maximum/i);
  });
});

describe("expandComposition", () => {
  it("expands 100 displays into every component each quantity", () => {
    const components = [
      { productId: "A", quantityPerParent: 4 },
      { productId: "B", quantityPerParent: 6 },
      { productId: "C", quantityPerParent: 3 },
      { productId: "D", quantityPerParent: 8 },
      { productId: "E", quantityPerParent: 2 },
      { productId: "F", quantityPerParent: 5 },
      { productId: "G", quantityPerParent: 7 },
    ];

    expect(expandComposition(components, 100)).toEqual([
      { productId: "A", eachQuantity: 400 },
      { productId: "B", eachQuantity: 600 },
      { productId: "C", eachQuantity: 300 },
      { productId: "D", eachQuantity: 800 },
      { productId: "E", eachQuantity: 200 },
      { productId: "F", eachQuantity: 500 },
      { productId: "G", eachQuantity: 700 },
    ]);
  });

  it("rejects an invalid display component instead of partially expanding", () => {
    expect(() => expandComposition([
      { productId: "A", quantityPerParent: 4 },
      { productId: "B", quantityPerParent: 0 },
    ], 5)).toThrow(/component quantity/i);
  });
});

describe("expandVersionedComposition", () => {
  it("expands two displays into component-only ledger quantities", () => {
    expect(expandVersionedComposition([
      { parentPackagingId: "packaging-v2", componentProductId: "A", quantityPerParent: 4, version: 2, isActive: true },
      { parentPackagingId: "packaging-v2", componentProductId: "B", quantityPerParent: 6, version: 2, isActive: true },
      { parentPackagingId: "packaging-v2", componentProductId: "C", quantityPerParent: 3, version: 2, isActive: true },
    ], "DISPLAY", 2)).toEqual([
      { productId: "A", eachQuantity: 8 },
      { productId: "B", eachQuantity: 12 },
      { productId: "C", eachQuantity: 6 },
    ]);
  });

  it("aggregates duplicate component rows before producing ledger quantities", () => {
    expect(expandVersionedComposition([
      { parentPackagingId: "packaging-v2", componentProductId: "A", quantityPerParent: 2, version: 2, isActive: true },
      { parentPackagingId: "packaging-v2", componentProductId: "A", quantityPerParent: 3, version: 2, isActive: true },
    ], "DISPLAY", 4)).toEqual([
      { productId: "A", eachQuantity: 20 },
    ]);
  });

  it.each([0, -1])("rejects component quantity %s", (quantityPerParent) => {
    expect(() => expandVersionedComposition([
      { parentPackagingId: "packaging-v2", componentProductId: "A", quantityPerParent, version: 2, isActive: true },
    ], "DISPLAY", 1)).toThrow(/component quantity/i);
  });

  it("rejects a parent product as its own component", () => {
    expect(() => expandVersionedComposition([
      { parentPackagingId: "packaging-v2", componentProductId: "DISPLAY", quantityPerParent: 1, version: 2, isActive: true },
    ], "DISPLAY", 1)).toThrow(/invalid display component/i);
  });

  it("rejects an empty recipe or invalid parent quantity", () => {
    expect(() => expandVersionedComposition([], "DISPLAY", 1)).toThrow(/at least one component/i);
    expect(() => expandVersionedComposition([
      { parentPackagingId: "packaging-v2", componentProductId: "A", quantityPerParent: 1, version: 2, isActive: true },
    ], "DISPLAY", 0)).toThrow(/parent quantity/i);
  });

  it("rejects an inactive historical recipe before producing ledger inputs", () => {
    expect(() => expandVersionedComposition([
      { parentPackagingId: "packaging-v1", componentProductId: "A", quantityPerParent: 4, version: 1, isActive: false },
    ], "DISPLAY", 2)).toThrow(/inactive/i);
  });

  it("rejects rows mixed across recipe versions", () => {
    expect(() => expandVersionedComposition([
      { parentPackagingId: "packaging-a", componentProductId: "A", quantityPerParent: 4, version: 1, isActive: true },
      { parentPackagingId: "packaging-a", componentProductId: "B", quantityPerParent: 6, version: 2, isActive: true },
    ], "DISPLAY", 2)).toThrow(/single packaging and version/i);
  });

  it("rejects rows mixed across parent packaging definitions", () => {
    expect(() => expandVersionedComposition([
      { parentPackagingId: "packaging-a", componentProductId: "A", quantityPerParent: 4, version: 2, isActive: true },
      { parentPackagingId: "packaging-b", componentProductId: "B", quantityPerParent: 6, version: 2, isActive: true },
    ], "DISPLAY", 2)).toThrow(/single packaging and version/i);
  });

  it("rejects an individual component above the PostgreSQL integer maximum", () => {
    expect(() => expandVersionedComposition([
      { parentPackagingId: "packaging-a", componentProductId: "A", quantityPerParent: MAX_INVENTORY_QUANTITY + 1, version: 2, isActive: true },
    ], "DISPLAY", 1)).toThrow(/maximum/i);
  });

  it("rejects unsafe integer inputs", () => {
    expect(() => expandVersionedComposition([
      { parentPackagingId: "packaging-a", componentProductId: "A", quantityPerParent: Number.MAX_SAFE_INTEGER + 1, version: 2, isActive: true },
    ], "DISPLAY", 1)).toThrow(/safe integer/i);
  });

  it("rejects duplicate-row aggregate overflow", () => {
    expect(() => expandVersionedComposition([
      { parentPackagingId: "packaging-a", componentProductId: "A", quantityPerParent: MAX_INVENTORY_QUANTITY, version: 2, isActive: true },
      { parentPackagingId: "packaging-a", componentProductId: "A", quantityPerParent: 1, version: 2, isActive: true },
    ], "DISPLAY", 1)).toThrow(/maximum/i);
  });

  it("rejects parent multiplication overflow", () => {
    expect(() => expandVersionedComposition([
      { parentPackagingId: "packaging-a", componentProductId: "A", quantityPerParent: MAX_INVENTORY_QUANTITY, version: 2, isActive: true },
    ], "DISPLAY", 2)).toThrow(/maximum/i);
  });
});
