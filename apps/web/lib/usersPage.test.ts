import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiJson: vi.fn(),
  push: vi.fn(),
  show: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("./api", () => ({ apiJson: mocks.apiJson }));
vi.mock("./auth-context", () => ({
  useAuth: () => ({ user: { id: "admin-a" }, loading: false, isAdmin: true }),
}));
vi.mock("./toast-context", () => ({ useToast: () => ({ show: mocks.show }) }));
vi.mock("./i18n/locale-context", () => ({ useLocale: () => ({ t: (key: string) => `translated:${key}` }) }));

import UsersPage from "../app/users/page";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

async function changeValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("employee organization selection", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  async function renderPage() {
    await act(async () => root.render(createElement(UsersPage)));
    await act(async () => undefined);
  }

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("requires one managed organization and sends its id when creating an employee", async () => {
    mocks.apiJson.mockImplementation(async (url: string) => {
      if (url === "/api/auth/user-organizations") {
        return [{ id: "org-a", name: "Org A" }, { id: "org-b", name: "Org B" }];
      }
      if (url === "/api/auth/users") return [];
      return {};
    });
    await renderPage();
    const organization = container.querySelector<HTMLSelectElement>('select[name="organizationId"]');

    expect(organization).not.toBeNull();
    expect(Array.from(organization!.options).map(({ value, text }) => ({ value, text }))).toEqual([
      { value: "", text: "translated:selectOrganization" },
      { value: "org-a", text: "Org A" },
      { value: "org-b", text: "Org B" },
    ]);

    const [name, email, password] = Array.from(container.querySelectorAll<HTMLInputElement>("input"));
    await changeValue(name, "Employee A");
    await changeValue(email, "employee-a@example.com");
    await changeValue(password, "SecurePass1!");
    await changeValue(organization!, "org-a");
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(mocks.apiJson).toHaveBeenCalledWith("/api/auth/users", {
      method: "POST",
      body: JSON.stringify({
        name: "Employee A",
        email: "employee-a@example.com",
        password: "SecurePass1!",
        role: "GENERAL",
        organizationId: "org-a",
      }),
    });
  });

  it("shows an actionable error and disables creation when organizations cannot load", async () => {
    mocks.apiJson.mockImplementation(async (url: string) => {
      if (url === "/api/auth/user-organizations") throw new Error("network unavailable");
      if (url === "/api/auth/users") return [];
      return {};
    });

    await renderPage();

    expect(container.textContent).toContain("translated:organizationLoadFailed");
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  });
});
