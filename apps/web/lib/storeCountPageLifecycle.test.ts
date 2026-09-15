import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiJson: vi.fn(),
  apiFetch: vi.fn(),
  push: vi.fn(),
  show: vi.fn(),
  user: { id: "employee-a" } as { id: string },
  createCountScanId: vi.fn(),
  enqueueCountScan: vi.fn(),
  cameraCallback: null as null | ((result?: { getText: () => string; getBarcodeFormat: () => number }) => void),
  cameraStart: vi.fn(),
  persistedScannerStatus: null as null | "retail" | "fallback",
  scannerGuide: vi.fn(),
  scannerGuidance: vi.fn(),
  decodeSingle: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("./api", () => {
  class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return { apiJson: mocks.apiJson, apiFetch: mocks.apiFetch, ApiError };
});
vi.mock("./auth-context", () => ({
  useAuth: () => ({ user: mocks.user, loading: false }),
}));
vi.mock("./toast-context", () => ({ useToast: () => ({ show: mocks.show }) }));
vi.mock("./barcodeScanner", () => ({
  createScanHints: vi.fn(async () => new Map()),
  isQrScanFormat: (format: number) => format === 11,
  SCAN_VIDEO_CONSTRAINTS: {},
}));
vi.mock("./scannerEngine", async (importOriginal) => ({
  ...await importOriginal<typeof import("./scannerEngine")>(),
  loadRetailScanner: async () => ({ decodeSingle: mocks.decodeSingle }),
  describeScannerStatus: (status: string, locationCode?: string) => status === "starting"
    ? `Starting camera${locationCode ? ` at ${locationCode}` : ""}…`
    : "Ready to scan",
  getScannerGuidance: mocks.scannerGuidance,
  markCameraReady: () => "ready",
  mapRetailScannerFocusToDisplay: mocks.scannerGuide,
  readRetailScannerStatus: () => mocks.persistedScannerStatus,
}));
vi.mock("./beep", () => ({ playBeep: vi.fn(), unlockBeepAudio: vi.fn() }));
vi.mock("./storeCountQueue", () => ({
  clearCountQueueForSession: vi.fn(),
  createCountScanId: mocks.createCountScanId,
  enqueueCountScan: mocks.enqueueCountScan,
  getCountQueue: () => [],
  getFailedCountQueue: () => [],
  getPendingCountQueue: () => [],
  markCountScanFailed: vi.fn(),
  removeFromCountQueue: vi.fn(),
  retryFailedCountScan: vi.fn(),
}));
vi.mock("@zxing/browser", () => ({
  BrowserCodeReader: { mediaStreamIsTorchCompatible: () => false },
  BrowserMultiFormatReader: class {
    async decodeFromConstraints(_constraints: unknown, _video: unknown, callback: typeof mocks.cameraCallback) {
      mocks.cameraCallback = callback;
      return mocks.cameraStart();
    }
  },
}));
vi.mock("../components/BrandLockup", () => ({
  BrandLockup: () => createElement("div", null, "ContinuiXAi"),
}));
vi.mock("../components/TorchButton", () => ({ TorchButton: () => null }));

import StoreCountPage from "../app/store-count/page";
import { RetailScannerAssist } from "../components/RetailScannerAssist";
import type { QuaggaResult } from "./scannerEngine";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

const location = { id: "location-1", code: "VIT-01", name: "Vitamin Bay", isActive: true };

function countSession(id: string) {
  return { id, name: "Vitamin Count", status: "ACTIVE", startedAt: "2026-09-13T00:00:00Z", entries: [] };
}

function product(id: string, barcodeValue: string, name: string) {
  return { id, barcodeValue, name, manufacturer: null, packageSize: "100 tablets", isActive: true };
}

function entry(id: string, barcodeValue: string, productValue: ReturnType<typeof product>) {
  return { id, barcodeValue, locationId: location.id, quantity: 4, product: productValue, location: { id: location.id, code: location.code } };
}

function countSummary(sessionId = "session-a") {
  return {
    session: { id: sessionId, name: "Vitamin Count", status: "ACTIVE" },
    distinctProducts: 0,
    totalUnits: 0,
    locations: [],
    rows: [],
  };
}

describe("Store Count pending-item lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;
  let idSequence: number;

  beforeEach(() => {
    vi.clearAllMocks();
    idSequence = 0;
    mocks.user = { id: "employee-a" };
    mocks.cameraCallback = null;
    mocks.persistedScannerStatus = null;
    mocks.scannerGuide.mockReturnValue({ left: 12, top: 34, width: 320, height: 120 });
    mocks.scannerGuidance.mockImplementation((elapsedMs: number) => {
      if (elapsedMs < 2_000) return "Center one barcode inside the box.";
      if (elapsedMs < 5_000) return "Hold steady and fill the box with the barcode.";
      return "Try more light or tap ‘Barcode won’t scan?’";
    });
    mocks.cameraStart.mockResolvedValue({ stop: vi.fn(), switchTorch: vi.fn() });
    mocks.createCountScanId.mockImplementation(() => `scan-id-${++idSequence}`);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal("confirm", vi.fn(() => true));
    vi.stubGlobal("MediaStream", class MediaStream {});
    window.history.replaceState(null, "", "/store-count");
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function renderPage(activeSession = countSession("session-a")) {
    mocks.apiJson.mockImplementation(async (url: string) => {
      if (url === "/api/store-locations") return [location];
      if (url === "/api/store-count/sessions/active") return activeSession;
      throw new Error(`Unexpected request: ${url}`);
    });
    await act(async () => root.render(createElement(StoreCountPage)));
    await act(async () => undefined);
  }

  function button(label: string): HTMLButtonElement {
    const match = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((candidate) => candidate.textContent?.trim() === label);
    if (!match) throw new Error(`Button not found: ${label}`);
    return match;
  }

  async function changeInput(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
    await act(async () => {
      setter?.call(input, value);
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  async function beginManualIdentification(value: string) {
    await act(async () => button("Barcode won’t scan?").click());
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Manual UPC"]')!;
    await changeInput(input, value);
    await act(async () => input.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  }

  async function mountRealAssist() {
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,frame");
    await act(async () => root.render(createElement(Fragment, null, createElement(StoreCountPage), createElement(RetailScannerAssist))));
    const video = container.querySelector("video")!;
    Object.defineProperties(video, {
      readyState: { value: HTMLMediaElement.HAVE_CURRENT_DATA },
      videoWidth: { value: 1280 }, videoHeight: { value: 720 }, srcObject: { value: {} },
    });
  }

  function rapidMode() {
    return container.querySelector<HTMLInputElement>('input[aria-label="Rapid one-by-one mode"]')!;
  }

  it("keeps rapid one-by-one explicitly off by default and waits for quantity confirmation", async () => {
    await renderPage();
    expect(rapidMode()).not.toBeNull();
    expect(rapidMode().checked).toBe(false);
    await act(async () => window.dispatchEvent(new CustomEvent("continuix:camera-scan", { detail: { value: "012345678905" } })));
    expect(container.textContent).toContain("Product not recognized");
    expect(mocks.apiJson.mock.calls.filter(([url]) => String(url).endsWith("/scan"))).toHaveLength(0);
  });

  it("counts one unit per opt-in rapid scan and requires barcode removal before counting it again", async () => {
    await renderPage();
    const found = product("product-a", "012345678905", "Vitamin B12");
    const payloads: Array<{ quantityDelta: number; clientScanId: string; locationId: string }> = [];
    mocks.apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/store-locations") return [location];
      if (url === "/api/store-count/sessions/active") return countSession("session-a");
      if (url.includes("/by-barcode/")) return found;
      if (url.endsWith("/scan")) {
        payloads.push(JSON.parse(String(init?.body)));
        return { ...entry("entry-a", found.barcodeValue, found), quantity: payloads.length };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    let visible = true;
    mocks.decodeSingle.mockImplementation((_config: unknown, callback: (result: QuaggaResult | null) => void) => callback(visible ? { codeResult: { code: found.barcodeValue } } : null));
    await mountRealAssist();
    expect(rapidMode()).not.toBeNull();
    await act(async () => rapidMode().click());
    await act(async () => vi.advanceTimersByTime(180));
    expect(payloads).toMatchObject([{ quantityDelta: 1, clientScanId: "scan-id-1", locationId: "location-1" }]);
    await act(async () => vi.advanceTimersByTime(1800));
    expect(payloads).toHaveLength(1);
    visible = false;
    await act(async () => vi.advanceTimersByTime(1620));
    visible = true;
    await act(async () => vi.advanceTimersByTime(180));
    expect(payloads).toMatchObject([{ quantityDelta: 1, clientScanId: "scan-id-1" }, { quantityDelta: 1, clientScanId: "scan-id-2" }]);
    expect(container.textContent).toContain("2 units counted here");
  });

  it("locks mode changes during rapid persistence and restores quantity confirmation when switched off", async () => {
    const save = deferred<ReturnType<typeof entry>>();
    const found = product("product-a", "012345678905", "Vitamin B12");
    await renderPage();
    mocks.apiJson.mockImplementation(async (url: string) => {
      if (url.includes("/by-barcode/")) return found;
      if (url.endsWith("/scan")) return save.promise;
      throw new Error(`Unexpected request: ${url}`);
    });
    expect(rapidMode()).not.toBeNull();
    await act(async () => rapidMode().click());
    await act(async () => window.dispatchEvent(new CustomEvent("continuix:camera-scan", { detail: { value: found.barcodeValue } })));
    expect(rapidMode().disabled).toBe(true);
    await act(async () => rapidMode().click());
    expect(rapidMode().checked).toBe(true);
    expect(button("Wrong item / Scan again").disabled).toBe(true);
    await act(async () => save.resolve({ ...entry("entry-a", found.barcodeValue, found), quantity: 1 }));
    await act(async () => rapidMode().click());
    expect(rapidMode().checked).toBe(false);
    await act(async () => window.dispatchEvent(new CustomEvent("continuix:camera-scan", { detail: { value: "036000291452" } })));
    expect(button("Confirm & Continue").disabled).toBe(false);
    expect(mocks.apiJson.mock.calls.filter(([url]) => String(url).endsWith("/scan"))).toHaveLength(1);
  });

  it("retains rapid offline writes through the same owner-scoped idempotent queue", async () => {
    await renderPage();
    mocks.apiJson.mockImplementation(async () => { throw new Error("Offline"); });
    expect(rapidMode()).not.toBeNull();
    await act(async () => rapidMode().click());
    await act(async () => window.dispatchEvent(new CustomEvent("continuix:camera-scan", { detail: { value: "012345678905" } })));
    expect(mocks.enqueueCountScan).toHaveBeenCalledWith({ ownerUserId: "employee-a", sessionId: "session-a", locationId: "location-1", barcodeValue: "012345678905", quantityDelta: 1 }, "scan-id-1");
    expect(container.textContent).toContain("count safely queued: 012345678905 × 1");
    expect(container.textContent).not.toContain("Item found");
  });

  it("keeps the fallback camera from rapidly recounting a barcode that has not left view", async () => {
    vi.useFakeTimers();
    await renderPage();
    const found = product("product-a", "012345678905", "Vitamin B12");
    mocks.apiJson.mockImplementation(async (url: string) => {
      if (url.endsWith("/scan")) return { ...entry("entry-a", found.barcodeValue, found), quantity: 1 };
      throw new Error(`Unexpected request: ${url}`);
    });
    await act(async () => rapidMode().click());
    const result = { getText: () => found.barcodeValue, getBarcodeFormat: () => 14 };
    await act(async () => mocks.cameraCallback?.(result));
    await act(async () => vi.advanceTimersByTime(1800));
    await act(async () => mocks.cameraCallback?.(result));
    expect(mocks.apiJson.mock.calls.filter(([url]) => String(url).endsWith("/scan"))).toHaveLength(1);
    await act(async () => vi.advanceTimersByTime(1500));
    await act(async () => mocks.cameraCallback?.());
    await act(async () => mocks.cameraCallback?.(result));
    expect(mocks.apiJson.mock.calls.filter(([url]) => String(url).endsWith("/scan"))).toHaveLength(2);
  });

  it("does not recount a held rapid barcode when capture hands off from ZXing to the retail assist", async () => {
    await renderPage();
    const found = product("product-a", "012345678905", "Vitamin B12");
    mocks.apiJson.mockImplementation(async (url: string) => {
      if (url === "/api/store-locations") return [location];
      if (url === "/api/store-count/sessions/active") return countSession("session-a");
      if (url.endsWith("/scan")) return { ...entry("entry-a", found.barcodeValue, found), quantity: 1 };
      throw new Error(`Unexpected request: ${url}`);
    });
    mocks.decodeSingle.mockImplementation((_config: unknown, callback: (result: QuaggaResult) => void) => callback({ codeResult: { code: found.barcodeValue } }));
    await mountRealAssist();
    await act(async () => rapidMode().click());
    await act(async () => mocks.cameraCallback?.({ getText: () => found.barcodeValue, getBarcodeFormat: () => 14 }));
    await act(async () => vi.advanceTimersByTime(1800));
    expect(mocks.apiJson.mock.calls.filter(([url]) => String(url).endsWith("/scan"))).toHaveLength(1);
  });

  it("retains the exact rapid attempt when both the response and local queue fail", async () => {
    await renderPage();
    const payloads: unknown[] = [];
    const found = product("product-a", "012345678905", "Vitamin B12");
    mocks.enqueueCountScan.mockImplementationOnce(() => { throw new Error("Storage full"); });
    mocks.apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/scan")) {
        payloads.push(JSON.parse(String(init?.body)));
        if (payloads.length === 1) throw new Error("Response lost");
        return { ...entry("entry-a", found.barcodeValue, found), quantity: 1 };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    await act(async () => rapidMode().click());
    await act(async () => window.dispatchEvent(new CustomEvent("continuix:camera-scan", { detail: { value: found.barcodeValue } })));
    expect(rapidMode().disabled).toBe(true);
    expect(button("Wrong item / Scan again").disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[name="quantity"]')?.value).toBe("1");
    await act(async () => button("Retry Save").click());
    expect(payloads).toMatchObject([{ quantityDelta: 1, clientScanId: "scan-id-1" }, { quantityDelta: 1, clientScanId: "scan-id-1" }]);
    expect(container.textContent).toContain("1 units counted here");
  });

  it("pauses the real assist while a card is open, rearms cancel, and never arms a rejected duplicate", async () => {
    await renderPage();
    const found = product("product-a", "012345678905", "Vitamin B12");
    mocks.apiJson.mockImplementation(async (url: string) => {
      if (url === "/api/store-locations") return [location];
      if (url === "/api/store-count/sessions/active") return countSession("session-a");
      if (url.includes("/by-barcode/")) return found;
      if (url.endsWith("/scan")) return entry("entry-a", found.barcodeValue, found);
      throw new Error(`Unexpected request: ${url}`);
    });
    mocks.decodeSingle.mockImplementation((_config: unknown, callback: (result: QuaggaResult) => void) => callback({ codeResult: { code: found.barcodeValue } }));
    await mountRealAssist();
    await act(async () => vi.advanceTimersByTime(180));
    expect(container.textContent).toContain("Item found");
    const callsWhileCardOpened = mocks.decodeSingle.mock.calls.length;
    await act(async () => vi.advanceTimersByTime(1800));
    expect(mocks.decodeSingle).toHaveBeenCalledTimes(callsWhileCardOpened);
    await act(async () => button("Wrong item / Scan again").click());
    await act(async () => vi.advanceTimersByTime(180));
    expect(container.textContent).toContain("Item found");
    await act(async () => button("Confirm & Continue").click());
    await act(async () => vi.advanceTimersByTime(180));
    expect(container.textContent).not.toContain("Item found");
    await act(async () => vi.advanceTimersByTime(1080));
    expect(container.textContent).toContain("Item found");
    expect(mocks.apiJson.mock.calls.filter(([url]) => String(url).endsWith("/scan"))).toHaveLength(1);
  });

  it("discards an assist decode already in flight when Summary pauses capture, then resumes the same barcode", async () => {
    await renderPage();
    const found = product("product-a", "012345678905", "Vitamin B12");
    mocks.apiJson.mockImplementation(async (url: string) => {
      if (url === "/api/store-locations") return [location];
      if (url === "/api/store-count/sessions/active") return countSession("session-a");
      if (url.endsWith("/summary")) return countSummary();
      if (url.includes("/by-barcode/")) return found;
      throw new Error(`Unexpected request: ${url}`);
    });
    let decode!: (result: QuaggaResult) => void;
    mocks.decodeSingle.mockImplementation((_config: unknown, callback: typeof decode) => { decode = callback; });
    await mountRealAssist();
    await act(async () => vi.advanceTimersByTime(180));
    const staleDecode = decode;
    await act(async () => button("Summary").click());
    await act(async () => button("Count").click());
    await act(async () => staleDecode({ codeResult: { code: found.barcodeValue } }));
    expect(container.textContent).not.toContain("Item found");
    const video = container.querySelector("video")!;
    Object.defineProperties(video, { readyState: { value: 2 }, videoWidth: { value: 1280 }, videoHeight: { value: 720 }, srcObject: { value: {} } });
    await act(async () => vi.advanceTimersByTime(180));
    await act(async () => decode({ codeResult: { code: found.barcodeValue } }));
    expect(container.textContent).toContain("Item found");
  });

  it("bounds a stalled product lookup and ignores details arriving after the unknown-item fallback", async () => {
    vi.useFakeTimers();
    const lookup = deferred<ReturnType<typeof product>>();
    await renderPage();
    let requestSignal: AbortSignal | undefined;
    mocks.apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/by-barcode/")) {
        requestSignal = init?.signal ?? undefined;
        return lookup.promise;
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    await beginManualIdentification("012345678905");
    expect(container.textContent).toContain("Looking up item");
    await act(async () => vi.advanceTimersByTime(3000));
    expect(container.textContent).toContain("Product not recognized");
    expect(button("Confirm & Continue").disabled).toBe(false);
    expect(requestSignal?.aborted).toBe(true);
    await changeInput(container.querySelector<HTMLInputElement>('input[name="quantity"]')!, "12");
    await act(async () => lookup.resolve(product("product-a", "012345678905", "Late catalog result")));
    expect(container.textContent).not.toContain("Late catalog result");
    expect(container.querySelector<HTMLInputElement>('input[name="quantity"]')?.value).toBe("12");
  });

  it("locks transitions during deferred identification and ignores a result from an earlier session", async () => {
    const lookup = deferred<ReturnType<typeof product>>();
    let activeSession = countSession("session-a");
    mocks.apiJson.mockImplementation(async (url: string) => {
      if (url === "/api/store-locations") return [location];
      if (url === "/api/store-count/sessions/active") return activeSession;
      if (url === "/api/products/by-barcode/012345678905") return lookup.promise;
      throw new Error(`Unexpected request: ${url}`);
    });
    await act(async () => root.render(createElement(StoreCountPage)));
    await act(async () => undefined);

    await beginManualIdentification("012345678905");

    for (const label of ["Summary", "Change", "Finish", "Cancel"]) {
      expect(button(label).disabled, `${label} should be locked`).toBe(true);
      button(label).click();
    }

    activeSession = countSession("session-b");
    mocks.user = { id: "employee-b" };
    await act(async () => root.render(createElement(StoreCountPage)));
    await act(async () => undefined);
    await act(async () => lookup.resolve(product("product-a", "012345678905", "Vitamin B12")));

    expect(container.textContent).not.toContain("Item found");
    expect(container.textContent).not.toContain("LAST ITEM COUNTED");
    expect(container.textContent).not.toContain("Ready for the next item");
    expect(mocks.apiJson.mock.calls.some(([url]) => String(url).includes("/summary"))).toBe(false);
  });

  it("locks scanning during a deferred Summary transition and never hides a pending item", async () => {
    const summary = deferred<ReturnType<typeof countSummary>>();
    const scannedProduct = product("product-a", "012345678905", "Vitamin B12");
    await renderPage();
    mocks.apiJson.mockImplementation(async (url: string) => {
      if (url === "/api/store-locations") return [location];
      if (url === "/api/store-count/sessions/active") return countSession("session-a");
      if (url === "/api/store-count/sessions/session-a/summary") return summary.promise;
      if (url === "/api/products/by-barcode/012345678905") return scannedProduct;
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () => button("Summary").click());
    expect(button("Summary").disabled).toBe(true);

    await act(async () => window.dispatchEvent(new CustomEvent("continuix:camera-scan", { detail: { value: "012345678905" } })));
    expect(mocks.apiJson.mock.calls.filter(([url]) => url === "/api/products/by-barcode/012345678905")).toHaveLength(0);
    expect(container.textContent).not.toContain("Item found");

    await act(async () => summary.resolve(countSummary()));
    expect(button("Count").disabled).toBe(false);
    await act(async () => button("Count").click());
    expect(container.textContent).not.toContain("Item found");
    expect(container.textContent).toContain("Barcode won’t scan?");
  });

  it("retries the read-only summary after completion succeeds but its first summary request fails", async () => {
    let summaryAttempt = 0;
    await renderPage();
    mocks.apiJson.mockImplementation(async (url: string) => {
      if (url === "/api/store-locations") return [location];
      if (url === "/api/store-count/sessions/active") return countSession("session-a");
      if (url === "/api/store-count/sessions/session-a/complete") return undefined;
      if (url === "/api/store-count/sessions/session-a/summary") {
        summaryAttempt++;
        if (summaryAttempt === 1) throw new Error("Summary temporarily unavailable");
        return { ...countSummary(), session: { ...countSummary().session, status: "COMPLETED" }, totalUnits: 9 };
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () => button("Finish").click());
    expect(button("Summary").disabled).toBe(false);
    expect(container.textContent).not.toContain("9 units");

    await act(async () => button("Summary").click());

    expect(summaryAttempt).toBe(2);
    expect(button("Count").disabled).toBe(false);
    expect(container.textContent).toContain("9 units");
    expect(container.textContent).not.toContain("Barcode won’t scan?");
  });

  it("reopens a completed session summary after navigating back to Count", async () => {
    let summaryRequests = 0;
    await renderPage();
    mocks.apiJson.mockImplementation(async (url: string) => {
      if (url === "/api/store-locations") return [location];
      if (url === "/api/store-count/sessions/active") return countSession("session-a");
      if (url === "/api/store-count/sessions/session-a/complete") return undefined;
      if (url === "/api/store-count/sessions/session-a/summary") {
        summaryRequests++;
        return { ...countSummary(), session: { ...countSummary().session, status: "COMPLETED" }, totalUnits: 6 };
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () => button("Finish").click());
    expect(container.textContent).toContain("6 units");

    await act(async () => button("Count").click());
    expect(container.textContent).not.toContain("6 units");
    expect(container.textContent).not.toContain("Barcode won’t scan?");
    await act(async () => button("Summary").click());

    expect(summaryRequests).toBe(2);
    expect(button("Count").disabled).toBe(false);
    expect(container.textContent).toContain("6 units");
  });

  it("blocks cancel and a second scan while the first confirmed save is unresolved", async () => {
    const save = deferred<ReturnType<typeof entry>>();
    const secondLookup = deferred<ReturnType<typeof product>>();
    const firstProduct = product("product-a", "012345678905", "Vitamin B12");
    const secondProduct = product("product-b", "036000291452", "Vitamin C");
    await renderPage();
    mocks.apiJson.mockImplementation(async (url: string) => {
      if (url === "/api/store-locations") return [location];
      if (url === "/api/store-count/sessions/active") return countSession("session-a");
      if (url === "/api/products/by-barcode/012345678905") return firstProduct;
      if (url === "/api/products/by-barcode/036000291452") return secondLookup.promise;
      if (url.includes("/scan")) return save.promise;
      throw new Error(`Unexpected request: ${url}`);
    });

    await beginManualIdentification("012345678905");
    await act(async () => button("Confirm & Continue").click());

    expect(button("Wrong item / Scan again").disabled).toBe(true);
    button("Wrong item / Scan again").click();
    await act(async () => window.dispatchEvent(new CustomEvent("continuix:camera-scan", { detail: { value: "036000291452" } })));
    expect(mocks.apiJson.mock.calls.filter(([url]) => url === "/api/products/by-barcode/036000291452")).toHaveLength(0);
    expect(container.textContent).toContain("Vitamin B12");

    await act(async () => save.resolve(entry("entry-a", "012345678905", firstProduct)));
    expect(container.textContent).not.toContain("Item found");

    await act(async () => window.dispatchEvent(new CustomEvent("continuix:camera-scan", { detail: { value: "036000291452" } })));
    expect(container.textContent).not.toContain("LAST ITEM COUNTED");
    expect(container.textContent).not.toContain("Ready for the next item");
    expect(container.textContent).toContain("Looking up item");
    await act(async () => secondLookup.resolve(secondProduct));
    expect(container.textContent).toContain("Vitamin C");
  });

  it("freezes the complete payload when an ambiguous response and queue-storage failure require confirmation retry", async () => {
    const firstProduct = product("product-a", "012345678905", "Vitamin B12");
    const postedPayloads: Array<{ clientScanId: string; quantityDelta: number }> = [];
    const accepted = new Map<string, number>();
    let postAttempt = 0;
    await renderPage();
    mocks.enqueueCountScan.mockImplementationOnce(() => {
      throw new Error("Local queue storage unavailable");
    });
    mocks.apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/store-locations") return [location];
      if (url === "/api/store-count/sessions/active") return countSession("session-a");
      if (url === "/api/products/by-barcode/012345678905") return firstProduct;
      if (url.includes("/scan")) {
        postedPayloads.push(JSON.parse(String(init?.body)));
        const payload = postedPayloads.at(-1)!;
        accepted.set(payload.clientScanId, payload.quantityDelta);
        postAttempt++;
        if (postAttempt === 1) throw new Error("Response lost after server acceptance");
        return entry("entry-a", "012345678905", firstProduct);
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await beginManualIdentification("012345678905");
    const quantityInput = container.querySelector<HTMLInputElement>('input[name="quantity"]')!;
    await changeInput(quantityInput, "12");
    await act(async () => button("Confirm & Continue").click());
    await act(async () => undefined);
    expect(quantityInput.value).toBe("12");
    expect(quantityInput.readOnly).toBe(true);
    expect(container.textContent).toContain("Quantity 12 is locked for this safe retry.");
    expect(button("Retry Save").disabled).toBe(false);
    expect(button("Wrong item / Scan again").disabled).toBe(true);
    await act(async () => button("Wrong item / Scan again").click());
    await act(async () => window.dispatchEvent(new CustomEvent("continuix:camera-scan", { detail: { value: "012345678905" } })));
    expect(container.querySelector<HTMLInputElement>('input[name="quantity"]')?.value).toBe("12");
    expect(postedPayloads).toHaveLength(1);

    await changeInput(quantityInput, "7");
    expect(quantityInput.value).toBe("12");
    await act(async () => button("Retry Save").click());
    await act(async () => undefined);

    expect(postedPayloads).toMatchObject([
      { clientScanId: "scan-id-1", quantityDelta: 12 },
      { clientScanId: "scan-id-1", quantityDelta: 12 },
    ]);
    expect(mocks.createCountScanId).toHaveBeenCalledTimes(1);
    expect([...accepted.values()].reduce((sum, quantity) => sum + quantity, 0)).toBe(12);
    expect(container.textContent).toContain("Added 12 of Vitamin B12 to VIT-01 — Vitamin Bay. Ready for the next item.");
  });

  it("rejects QR camera results as merchandise barcodes on Store Count", async () => {
    await renderPage();

    await act(async () => mocks.cameraCallback?.({
      getText: () => "https://example.test/not-a-upc",
      getBarcodeFormat: () => 11,
    }));

    expect(mocks.apiJson.mock.calls.some(([url]) => String(url).includes("/api/products/by-barcode/"))).toBe(false);
    expect(container.textContent).not.toContain("Product not recognized");
  });

  it("escalates scanner help over time and resets it after an item is cancelled", async () => {
    vi.useFakeTimers();
    const scannedProduct = product("product-a", "012345678905", "Vitamin B12");
    await renderPage();
    mocks.apiJson.mockImplementation(async (url: string) => {
      if (url === "/api/store-locations") return [location];
      if (url === "/api/store-count/sessions/active") return countSession("session-a");
      if (url === "/api/products/by-barcode/012345678905") return scannedProduct;
      throw new Error(`Unexpected request: ${url}`);
    });

    expect(container.textContent).toContain("Center one barcode inside the box.");
    await act(async () => vi.advanceTimersByTime(2_000));
    expect(container.textContent).toContain("Hold steady and fill the box with the barcode.");
    await act(async () => vi.advanceTimersByTime(3_000));
    expect(container.textContent).toContain("Try more light or tap ‘Barcode won’t scan?’");

    await act(async () => window.dispatchEvent(new CustomEvent("continuix:camera-scan", { detail: { value: "012345678905" } })));
    expect(container.textContent).toContain("Vitamin B12");
    await act(async () => button("Wrong item / Scan again").click());

    expect(container.textContent).toContain("Center one barcode inside the box.");
  });

  it("does not start timed guidance until the camera stream is ready", async () => {
    vi.useFakeTimers();
    const cameraStart = deferred<{ stop: ReturnType<typeof vi.fn>; switchTorch: ReturnType<typeof vi.fn> }>();
    mocks.persistedScannerStatus = "retail";
    mocks.cameraStart.mockReturnValueOnce(cameraStart.promise);

    await renderPage();
    await act(async () => vi.advanceTimersByTime(5_000));

    expect(container.textContent).toContain("Starting camera at VIT-01…");
    expect(container.textContent).not.toContain("Try more light");

    await act(async () => cameraStart.resolve({ stop: vi.fn(), switchTorch: vi.fn() }));
    expect(container.textContent).toContain("Center one barcode inside the box.");
  });

  it("positions the visible Count guide from the shared decoded-region mapping", async () => {
    await renderPage();
    const video = container.querySelector<HTMLVideoElement>(".scanner-frame video")!;
    const frame = container.querySelector<HTMLDivElement>(".scanner-frame")!;
    Object.defineProperties(video, {
      videoWidth: { value: 1280 },
      videoHeight: { value: 720 },
    });
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({
      width: 360,
      height: 270,
      left: 0,
      top: 0,
      right: 360,
      bottom: 270,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    await act(async () => video.dispatchEvent(new Event("loadedmetadata")));

    expect(mocks.scannerGuide).toHaveBeenCalledWith(1280, 720, 360, 270);
    const guide = container.querySelector<HTMLElement>(".store-count-scan-box")!;
    expect(guide.style.left).toBe("12px");
    expect(guide.style.top).toBe("34px");
    expect(guide.style.width).toBe("320px");
    expect(guide.style.height).toBe("120px");
  });

  it("stops guidance updates after showing the final action", async () => {
    vi.useFakeTimers();
    await renderPage();
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(container.textContent).toContain("Try more light or tap ‘Barcode won’t scan?’");
    const callsAtFinalGuidance = mocks.scannerGuidance.mock.calls.length;

    await act(async () => vi.advanceTimersByTime(60_000));

    expect(mocks.scannerGuidance).toHaveBeenCalledTimes(callsAtFinalGuidance);
  });

  it("replaces starting-camera text with an actionable manual fallback after a camera error", async () => {
    mocks.cameraStart.mockRejectedValueOnce(new DOMException("Permission denied", "NotAllowedError"));

    await renderPage();

    expect(container.textContent).toContain("Camera permission is blocked.");
    expect(container.textContent).toContain("Tap ‘Barcode won’t scan?’ to enter the UPC.");
    expect(container.textContent).not.toContain("Starting camera");
  });
});
