import { describe, expect, it } from "vitest";
import { countInstruction, overageInstruction, shortageInstruction } from "./inventoryTruthPresentation";

describe("inventory truth count guidance", () => {
  it("describes expected inventory as a store total and tells employees to count products", () => {
    expect(countInstruction({ expectedStoreQty: 15 })).toBe("15 expected in the store. Count every actual product at this location—not the shelf tag.");
  });

  it("explains a shortage only after the listed locations have been checked", () => {
    expect(shortageInstruction(2)).toBe("2 units are still missing after the listed locations were checked. Choose a reason or request manager review.");
  });

  it("asks employees to confirm product and location for an overage", () => {
    expect(overageInstruction(3)).toBe("3 extra units found. Confirm the product and location.");
  });
});
