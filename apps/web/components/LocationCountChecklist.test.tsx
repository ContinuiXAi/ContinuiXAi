import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LocationCountChecklist from "./LocationCountChecklist";
import type { CountRoute } from "../lib/inventoryTruthPresentation";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const products = Array.from({ length: 10 }, (_, index) => ({
  productId: `product-${index + 1}`,
  barcodeValue: `00000000000${index}`,
  name: `Vitamin ${index + 1}`,
  packageSize: `${30 + index} tablets`,
  expectedStoreQty: 15 + index,
  suspectedLocations: [
    { locationId: "location-1", code: "VIT-01", verified: false, evidence: "ASSIGNED" as const },
    { locationId: "location-2", code: "END-01", verified: true, evidence: "DISPLAY_COMPONENT" as const },
  ],
}));

const location: CountRoute["locations"][number] = {
  id: "location-1",
  code: "VIT-01",
  name: "Vitamin Bay",
  status: "PENDING",
  routePosition: 2,
  completedLocations: 1,
  totalLocations: 4,
  products,
};

describe("LocationCountChecklist", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(
    checkedProductIds = new Set<string>(),
    locked = false,
    onSelectProduct = vi.fn(),
    onCompleteLocation = vi.fn(async () => undefined),
    options: { completionBlocked?: boolean; focusProductId?: string | null; onMarkProductAbsent?: (productId: string) => void } = {},
  ) {
    await act(async () => root.render(createElement(LocationCountChecklist, {
      location,
      checkedProductIds,
      locked,
      onSelectProduct,
      onCompleteLocation,
      completionBlocked: options.completionBlocked,
      focusProductId: options.focusProductId,
      onMarkProductAbsent: options.onMarkProductAbsent ?? vi.fn(),
    })));
    return { onSelectProduct, onCompleteLocation };
  }

  function button(label: string) {
    const match = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((candidate) => candidate.textContent?.trim() === label);
    if (!match) throw new Error(`Button not found: ${label}`);
    return match;
  }

  it("shows one location, its route progress, and every assigned product with store-total language", async () => {
    await render();

    expect(container.querySelector("h2")?.textContent).toContain("VIT-01 — Vitamin Bay");
    expect(container.textContent).toContain("1 of 4 locations complete");
    expect(container.textContent).toContain("Location 2 of 4");
    expect(container.querySelectorAll('[data-product-id]')).toHaveLength(10);
    expect(container.textContent).toContain("Vitamin 1");
    expect(container.textContent).toContain("30 tablets");
    expect(container.textContent).toContain("UPC 000000000000");
    expect(container.textContent).toContain("Expected in store");
    expect(container.textContent).not.toContain("Expected here");
    expect(container.textContent).toContain("VIT-01 · Not checked");
    expect(container.textContent).toContain("END-01 · Checked");
    expect(container.textContent).toContain("Suggested places to check — stock is not guaranteed there");

    const completionActions = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .filter((candidate) => candidate.textContent?.trim() === "Location complete");
    expect(completionActions).toHaveLength(1);
    expect(completionActions[0].classList.contains("secondary")).toBe(false);
    expect(completionActions[0].disabled).toBe(true);
    expect(Array.from(container.querySelectorAll("button")).at(-1)).toBe(completionActions[0]);
  });

  it("selects a listed product and resumes keyboard focus at the first unchecked product", async () => {
    const onSelectProduct = vi.fn();
    await render(new Set(["product-1", "product-2"]), false, onSelectProduct);

    const firstUnchecked = button("Count Vitamin 3");
    expect(document.activeElement).toBe(firstUnchecked);
    expect(getComputedStyle(firstUnchecked).outlineStyle).not.toBe("none");

    await act(async () => firstUnchecked.click());
    expect(onSelectProduct).toHaveBeenCalledWith("product-3");
  });

  it("enables completion only after every product is checked and locks it during save or queued work", async () => {
    const complete = vi.fn(async () => undefined);
    const allChecked = new Set(products.map((product) => product.productId));
    await render(allChecked, false, vi.fn(), complete);

    expect(button("Location complete").disabled).toBe(false);
    await act(async () => button("Location complete").click());
    expect(complete).toHaveBeenCalledTimes(1);

    await render(allChecked, true, vi.fn(), complete);
    expect(button("Location complete").disabled).toBe(true);
    expect(button("Count Vitamin 1").disabled).toBe(true);
  });

  it("records an absent product through None here and keeps capture available when only completion is blocked", async () => {
    const markAbsent = vi.fn();
    await render(new Set(), false, vi.fn(), vi.fn(async () => undefined), {
      completionBlocked: true,
      onMarkProductAbsent: markAbsent,
    });

    expect(button("Count Vitamin 1").disabled).toBe(false);
    expect(button("None here for Vitamin 1").disabled).toBe(false);
    expect(button("Location complete").disabled).toBe(true);
    await act(async () => button("None here for Vitamin 1").click());
    expect(markAbsent).toHaveBeenCalledWith("product-1");
  });

  it("returns focus to a requested product after quantity confirmation is cancelled", async () => {
    await render(new Set(), false, vi.fn(), vi.fn(async () => undefined), { focusProductId: "product-7" });
    expect(document.activeElement?.textContent?.trim()).toBe("Count Vitamin 7");
  });
});
