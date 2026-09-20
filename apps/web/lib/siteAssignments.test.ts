import { describe, expect, it } from "vitest";
import { selectedSiteIds, toggleSiteSelection } from "./siteAssignments.js";

describe("administrator site assignments", () => {
  it("derives assigned site identifiers from the server response", () => {
    expect(selectedSiteIds([
      { id: "a", name: "A", code: "A", assigned: true },
      { id: "b", name: "B", code: "B", assigned: false },
    ])).toEqual(["a"]);
  });

  it("adds and removes a site without duplicates", () => {
    expect(toggleSiteSelection(["a"], "b", true)).toEqual(["a", "b"]);
    expect(toggleSiteSelection(["a", "b"], "a", false)).toEqual(["b"]);
  });
});
