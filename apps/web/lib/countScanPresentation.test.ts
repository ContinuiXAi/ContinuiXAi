import { describe, expect, it } from "vitest";
import { buildCountScanPresentation } from "./countScanPresentation";

describe("buildCountScanPresentation", () => {
  it("shows the real-world details for a known scanned item", () => {
    expect(buildCountScanPresentation({
      barcodeValue: "012345678905",
      quantityAdded: 1,
      currentQuantity: 4,
      productName: "Mr. Clean Clean Freak",
      locationCode: "A1-01",
      locationName: "Cleaning Aisle",
    })).toEqual({
      title: "Mr. Clean Clean Freak",
      upc: "012345678905",
      location: "A1-01 — Cleaning Aisle",
      added: 1,
      current: 4,
      known: true,
      announcement: "Added 1 of Mr. Clean Clean Freak to A1-01 — Cleaning Aisle. Ready for the next item.",
    });
  });

  it("shows manual quantities without hiding the resulting count", () => {
    expect(buildCountScanPresentation({
      barcodeValue: "012345678905",
      quantityAdded: 12,
      currentQuantity: 36,
      productName: "Claritin",
      locationCode: "RX-01",
      locationName: null,
    })).toMatchObject({ added: 12, current: 36, location: "RX-01" });
  });

  it("keeps an unknown UPC visible for review", () => {
    expect(buildCountScanPresentation({
      barcodeValue: "999999999999",
      quantityAdded: 1,
      currentQuantity: 1,
      productName: null,
      locationCode: "EC-01",
      locationName: "Endcap",
    })).toEqual({
      title: "Unknown product",
      upc: "999999999999",
      location: "EC-01 — Endcap",
      added: 1,
      current: 1,
      known: false,
      announcement: "Added 1 of UPC 999999999999 to EC-01 — Endcap. Product details need review.",
    });
  });
});
