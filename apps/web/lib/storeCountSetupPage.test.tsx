import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiJson: vi.fn(),
  push: vi.fn(),
  show: vi.fn(),
  user: { id: "manager-a", role: "GENERAL", taskManager: true } as {
    id: string;
    role: "ADMIN" | "GENERAL";
    taskManager: boolean;
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => new URLSearchParams("sessionId=empty-session&siteId=site-a"),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => createElement("a", { href }, children),
}));
vi.mock("./api", () => ({ apiJson: mocks.apiJson }));
vi.mock("./auth-context", () => ({ useAuth: () => ({ user: mocks.user, loading: false }) }));
vi.mock("./toast-context", () => ({ useToast: () => ({ show: mocks.show }) }));
vi.mock("../components/BrandLockup", () => ({ BrandLockup: () => createElement("div", null, "ContinuiXAi") }));

import StoreCountSetupPage from "../app/store-count/setup/page";

describe("Store Count setup page", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user = { id: "manager-a", role: "GENERAL", taskManager: true };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/store-locations") return [{ id: "shelf", code: "A1", name: "Front shelf", isActive: true }];
      if (url === "/api/products") return [{ id: "product-a", name: "Vitamin B12", barcodeValue: "012345678905", packageSize: "60 tablets" }];
      if (url === "/api/inventory-truth/products/product-a/location-hints" && init?.method === "POST") return { id: "hint-a" };
      if (url === "/api/store-count/sessions/empty-session/cancel" && init?.method === "POST") return { ok: true };
      if (url === "/api/store-count/sessions" && init?.method === "POST") return { id: "new-session" };
      throw new Error(`Unexpected request: ${url}`);
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("assigns the first product location and opens a fresh count", async () => {
    await act(async () => root.render(createElement(StoreCountSetupPage)));
    await act(async () => undefined);

    const submit = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Assign and start count"))!;
    await act(async () => submit.click());

    expect(mocks.apiJson).toHaveBeenCalledWith(
      "/api/inventory-truth/products/product-a/location-hints",
      {
        method: "POST",
        body: JSON.stringify({ siteId: "site-a", locationId: "shelf", evidence: "ASSIGNED", isRequired: true }),
      },
    );
    expect(mocks.apiJson).toHaveBeenCalledWith("/api/store-count/sessions/empty-session/cancel", { method: "POST" });
    expect(mocks.apiJson).toHaveBeenCalledWith("/api/store-count/sessions", {
      method: "POST",
      body: JSON.stringify({ siteId: "site-a" }),
    });
    expect(mocks.push).toHaveBeenCalledWith("/store-count?sessionId=new-session");
  });

  it("does not expose setup controls to an employee", async () => {
    mocks.user = { id: "employee-a", role: "GENERAL", taskManager: false };
    await act(async () => root.render(createElement(StoreCountSetupPage)));

    expect(container.textContent).toContain("Manager access is required");
    expect(container.querySelector('a[href="/my-work"]')).not.toBeNull();
    expect(mocks.apiJson).not.toHaveBeenCalled();
  });
});
