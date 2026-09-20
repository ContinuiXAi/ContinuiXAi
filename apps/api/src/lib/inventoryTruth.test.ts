import { describe, expect, it } from "vitest";
import { buildLocationRoute, computeStoreDifference, expectedStoreTotal } from "./inventoryTruth.js";

describe("inventory truth calculations", () => {
  it("includes locationless POS-like events in the expected store total", () => {
    const transactions = [
      { locationId: "receiving", quantity: 20 },
      { locationId: null, quantity: -3 },
      { locationId: null, quantity: -2 },
    ];

    expect(expectedStoreTotal(transactions)).toBe(15);
  });

  it("compares the expected store total with actual quantities across every counted location", () => {
    expect(computeStoreDifference(15, [
      { locationId: "shelf", quantity: 8 },
      { locationId: "display", quantity: 5 },
    ])).toEqual({ actualTotal: 13, difference: -2 });
  });

  it("builds one location-first route without exposing an expected quantity per location", () => {
    const locationHints = [
      { id: "back", sortOrder: 20, code: "BACK", evidence: "PREVIOUSLY_COUNTED" },
      { id: "shelf", sortOrder: 10, code: "A1", evidence: "ASSIGNED" },
    ];

    expect(buildLocationRoute(locationHints)).toEqual(["shelf", "back"]);
    expect(locationHints.map((location) => location.id)).toEqual(["back", "shelf"]);
  });

  it("uses code and id as deterministic route tie-breakers", () => {
    expect(buildLocationRoute([
      { id: "z", sortOrder: 10, code: "A1" },
      { id: "a", sortOrder: 10, code: "A1" },
      { id: "b", sortOrder: 10, code: "B1" },
    ])).toEqual(["a", "z", "b"]);
  });
});
