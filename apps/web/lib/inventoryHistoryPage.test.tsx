import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import InventoryHistoryPage from "../app/inventory-history/page";
import { inventoryHistoryCsv, type InventoryHistory } from "./inventoryHistoryCsv";

const mocks = vi.hoisted(() => ({ apiJson: vi.fn(), user: { id: "manager" } as { id: string } | null }));
vi.mock("./api", () => ({ apiJson: mocks.apiJson }));
vi.mock("./auth-context", () => ({ useAuth: () => ({ user: mocks.user, loading: false }) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: Root;
const cutoff = "2026-09-17T12:00:00.000Z";
const report = (): InventoryHistory => ({ siteId: "site-a", asOfExclusive: cutoff, recordedBefore: null, valuationStatus: "unavailable", catalogMetadata: "current", quantityBasis: "signedLedgerEventsByUnit", nextCursor: "product-a", rows: [{ product: { id: "product-a", name: "Vitamin B12", barcodeValue: "0123", isActive: false }, quantity: "-1.2500", unitOfMeasure: "EACH", provenance: { source: "inventoryLedger", eventCount: 3, firstOccurredAt: "2026-09-01T00:00:00.000Z", lastOccurredAt: "2026-09-16T00:00:00.000Z", lastRecordedAt: "2026-09-18T00:00:00.000Z" } }] });
const button = (name: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === name);
async function render() {
  await act(async () => { root.render(createElement(InventoryHistoryPage)); });
}
async function click(name: string) { expect(button(name), `Button ${name} must exist`).toBeDefined(); await act(async () => { button(name)!.click(); }); }
async function input(label: string, value: string) {
  const element = container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
  expect(element, `Input ${label} must exist`).not.toBeNull();
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); });
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
beforeEach(() => {
  vi.clearAllMocks(); mocks.user = { id: "manager" };
  mocks.apiJson.mockImplementation(async (path: string) => path === "/api/inventory-truth/sites" ? [{ id: "site-a", name: "Main store" }] : report());
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

describe("Point-in-time quantity report", () => {
  it("requires authentication before fetching any store data", async () => {
    mocks.user = null; await render(); expect(container.textContent).toContain("Sign in"); expect(mocks.apiJson).not.toHaveBeenCalled();
  });
  it("shows quantity-only semantics, exact signed quantities, archived metadata and event provenance", async () => {
    await render(); await input("Effective cutoff (exclusive)", cutoff); await click("Load quantities");
    for (const text of ["Monetary valuation unavailable — cost accounting is not configured.", "occurredAt <", "createdAt <", "backdated", "current catalog", cutoff, "Vitamin B12", "Archived", "-1.2500", "EACH", "3", "2026-09-18T00:00:00.000Z"]) expect(container.textContent).toContain(text);
    expect(mocks.apiJson).toHaveBeenLastCalledWith(`/api/inventory-history/sites/site-a/as-of?asOfExclusive=${encodeURIComponent(cutoff)}&limit=50`);
    expect(button("Export this page CSV")).toBeDefined();
  });
  it("passes the optional recorded cutoff and paginates with identical cutoffs", async () => {
    await render(); await input("Effective cutoff (exclusive)", cutoff); await input("Recorded before (optional)", "2026-09-16T00:00:00Z"); await click("Load quantities"); await click("Next page");
    const last = mocks.apiJson.mock.calls.at(-1)![0];
    expect(last).toContain(`asOfExclusive=${encodeURIComponent(cutoff)}`); expect(last).toContain("recordedBefore=2026-09-16T00%3A00%3A00Z"); expect(last).toContain("cursor=product-a");
  });
  it("invalidates a report and export when filters change", async () => {
    await render(); await click("Load quantities"); expect(container.textContent).toContain("Vitamin B12");
    await input("Effective cutoff (exclusive)", "2026-09-01T00:00:00Z"); expect(container.textContent).not.toContain("Vitamin B12"); expect(button("Export this page CSV")).toBeUndefined();
  });
  it("shows no history separately from a known zero and handles empty pages", async () => {
    const data = report(); data.nextCursor = null; data.rows[0].quantity = "0.0000"; data.rows[0].provenance.eventCount = 0; data.rows[0].unitOfMeasure = null;
    mocks.apiJson.mockImplementation(async (path: string) => path.endsWith("/sites") ? [{ id: "site-a", name: "Main store" }] : data);
    await render(); await click("Load quantities"); expect(container.textContent).toContain("No ledger history before these cutoffs"); expect(button("Next page")).toBeUndefined();
    data.rows = []; await click("Load quantities"); expect(container.textContent).toContain("No products on this page");
  });
  it("exposes retry after report failure without stale data or CSV", async () => {
    await render(); await click("Load quantities"); mocks.apiJson.mockRejectedValueOnce(new Error("Store unavailable")); await click("Next page");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Store unavailable"); expect(button("Export this page CSV")).toBeUndefined();
    await click("Load quantities"); expect(container.textContent).toContain("Vitamin B12");
  });
  it("retries site discovery", async () => {
    mocks.apiJson.mockRejectedValueOnce(new Error("Sites unavailable")); await render();
    expect(container.textContent).toContain("Sites unavailable"); await click("Retry stores"); expect(container.textContent).toContain("Main store");
  });
  it("disables loading when no sites are available", async () => {
    mocks.apiJson.mockResolvedValue([]); await render();
    expect(container.textContent).toContain("No accessible active stores"); expect(button("Load quantities")!.disabled).toBe(true);
  });
  it("ignores old identity's delayed report and prevents rapid duplicate loads", async () => {
    const pending = deferred<ReturnType<typeof report>>(); await render(); mocks.apiJson.mockImplementationOnce(() => pending.promise);
    await act(async () => { button("Load quantities")!.click(); button("Load quantities")!.click(); });
    expect(mocks.apiJson.mock.calls.filter(([path]) => path.includes("/as-of"))).toHaveLength(1);
    mocks.user = { id: "another" }; await render(); await act(async () => { pending.resolve(report()); });
    expect(container.textContent).not.toContain("Vitamin B12"); expect(button("Export this page CSV")).toBeUndefined();
  });
  it("downloads the current page through the export control", async () => {
    const create = vi.fn(() => "blob:history"), revoke = vi.fn();
    vi.stubGlobal("URL", class extends URL { static createObjectURL = create; static revokeObjectURL = revoke; });
    const anchor = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try { await render(); await click("Load quantities"); await click("Export this page CSV"); expect(create).toHaveBeenCalledOnce(); expect(anchor).toHaveBeenCalledOnce(); expect((anchor.mock.instances[0] as HTMLAnchorElement).download).toBe("inventory-history-page.csv"); }
    finally { anchor.mockRestore(); vi.unstubAllGlobals(); }
  });
});

describe("Formula-safe CSV", () => {
  it("quotes separators and quotes, neutralizes formulas including whitespace/control prefixes, and includes cutoff/provenance", async () => {
    const data = report(); data.rows[0].product.name = ' =HYPERLINK("bad"),\nname'; data.rows[0].product.barcodeValue = "\t@SUM(1)"; data.rows[0].unitOfMeasure = "+unsafe";
    const csv = inventoryHistoryCsv(data);
    expect(csv).toContain('"\' =HYPERLINK(""bad""),\nname"'); expect(csv).toContain('"\'\t@SUM(1)"'); expect(csv).toContain('"\'+unsafe"'); expect(csv).toContain('"\'-1.2500"');
    for (const value of [cutoff, "unavailable", "inventoryLedger", "2026-09-18T00:00:00.000Z", "current"]) expect(csv).toContain(value);
  });
});
