import { describe, expect, it } from "vitest";
import {
  buildExpectationSnapshotData,
  buildLocationVisitData,
  buildSummaryRows,
  type SummaryEntryInput,
} from "./storeCount.js";
import * as storeCountModule from "./storeCount.js";

describe("buildSummaryRows", () => {
  it("merges different barcodes that resolve to the same product", () => {
    const entries: SummaryEntryInput[] = [
      { productId: "prod_1", barcodeValue: "0001", quantity: 3, locationId: "loc_a", location: { code: "Z99" }, product: { name: "Widget", packageSize: "1ct" } },
      { productId: "prod_1", barcodeValue: "0002-case", quantity: 2, locationId: "loc_b", location: { code: "K10" }, product: { name: "Widget", packageSize: "1ct" } },
    ];
    const rows = buildSummaryRows(entries);
    expect(rows).toHaveLength(1);
    expect(rows[0].total).toBe(5);
    expect(rows[0].byLocation.loc_a.quantity).toBe(3);
    expect(rows[0].byLocation.loc_b.quantity).toBe(2);
  });

  it("rolls the same UPC across multiple store locations into one site total", () => {
    const entries: SummaryEntryInput[] = [
      { productId: "prod_1", barcodeValue: "012345678905", quantity: 4, locationId: "front", location: { code: "FRONT" }, product: { name: "Widget", packageSize: "1ct" } },
      { productId: "prod_1", barcodeValue: "012345678905", quantity: 6, locationId: "back", location: { code: "BACK" }, product: { name: "Widget", packageSize: "1ct" } },
    ];

    const rows = buildSummaryRows(entries);
    expect(rows).toHaveLength(1);
    expect(rows[0].barcodeValue).toBe("012345678905");
    expect(rows[0].total).toBe(10);
    expect(rows[0].byLocation.front).toEqual({ locationCode: "FRONT", quantity: 4 });
    expect(rows[0].byLocation.back).toEqual({ locationCode: "BACK", quantity: 6 });
  });

  it("keeps unidentified barcodes separate", () => {
    const entries: SummaryEntryInput[] = [
      { productId: null, barcodeValue: "9999", quantity: 1, locationId: "loc_a", location: { code: "Z99" }, product: null },
      { productId: null, barcodeValue: "8888", quantity: 1, locationId: "loc_a", location: { code: "Z99" }, product: null },
    ];
    expect(buildSummaryRows(entries)).toHaveLength(2);
  });

  it("preserves an unknown UPC as one exception while rolling quantities across locations", () => {
    const entries: SummaryEntryInput[] = [
      { productId: null, barcodeValue: "unknown-123", quantity: 2, locationId: "aisle_1", location: { code: "A1" }, product: null },
      { productId: null, barcodeValue: "unknown-123", quantity: 3, locationId: "endcap", location: { code: "EC" }, product: null },
    ];

    const rows = buildSummaryRows(entries);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      productId: null,
      barcodeValue: "unknown-123",
      productName: null,
      total: 5,
    });
    expect(rows[0].byLocation.aisle_1.quantity).toBe(2);
    expect(rows[0].byLocation.endcap.quantity).toBe(3);
  });

  it("accumulates quantities at the same location", () => {
    const entries: SummaryEntryInput[] = [
      { productId: "prod_1", barcodeValue: "0001", quantity: 2, locationId: "loc_a", location: { code: "Z99" }, product: { name: "Widget", packageSize: null } },
      { productId: "prod_1", barcodeValue: "0001", quantity: 1, locationId: "loc_a", location: { code: "Z99" }, product: { name: "Widget", packageSize: null } },
    ];
    expect(buildSummaryRows(entries)[0].byLocation.loc_a.quantity).toBe(3);
  });

  it("sorts by product name", () => {
    const entries: SummaryEntryInput[] = [
      { productId: "prod_z", barcodeValue: "z", quantity: 1, locationId: "loc_a", location: { code: "Z99" }, product: { name: "Zebra Snacks", packageSize: null } },
      { productId: "prod_a", barcodeValue: "a", quantity: 1, locationId: "loc_a", location: { code: "Z99" }, product: { name: "Apple Juice", packageSize: null } },
    ];
    expect(buildSummaryRows(entries).map((row) => row.productName)).toEqual(["Apple Juice", "Zebra Snacks"]);
  });

  it("returns an empty array for an empty session", () => {
    expect(buildSummaryRows([])).toEqual([]);
  });

  it("keeps an explicitly checked zero entry in store and location totals", () => {
    const rows = buildSummaryRows([
      { productId: "absent-product", barcodeValue: "000000000009", quantity: 0, locationId: "loc_a", location: { code: "A1" }, product: { name: "Absent vitamin", packageSize: "39 tablets" } },
    ]);
    expect(rows).toEqual([{
      key: "absent-product",
      productId: "absent-product",
      barcodeValue: "000000000009",
      productName: "Absent vitamin",
      packageSize: "39 tablets",
      total: 0,
      byLocation: { loc_a: { locationCode: "A1", quantity: 0 } },
    }]);
  });
});

describe("store count inventory truth snapshots", () => {
  it("preserves signed store totals, including sums produced by locationless events", () => {
    expect(buildExpectationSnapshotData([
      { productId: "product-a", _sum: { quantity: 15 } },
      { productId: "product-b", _sum: { quantity: -2 } },
    ], "session-a")).toEqual([
      { sessionId: "session-a", productId: "product-a", expectedStoreQty: 15 },
      { sessionId: "session-a", productId: "product-b", expectedStoreQty: -2 },
    ]);
  });

  it("creates one deterministic visit per active required hinted location", () => {
    expect(buildLocationVisitData([
      { locationId: "back", location: { id: "back", sortOrder: 20, code: "BACK" } },
      { locationId: "shelf", location: { id: "shelf", sortOrder: 10, code: "A1" } },
      { locationId: "shelf", location: { id: "shelf", sortOrder: 10, code: "A1" } },
      { locationId: "shelf-z", location: { id: "shelf-z", sortOrder: 10, code: "A1" } },
    ], "session-a")).toEqual([
      { sessionId: "session-a", locationId: "shelf" },
      { sessionId: "session-a", locationId: "shelf-z" },
      { sessionId: "session-a", locationId: "back" },
    ]);
  });
});

describe("store count discrepancy rows", () => {
  it("omits products whose physical store total matches the expectation", () => {
    const buildDiscrepancyRows = (storeCountModule as Record<string, unknown>).buildDiscrepancyRows as
      | ((expectations: Array<{ productId: string; expectedStoreQty: number }>, actuals: Array<{ productId: string; _sum: { quantity: number | null } }>, sessionId: string) => unknown[])
      | undefined;

    expect(typeof buildDiscrepancyRows).toBe("function");
    expect(buildDiscrepancyRows?.(
      [{ productId: "matched-product", expectedStoreQty: 10 }],
      [{ productId: "matched-product", _sum: { quantity: 10 } }],
      "session-a",
    )).toEqual([]);
  });

  it("produces one signed shortage or overage row per session and product", () => {
    const buildDiscrepancyRows = (storeCountModule as Record<string, unknown>).buildDiscrepancyRows as
      | ((expectations: Array<{ productId: string; expectedStoreQty: number }>, actuals: Array<{ productId: string; _sum: { quantity: number | null } }>, sessionId: string) => unknown[])
      | undefined;

    expect(typeof buildDiscrepancyRows).toBe("function");
    expect(buildDiscrepancyRows?.(
      [
        { productId: "short-product", expectedStoreQty: 10 },
        { productId: "over-product", expectedStoreQty: 5 },
      ],
      [
        { productId: "short-product", _sum: { quantity: 7 } },
        { productId: "over-product", _sum: { quantity: 9 } },
        { productId: "unexpected-product", _sum: { quantity: 2 } },
      ],
      "session-a",
    )).toEqual([
      { sessionId: "session-a", productId: "over-product", expectedStoreQty: 5, actualStoreQty: 9, difference: 4 },
      { sessionId: "session-a", productId: "short-product", expectedStoreQty: 10, actualStoreQty: 7, difference: -3 },
      { sessionId: "session-a", productId: "unexpected-product", expectedStoreQty: 0, actualStoreQty: 2, difference: 2 },
    ]);
  });
});
