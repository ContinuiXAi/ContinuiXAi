import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiJson: vi.fn(),
  apiFetch: vi.fn(),
  push: vi.fn(),
  show: vi.fn(),
  user: { id: "admin-a" },
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("./api", () => ({ apiJson: mocks.apiJson, apiFetch: mocks.apiFetch }));
vi.mock("./auth-context", () => ({ useAuth: () => ({ user: mocks.user, loading: false }) }));
vi.mock("./toast-context", () => ({ useToast: () => ({ show: mocks.show }) }));
vi.mock("../components/BrandLockup", () => ({ BrandLockup: () => createElement("div", null, "ContinuiXAi") }));

import StoreProductsPage from "../app/store-products/page";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("product CSV onboarding", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiJson.mockImplementation(async (url: string) => {
      if (url === "/api/products?includeInactive=true") return [];
      if (url === "/api/categories") return [];
      throw new Error(`Unexpected request: ${url}`);
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function chooseFile() {
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["upc,name\n001234,Milk\n"], "products.csv", { type: "text/csv" })] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  }

  function button(label: string) {
    const result = Array.from(container.querySelectorAll("button")).find((item) => item.textContent === label);
    if (!result) throw new Error(`Missing button: ${label}`);
    return result;
  }

  const validPreview = { previewId: "preview-a", organizationId: "org-a", totals: { rows: 1, valid: 1, warnings: 0, errors: 0 }, rows: [{ row: 2, status: "valid", errors: [] }] };

  it("reviews the chosen file and commits only after explicit confirmation", async () => {
    mocks.apiFetch.mockResolvedValue({ ok: true, json: async () => validPreview });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await act(async () => root.render(createElement(StoreProductsPage)));
    await chooseFile();
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    await act(async () => button("Review").click());
    expect(mocks.apiFetch).toHaveBeenCalledWith("/api/products/import/preview", { method: "POST", body: expect.any(FormData) });
    expect((mocks.apiFetch.mock.calls[0][1].body as FormData).get("file")).toBeInstanceOf(File);
    expect(container.textContent).toContain("1 rows reviewed: 1 valid, 0 warnings, 0 errors.");
    await act(async () => button("Import").click());
    expect(confirm).toHaveBeenCalled();
    expect(mocks.apiJson.mock.calls.some(([url]) => url === "/api/products/import/commit")).toBe(false);
    confirm.mockReturnValue(true);
    mocks.apiJson.mockResolvedValueOnce({ imported: 1 });
    await act(async () => button("Import").click());
    expect(mocks.apiJson).toHaveBeenCalledWith("/api/products/import/commit", { method: "POST", body: JSON.stringify({ previewId: "preview-a", organizationId: "org-a" }) });
    expect(mocks.show).toHaveBeenCalledWith("Imported 1 products.", "success");
    expect(button("Import").disabled).toBe(true);
  });

  it("shows row errors, prevents import, and clears review when the corrected file is selected", async () => {
    mocks.apiFetch.mockResolvedValue({ ok: true, json: async () => ({ ...validPreview, totals: { rows: 1, valid: 0, warnings: 0, errors: 1 }, rows: [{ row: 2, status: "error", errors: ["name is required."] }] }) });
    await act(async () => root.render(createElement(StoreProductsPage)));
    await chooseFile();
    await act(async () => button("Review").click());
    expect(container.textContent).toContain("Row 2: name is required.");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Fix the errors");
    expect(button("Import").disabled).toBe(true);
    await chooseFile();
    expect(container.textContent).not.toContain("Row 2:");
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
  });

  it("displays preview and commit request failures", async () => {
    mocks.apiFetch.mockResolvedValueOnce({ ok: false, json: async () => ({ error: "CSV contains invalid UTF-8." }) });
    await act(async () => root.render(createElement(StoreProductsPage)));
    await chooseFile();
    await act(async () => button("Review").click());
    expect(mocks.show).toHaveBeenCalledWith("CSV contains invalid UTF-8.", "error");
    mocks.apiFetch.mockResolvedValueOnce({ ok: true, json: async () => validPreview });
    await act(async () => button("Review").click());
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mocks.apiJson.mockRejectedValueOnce(new Error("Preview expired."));
    await act(async () => button("Import").click());
    expect(mocks.show).toHaveBeenCalledWith("Preview expired.", "error");
  });

  it("downloads a template with a real CSV line ending", async () => {
    const createObjectURL = vi.fn().mockReturnValue("blob:template");
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    await act(async () => root.render(createElement(StoreProductsPage)));
    await act(async () => button("Download Template").click());
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    const text = await new Promise<string>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as string); reader.readAsText(blob); });
    expect(text).toBe("upc,name,manufacturer,description,package_size,category,is_active\r\n");
    vi.unstubAllGlobals();
  });

  it("prevents choosing or importing another file during review", async () => {
    let finish!: (response: unknown) => void;
    mocks.apiFetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => root.render(createElement(StoreProductsPage)));
    await chooseFile();
    await act(async () => button("Review").click());
    expect(container.querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(true);
    expect(button("Import").disabled).toBe(true);
    await act(async () => finish({ ok: true, json: async () => validPreview }));
    expect(container.querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(false);
  });

  it("offers the server-escaped error CSV for download", async () => {
    mocks.apiFetch.mockResolvedValue({ ok: true, json: async () => ({ ...validPreview, errorCsv: "row,upc,name,errors\r\n2,001234,'=SUM(1),Invalid category\r\n", totals: { rows: 1, valid: 0, warnings: 0, errors: 1 }, rows: [{ row: 2, status: "error", errors: ["Invalid category"] }] }) });
    const createObjectURL = vi.fn().mockReturnValue("blob:errors");
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    await act(async () => root.render(createElement(StoreProductsPage)));
    await chooseFile();
    await act(async () => button("Review").click());
    await act(async () => button("Download Errors").click());
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    const text = await new Promise<string>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as string); reader.readAsText(blob); });
    expect(text).toContain("001234,'=SUM(1)");
  });

  it("displays duplicate-name warnings and confirms importing every warning row", async () => {
    mocks.apiFetch.mockResolvedValue({ ok: true, json: async () => ({ ...validPreview, totals: { rows: 2, valid: 0, warnings: 2, errors: 0 }, rows: [
      { row: 2, status: "warning", errors: [], warnings: ['Duplicate name "milk" in this CSV.'] },
      { row: 3, status: "warning", errors: [], warnings: ['Duplicate name "milk" in this CSV.'] },
    ] }) });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => root.render(createElement(StoreProductsPage)));
    await chooseFile();
    await act(async () => button("Review").click());
    expect(container.textContent).toContain('Row 2: Duplicate name "milk" in this CSV.');
    expect(container.textContent).toContain("Same-name products are allowed");
    expect(button("Import").disabled).toBe(false);
    mocks.apiJson.mockResolvedValueOnce({ imported: 2 });
    await act(async () => button("Import").click());
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Import 2 products"));
    expect(mocks.show).toHaveBeenCalledWith("Imported 2 products.", "success");
  });

  it("offers a deliberate CSV review flow without importing on file selection", async () => {
    await act(async () => root.render(createElement(StoreProductsPage)));
    await act(async () => undefined);

    expect(container.textContent).toContain("Download Template");
    expect(container.textContent).toContain("Choose CSV");
    expect(container.textContent).toContain("Review");
    expect(container.textContent).toContain("Fix Errors");
    expect(container.textContent).toContain("Import");
    expect(mocks.apiFetch).not.toHaveBeenCalled();

    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("CSV picker missing");
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["upc,name\n001234,Milk\n"], "products.csv", { type: "text/csv" })] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));

    expect(container.textContent).toContain("Selected: products.csv. Review it before importing.");
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });
});
