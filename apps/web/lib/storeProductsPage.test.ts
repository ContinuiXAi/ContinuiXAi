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
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () => root.render(createElement(StoreProductsPage)));
    await act(async () => undefined);

    expect(container.textContent).toContain("Pilot Product");
    expect(container.textContent).toContain("UPC 012345678905");
  });
});
