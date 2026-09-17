import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiJson: vi.fn(),
  push: vi.fn(),
  show: vi.fn(),
  user: { id: "admin-a" },
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("./api", () => ({ apiJson: mocks.apiJson }));
vi.mock("./auth-context", () => ({
  useAuth: () => ({ user: mocks.user, loading: false }),
}));
vi.mock("./toast-context", () => ({ useToast: () => ({ show: mocks.show }) }));
vi.mock("../components/BrandLockup", () => ({
  BrandLockup: () => createElement("div", null, "ContinuiXAi"),
}));

import StoreProductsPage from "../app/store-products/page";
import type { InventoryStockState } from "./types";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("pilot product catalog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  function stockPage(id: string, nextCursor: string | null = null): InventoryStockState {
    return { rows: [{ product: { id, name: `Stock ${id}`, barcodeValue: null, manufacturer: null, packageSize: null }, onHand: "-1.5000", asOf: "2026-09-17T12:00:00.000Z", committed: { status: "notTracked" }, incoming: { status: "notTracked" } }], nextCursor };
  }

  function mockCatalog(stock: (url: string) => Promise<InventoryStockState>) {
    mocks.apiJson.mockImplementation(async (url: string) => {
      if (url === "/api/products?includeInactive=true" || url === "/api/categories") return [];
      if (url === "/api/inventory-truth/sites") return [{ id: "site-a", code: "A", name: "First" }, { id: "site-b", code: "B", name: "Second" }];
      return stock(url);
    });
  }

  async function selectSite(value: string) {
    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>('select[aria-label="Stock site"]')!;
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  it("makes the historical quantity report discoverable from Products", async () => {
    mockCatalog(async () => stockPage("first"));
    await act(async () => root.render(createElement(StoreProductsPage)));
    expect(container.querySelector('a[href="/inventory-history"]')?.textContent).toBe("Inventory history");
  });

  it("ignores a previous site's response after a site change", async () => {
    let finishFirst!: (value: InventoryStockState) => void;
    mockCatalog(async (url) => url.includes("site-a/") ? new Promise((resolve) => { finishFirst = resolve; }) : stockPage("second"));
    await act(async () => root.render(createElement(StoreProductsPage)));
    await selectSite("site-a");
    expect(container.textContent).toContain("Loading current stock");
    await selectSite("site-b");
    expect(container.textContent).toContain("Stock second");
    await act(async () => finishFirst(stockPage("first")));
    expect(container.textContent).toContain("Stock second");
    expect(container.textContent).not.toContain("Stock first");
  });

  it("clears stock and ignores pending errors when site selection is cleared", async () => {
    let reject!: (error: Error) => void;
    mockCatalog(async () => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
    await act(async () => root.render(createElement(StoreProductsPage)));
    await selectSite("site-a");
    await selectSite("");
    await act(async () => reject(new Error("Old site failed")));
    expect(container.textContent).toContain("Select a site to see current stock.");
    expect(container.textContent).not.toContain("Old site failed");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("appends subsequent pages and resets rows on a site change", async () => {
    mockCatalog(async (url) => url.includes("site-b/") ? stockPage("other-site") : url.includes("cursor=") ? stockPage("page-two") : stockPage("page-one", "next+/cursor"));
    await act(async () => root.render(createElement(StoreProductsPage)));
    expect(mocks.apiJson.mock.calls.some(([url]) => url.includes("/stock-state"))).toBe(false);
    await selectSite("site-a");
    const more = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Show more")!;
    await act(async () => more.click());
    expect(mocks.apiJson).toHaveBeenCalledWith("/api/inventory-truth/sites/site-a/stock-state?limit=50&cursor=next%2B%2Fcursor");
    expect(container.textContent).toContain("Stock page-one");
    expect(container.textContent).toContain("Stock page-two");
    expect(container.textContent).not.toContain("Show more");
    await selectSite("site-b");
    expect(container.textContent).toContain("Stock other-site");
    expect(container.textContent).not.toContain("Stock page-one");
  });

  it("shows balance errors without presenting them as zero stock", async () => {
    mockCatalog(async () => { throw new Error("Ledger unavailable"); });
    await act(async () => root.render(createElement(StoreProductsPage)));
    await selectSite("site-a");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Ledger unavailable");
    expect(container.textContent).not.toContain("On hand:");
  });

  it("retains existing rows when pagination fails and allows retry", async () => {
    mockCatalog(async (url) => {
      if (url.includes("cursor=")) throw new Error("Page unavailable");
      return stockPage("page-one", "next");
    });
    await act(async () => root.render(createElement(StoreProductsPage)));
    await selectSite("site-a");
    await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Show more")!.click());
    expect(container.textContent).toContain("Stock page-one");
    expect(container.textContent).toContain("Page unavailable");
    expect(Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Show more")?.disabled).toBe(false);
  });

  it("reports site-list failures instead of claiming there are no accessible sites", async () => {
    mocks.apiJson.mockImplementation(async (url: string) => {
      if (url === "/api/inventory-truth/sites") throw new Error("Sites unavailable");
      return [];
    });
    await act(async () => root.render(createElement(StoreProductsPage)));
    expect(container.textContent).toContain("Sites unavailable");
    expect(container.textContent).not.toContain("No active sites are available");
  });

  it("keeps authorized sites usable when the catalog requires organization selection", async () => {
    const unhandledRejections: unknown[] = [];
    const recordUnhandled = (reason: unknown) => { unhandledRejections.push(reason); };
    process.on("unhandledRejection", recordUnhandled);
    try {
      mocks.apiJson.mockImplementation(async (url: string) => {
        if (url === "/api/products?includeInactive=true") throw new Error("select one authorized organization");
        if (url === "/api/categories") return [];
        if (url === "/api/inventory-truth/sites") return [{ id: "site-a", code: "A", name: "Authorized site" }];
        if (url === "/api/inventory-truth/sites/site-a/stock-state?limit=50") return stockPage("authorized");
        throw new Error(`Unexpected request: ${url}`);
      });
      await act(async () => root.render(createElement(StoreProductsPage)));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      expect(container.querySelector('select[aria-label="Stock site"] option[value="site-a"]')).not.toBeNull();
      expect(container.textContent).toContain("Authorized site");
      expect(container.textContent).not.toContain("No active sites are available");
      expect(container.textContent).toContain("select one authorized organization");
      await selectSite("site-a");
      expect(container.textContent).toContain("Stock authorized");
      expect(container.textContent).toContain("On hand: -1.5000");
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", recordUnhandled);
    }
  });

  it("makes sites selectable before an unrelated catalog request finishes", async () => {
    let resolveProducts!: (products: unknown[]) => void;
    mocks.apiJson.mockImplementation(async (url: string) => {
      if (url === "/api/products?includeInactive=true") return new Promise((resolve) => { resolveProducts = resolve; });
      if (url === "/api/categories") return [];
      if (url === "/api/inventory-truth/sites") return [{ id: "site-a", code: "A", name: "Authorized site" }];
      return stockPage("authorized");
    });
    await act(async () => root.render(createElement(StoreProductsPage)));
    try {
      expect(container.querySelector('select[aria-label="Stock site"] option[value="site-a"]')).not.toBeNull();
      expect(container.textContent).not.toContain("No active sites are available");
      await selectSite("site-a");
      expect(container.textContent).toContain("Stock authorized");
    } finally {
      await act(async () => resolveProducts([]));
    }
  });

  it("reports an empty site list and does not fetch balances", async () => {
    mocks.apiJson.mockResolvedValue([]);
    await act(async () => root.render(createElement(StoreProductsPage)));
    expect(container.textContent).toContain("No active sites are available to your account.");
    expect(mocks.apiJson.mock.calls.some(([url]) => url.includes("/stock-state"))).toBe(false);
  });

  it("does not claim there are no sites while the site list is still loading", async () => {
    let resolveSites!: (sites: unknown[]) => void;
    mocks.apiJson.mockImplementation(async (url: string) => url === "/api/inventory-truth/sites"
      ? new Promise((resolve) => { resolveSites = resolve; }) : []);
    await act(async () => root.render(createElement(StoreProductsPage)));
    expect(container.textContent).toContain("Loading sites");
    expect(container.textContent).not.toContain("No active sites are available");
    await act(async () => resolveSites([]));
    expect(container.textContent).toContain("No active sites are available");
    expect(container.textContent).not.toContain("Loading sites");
  });

  it("shows an empty product page without inventing balances", async () => {
    mockCatalog(async () => ({ rows: [], nextCursor: null }));
    await act(async () => root.render(createElement(StoreProductsPage)));
    await selectSite("site-a");
    expect(container.textContent).toContain("No active products at this site.");
    expect(container.textContent).not.toContain("On hand:");
  });

  it("loads products when the optional legacy category endpoint is unavailable", async () => {
    mocks.apiJson.mockImplementation(async (url: string) => {
      if (url === "/api/products?includeInactive=true") {
        return [{
          id: "product-a",
          barcodeValue: "012345678905",
          name: "Pilot Product",
          manufacturer: "ContinuiXAi",
          description: null,
          packageSize: "1 count",
          imageUrl: null,
          categoryId: null,
          category: null,
          isActive: true,
        }];
      }
      if (url === "/api/categories") throw new Error("Not found (404)");
      if (url === "/api/inventory-truth/sites") return [];
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () => root.render(createElement(StoreProductsPage)));
    await act(async () => undefined);

    expect(container.textContent).toContain("Pilot Product");
    expect(container.textContent).toContain("UPC 012345678905");
  });

  it("requires a site before showing truthful stock-state values", async () => {
    mocks.apiJson.mockImplementation(async (url: string) => {
      if (url === "/api/products?includeInactive=true") return [];
      if (url === "/api/categories") return [];
      if (url === "/api/inventory-truth/sites") return [{ id: "site-a", code: "MAIN", name: "Main Store" }];
      if (url === "/api/inventory-truth/sites/site-a/stock-state?limit=50") return {
        rows: [{
          product: { id: "product-a", barcodeValue: null, name: "Truthful product", manufacturer: null, packageSize: null },
          onHand: "-1.5000",
          asOf: "2026-09-17T12:00:00.000Z",
          committed: { status: "notTracked" },
          incoming: { status: "notTracked" },
        }],
        nextCursor: null,
      };
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () => root.render(createElement(StoreProductsPage)));
    await act(async () => undefined);

    expect(container.textContent).toContain("Select a site to see current stock.");
    expect(container.textContent).toContain("Count's Expected in store is frozen at count start.");
    const siteSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Stock site"]');
    expect(siteSelect).not.toBeNull();
    await act(async () => {
      siteSelect!.value = "site-a";
      siteSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(container.textContent).toContain("On hand: -1.5000");
    expect(container.textContent).toContain("Committed — not tracked");
    expect(container.textContent).toContain("Incoming — not tracked");
    expect(container.textContent).toContain("Ledger creation cutoff:");
  });
});
