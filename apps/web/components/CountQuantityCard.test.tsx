import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CountQuantityCard from "./CountQuantityCard";
import type { PendingCountItem } from "../lib/countQuantityFlow";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const knownItem: PendingCountItem = {
  barcodeValue: "012345678905",
  productId: "product-1",
  productName: "Vitamin B12 Tablets",
  packageSize: "100 tablets",
  known: true,
};

describe("CountQuantityCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(item = knownItem, props: Partial<React.ComponentProps<typeof CountQuantityCard>> = {}) {
    await act(async () => {
      root.render(createElement(CountQuantityCard, {
        item,
        locationLabel: "Aisle 4 · Vitamin Bay",
        onConfirm: vi.fn(),
        onCancel: vi.fn(),
        ...props,
      }));
    });
  }

  function input(): HTMLInputElement {
    return container.querySelector<HTMLInputElement>("input[name=quantity]")!;
  }

  async function changeValue(value: string) {
    const element = input();
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
    await act(async () => {
      setter?.call(element, value);
      element.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  it("shows product identity, location, quantity controls, and clear actions", async () => {
    await render();

    expect(container.textContent).toContain("Item found");
    expect(container.textContent).toContain("Vitamin B12 Tablets");
    expect(container.textContent).toContain("100 tablets");
    expect(container.textContent).toContain("012345678905");
    expect(container.textContent).toContain("Counting at");
    expect(container.textContent).toContain("Aisle 4 · Vitamin Bay");
    expect(input().value).toBe("1");
    expect(input().inputMode).toBe("numeric");
    expect(input().min).toBe("1");
    expect(input().max).toBe("999");
    expect(container.querySelector("button[aria-label='Decrease quantity']")).not.toBeNull();
    expect(container.querySelector("button[aria-label='Increase quantity']")).not.toBeNull();
    expect(container.querySelector("button[type=submit]")?.textContent).toContain("Confirm & Continue");
    expect(container.textContent).toContain("Wrong item / Scan again");
  });

  it("submits a valid typed quantity with Enter exactly once", async () => {
    const onConfirm = vi.fn();
    await render(knownItem, { onConfirm });
    await changeValue("12");
    await act(async () => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(12);
  });

  it("uses a shrinkable three-column stepper with one dominant action at narrow widths", async () => {
    const style = document.createElement("style");
    style.textContent = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");
    document.head.appendChild(style);
    try {
      container.style.width = "288px";
      await render();
      const controls = container.querySelector<HTMLElement>(".count-quantity-card__controls")!;
      expect(getComputedStyle(controls).display).toBe("grid");
      expect(getComputedStyle(controls).gridTemplateColumns).toBe("48px minmax(0, 1fr) 48px");
      expect(getComputedStyle(input()).minWidth).toBe("0");
      expect(container.querySelectorAll("button:not(.secondary)")).toHaveLength(1);
      expect(container.querySelector("button:not(.secondary)")?.getAttribute("type")).toBe("submit");
    } finally { style.remove(); }
  });

  it("focuses quantity with product and location context available to assistive technology", async () => {
    await render();
    expect(document.activeElement).toBe(input());
    const context = input().getAttribute("aria-describedby")?.split(" ")
      .map((id) => document.getElementById(id)?.textContent).join(" ");
    expect(context).toContain("Vitamin B12 Tablets");
    expect(context).toContain("Aisle 4 · Vitamin Bay");
    expect(input().labels?.[0].textContent).toBe("Quantity");
  });

  it("keeps confirmation disabled for invalid input and allows unknown UPCs", async () => {
    const onConfirm = vi.fn();
    await render({ ...knownItem, known: false, productId: null, productName: null, packageSize: null }, { onConfirm });
    expect(container.textContent).toContain("Product not recognized");
    expect(container.textContent).toContain("012345678905");
    await changeValue("0");
    expect(container.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it.each(["1000", "1.5", "-1", "abc"])("preserves malformed input %s and keeps confirmation disabled", async (value) => {
    await render();
    await changeValue(value);
    expect(input().value).toBe(value);
    expect(container.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled).toBe(true);
  });

  it("clamps plus and minus at one and 999", async () => {
    await render();
    const plus = container.querySelector<HTMLButtonElement>("button[aria-label='Increase quantity']")!;
    const minus = container.querySelector<HTMLButtonElement>("button[aria-label='Decrease quantity']")!;
    expect(minus.disabled).toBe(true);
    await act(async () => plus.click());
    expect(input().value).toBe("2");
    await changeValue("999");
    expect(plus.disabled).toBe(true);
    await act(async () => minus.click());
    expect(input().value).toBe("998");
  });

  it("does not invoke confirm more than once during rapid activation", async () => {
    const onConfirm = vi.fn(() => new Promise<void>(() => undefined));
    await render(knownItem, { onConfirm });
    const submit = container.querySelector<HTMLButtonElement>("button[type=submit]")!;
    await act(async () => {
      submit.click();
      submit.click();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(submit.disabled).toBe(true);
  });

  it("does not allow cancellation while confirmation is being saved", async () => {
    const onCancel = vi.fn();
    await render(knownItem, { onCancel, submitting: true });
    const cancel = Array.from(container.querySelectorAll<HTMLButtonElement>("button[type=button]"))
      .find((button) => button.textContent?.includes("Wrong item"))!;

    expect(cancel.disabled).toBe(true);
    await act(async () => cancel.click());
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("allows retry after an async confirmation rejection", async () => {
    const onConfirm = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    await render(knownItem, { onConfirm });
    const submit = container.querySelector<HTMLButtonElement>("button[type=submit]")!;
    await act(async () => submit.click());
    await act(async () => undefined);
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it("shows an immutable quantity and accurate action for a safe retry", async () => {
    const onConfirm = vi.fn();
    await render(knownItem, { onConfirm, retryQuantity: 12 });

    expect(input().value).toBe("12");
    expect(input().readOnly).toBe(true);
    expect(container.textContent).toContain("Quantity 12 is locked for this safe retry.");
    expect(container.querySelector<HTMLButtonElement>("button[aria-label='Decrease quantity']")?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>("button[aria-label='Increase quantity']")?.disabled).toBe(true);

    await changeValue("7");
    expect(input().value).toBe("12");
    await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Retry Save")?.click());
    expect(onConfirm).toHaveBeenCalledWith(12);
  });

  it("cancels a valid item without confirming it", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    await render(knownItem, { onConfirm, onCancel });
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>("button[type=button]")).find((button) => button.textContent?.includes("Wrong item"))?.click();
    });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
