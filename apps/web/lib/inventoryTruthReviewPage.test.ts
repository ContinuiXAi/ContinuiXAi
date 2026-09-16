import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ apiJson: vi.fn(), user: { id: "employee" } as { id: string } | null, queue: [] as Array<{ sessionId: string }>, search: "count" }));
vi.mock("./api", () => ({ apiJson: mocks.apiJson }));
vi.mock("./auth-context", () => ({ useAuth: () => ({ user: mocks.user, loading: false }) }));
vi.mock("./storeCountQueue", () => ({ getCountQueue: () => mocks.queue }));
vi.mock("next/navigation", () => ({ useSearchParams: () => ({ get: () => mocks.search }) }));
import CountReviewPage from "../app/store-count/review/page";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const discrepancy = () => ({ id: "d1", productId: "product", product: { name: "Vitamin B12", barcodeValue: "01234", packageSize: "60 tablets" }, expectedStoreQty: 15, actualStoreQty: 13, difference: -2, reason: null, note: null, status: "OPEN", reviewToken: "a".repeat(64), countedLocations: [{ locationId: "shelf", code: "A1", name: "Vitamins", quantity: 8 }, { locationId: "back", code: "BACK", name: "Stockroom", quantity: 5 }] });
type Review = { sessionId: string; sessionStatus: string; finalized: boolean; canExplain: boolean; canApprove: boolean; discrepancies: Array<ReturnType<typeof discrepancy> & { reason: string | null; note: string | null }> };
let data: Review;
let container: HTMLDivElement;
let root: Root;
const button = (name: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === name)!;
async function render() { await act(async () => { root.render(createElement(CountReviewPage)); }); }
async function click(name: string) { await act(async () => { button(name).click(); }); }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(() => {
  vi.clearAllMocks(); mocks.user = { id: "employee" }; mocks.queue = []; mocks.search = "count";
  data = { sessionId: "count", sessionStatus: "ACTIVE", finalized: true, canExplain: true, canApprove: false, discrepancies: [discrepancy()] };
  mocks.apiJson.mockImplementation(async (_path: string, init?: RequestInit) => {
    if (init?.method === "PATCH") { const body = JSON.parse(String(init.body)); data.discrepancies[0] = { ...data.discrepancies[0], ...body }; return data.discrepancies[0]; }
    if (init?.method === "POST") { data.discrepancies[0].status = "APPROVED"; return { discrepancy: data.discrepancies[0] }; }
    return structuredClone(data);
  });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });
describe("Count review employee and manager interactions", () => {
  it("discovers a completed pending review after reload without a remembered session ID", async () => {
    mocks.search = "";
    mocks.apiJson.mockResolvedValue({ pending: [{ id: "completed-count", name: "Vitamin Count", status: "COMPLETED", startedAt: "2026-09-15T00:00:00Z", site: { name: "Boynton Store" }, startedBy: { name: "Alex" } }], completed: [] });
    await render();
    expect(container.textContent).toContain("Vitamin Count"); expect(container.textContent).toContain("Boynton Store");
    expect(container.querySelector('a[href="/store-count/review?sessionId=completed-count"]')).not.toBeNull();
  });
  it("keeps historical counts discoverable when the original employee record is unavailable", async () => {
    mocks.search = "";
    mocks.apiJson.mockResolvedValue({ pending: [], completed: [{ id: "historical", name: "Old count", status: "COMPLETED", startedAt: "2026-09-15T00:00:00Z", site: { name: "Store" }, startedBy: null }] });
    await render();
    expect(container.querySelector('a[href="/store-count/review?sessionId=historical"]')).not.toBeNull();
    expect(container.textContent).toContain("Employee not recorded");
  });
  it("shows exact product and store totals, neutral shortage instructions and every counted location", async () => {
    await render();
    for (const text of ["Vitamin B12", "01234", "60 tablets", "Expected in store", "Actual counted", "Difference", "A1", "BACK", "8", "5", "2 units are still missing"]) expect(container.textContent).toContain(text);
    expect(container.textContent).not.toMatch(/employee stole|expected here/i);
    expect(button("Approve new baseline")).toBeUndefined();
    expect(container.querySelector('a[href="/store-count?sessionId=count"]')).not.toBeNull();
  });
  it("requires a reason, permits an empty note, and saves the employee explanation", async () => {
    await render(); expect(button("Save explanation").disabled).toBe(true);
    const select = container.querySelector("select")!;
    expect(select.getAttribute("aria-label")).toBe("Reason for Vitamin B12");
    await act(async () => { select.value = "COULD_NOT_FIND"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    const textarea = container.querySelector("textarea")!;
    expect(textarea.maxLength).toBe(500);
    await click("Save explanation");
    expect(mocks.apiJson.mock.calls.find(([, init]) => init?.method === "PATCH")).toEqual(["/api/inventory-truth/counts/count/discrepancies/d1/explain", expect.objectContaining({ body: JSON.stringify({ reason: "COULD_NOT_FIND", note: "" }) })]);
    expect(container.textContent).toContain("Explanation saved");
  });
  it("shows neutral overage and resolved status without any write controls", async () => {
    data.discrepancies[0].difference = 3; await render();
    expect(container.textContent).toContain("3 extra units found. Confirm the product and location.");
    data.discrepancies[0].status = "RESOLVED"; mocks.user = { id: "other" }; await render();
    expect(container.textContent).toContain("No difference remains");
    expect(button("Save explanation")).toBeUndefined(); expect(button("Approve new baseline")).toBeUndefined();
  });
  it("only exposes approval using server permission, and serializes rapid taps", async () => {
    data.canApprove = true; data.canExplain = false; data.discrepancies[0].reason = "COULD_NOT_FIND" as never;
    const pending = deferred<unknown>();
    mocks.apiJson.mockImplementation(async (_path: string, init?: RequestInit) => init?.method === "POST" ? pending.promise : structuredClone(data));
    await render();
    await act(async () => { button("Approve new baseline").click(); button("Approve new baseline").click(); });
    expect(mocks.apiJson.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(button("Approving…").disabled).toBe(true);
    data.discrepancies[0].status = "APPROVED";
    await act(async () => { pending.resolve({ discrepancy: data.discrepancies[0] }); });
    expect(container.textContent).toContain("Baseline approved"); expect(button("Approve new baseline")).toBeUndefined();
  });
  it("retains approval identity on network failure and offers a safe retry", async () => {
    data.canApprove = true; data.canExplain = false; data.discrepancies[0].reason = "COULD_NOT_FIND" as never;
    await render(); mocks.apiJson.mockRejectedValueOnce(new Error("Network unavailable"));
    await click("Approve new baseline");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Network unavailable");
    expect(button("Approve new baseline").disabled).toBe(false);
    await click("Approve new baseline");
    const posts = mocks.apiJson.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(2); expect(posts[0][1].body).toBe(posts[1][1].body);
    expect(container.textContent).toContain("Baseline approved");
  });
  it("provides load failure retry without showing stale actions", async () => {
    mocks.apiJson.mockRejectedValueOnce(new Error("Cannot reach store")); await render();
    expect(container.textContent).toContain("Cannot reach store"); expect(button("Save explanation")).toBeUndefined();
    await click("Retry loading review"); expect(container.textContent).toContain("Vitamin B12");
  });
  it("removes stale approval controls when the post-save refresh fails", async () => {
    data.canApprove = true; data.canExplain = false; data.discrepancies[0].reason = "COULD_NOT_FIND" as never;
    await render();
    mocks.apiJson.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("Refresh unavailable"));
    await click("Approve new baseline");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Refresh unavailable");
    expect(document.activeElement).toBe(container.querySelector('[role="alert"]'));
    expect(button("Approve new baseline")).toBeUndefined();
    expect(button("Retry loading review")).toBeDefined();
    data.discrepancies[0].status = "APPROVED";
    await click("Retry loading review");
    expect(container.textContent).toContain("Baseline approved");
  });
  it("blocks same-session unsynced evidence but not other-session work", async () => {
    mocks.queue = [{ sessionId: "count" }]; await render();
    expect(container.textContent).toContain("Return to Count to sync"); expect(button("Save explanation").disabled).toBe(true);
    mocks.queue = [{ sessionId: "another" }]; await render();
    const select = container.querySelector("select")!;
    await act(async () => { select.value = "OTHER_MANAGER_REVIEW"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(button("Save explanation").disabled).toBe(false);
  });
  it("ignores old identity's delayed load", async () => {
    const pending = deferred<unknown>(); mocks.apiJson.mockImplementationOnce(() => pending.promise);
    await render(); mocks.user = { id: "new" }; data.canExplain = false; data.canApprove = false; data.discrepancies[0].product.name = "New employee product";
    await render();
    await act(async () => { pending.resolve({ ...data, canApprove: true, discrepancies: [discrepancy()] }); });
    expect(container.textContent).toContain("New employee product"); expect(container.textContent).not.toContain("Vitamin B12");
    expect(button("Approve new baseline")).toBeUndefined();
  });
  it("keeps completed counts read-only for employees", async () => {
    data.sessionStatus = "COMPLETED"; data.canExplain = false; await render();
    expect(container.textContent).toContain("Count is finished and locked"); expect(container.querySelector("select")).toBeNull();
  });
  it.each(["Save explanation", "Approve new baseline"])("preserves another card's draft across deferred %s refresh", async (action) => {
    data.canApprove = true; data.discrepancies[0].reason = "COULD_NOT_FIND" as never;
    data.discrepancies.push({ ...discrepancy(), id: "d2", productId: "second", product: { ...discrepancy().product, name: "Vitamin D" } });
    await render();
    const select = container.querySelectorAll("select")[1];
    const textarea = container.querySelectorAll("textarea")[1];
    await act(async () => {
      select.value = "RECEIVING_PROBLEM"; select.dispatchEvent(new Event("change", { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Checked receiving carton");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const refresh = deferred<unknown>();
    mocks.apiJson.mockResolvedValueOnce({}).mockImplementationOnce(() => refresh.promise);
    await click(action);
    expect(container.textContent).toContain("Loading count review");
    await act(async () => { refresh.resolve(structuredClone(data)); });
    expect(container.querySelectorAll("select")[1].value).toBe("RECEIVING_PROBLEM");
    expect(container.querySelectorAll("textarea")[1].value).toBe("Checked receiving carton");
    mocks.user = { id: "different-employee" }; await render();
    expect(container.querySelectorAll("select")[1].value).toBe("");
    expect(container.querySelectorAll("textarea")[1].value).toBe("");
  });
});
