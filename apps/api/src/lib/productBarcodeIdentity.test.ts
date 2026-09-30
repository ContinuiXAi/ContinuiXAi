import { describe, expect, it } from "vitest";
import { retailBarcodeDuplicateWhere } from "./productBarcodeIdentity.js";

describe("retail product identifier duplicate filters", () => {
  it("matches each equivalent representation only against its real identifier type", () => {
    const where = retailBarcodeDuplicateWhere(
      "org-a",
      "012345000058",
      "UPC_A",
      "01234558",
    );

    expect(where).toEqual({
      organizationId: "org-a",
      OR: [
        { barcodeValue: { in: ["012345000058", "0012345000058"] } },
        { identifiers: { some: { value: "012345000058", type: { in: ["UPC", "GTIN"] } } } },
        { identifiers: { some: { value: "0012345000058", type: { in: ["EAN", "GTIN"] } } } },
        { identifiers: { some: { value: "01234558", type: { in: ["UPC", "GTIN"] } } } },
      ],
    });
  });

  it("does not conflate an explicit EAN-8 with a typed UPC-E alias", () => {
    expect(retailBarcodeDuplicateWhere("org-a", "01234558", "EAN_8", null)).toEqual({
      organizationId: "org-a",
      OR: [
        { barcodeValue: { in: ["01234558"] } },
        { identifiers: { some: { value: "01234558", type: { in: ["EAN", "GTIN"] } } } },
      ],
    });
  });
});
