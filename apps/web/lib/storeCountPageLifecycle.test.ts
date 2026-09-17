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

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }), useSearchParams: () => new URLSearchParams(window.location.search) }));
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
vi.mock("./storeCountQueue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./storeCountQueue")>();
  return {
    ...actual,
    createCountScanId: mocks.createCountScanId,
    enqueueCountScan: (...args: Parameters<typeof actual.enqueueCountScan>) => {
      mocks.enqueueCountScan(...args);
      return actual.enqueueCountScan(...args);
    },
  };
});
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
import CountReviewPage from "../app/store-count/review/page";
import { RetailScannerAssist } from "../components/RetailScannerAssist";
import { ApiError } from "./api";
import type { QuaggaResult } from "./scannerEngine";
import { enqueueCountScan, getCountQueue, removeFromCountQueue } from "./storeCountQueue";

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
const secondLocation = { id: "location-2", code: "END-01", name: "Endcap", isActive: true };
const thirdLocation = { id: "location-3", code: "BACK-01", name: "Back stock", isActive: true };

function countSession(id: string) {
  return { id, siteId: null as string | null, name: "Vitamin Count", status: "ACTIVE", startedAt: "2026-09-13T00:00:00Z", entries: [] as ReturnType<typeof entry>[] };
}

function countRoute(sessionId = "session-a") {
  const routeProduct = (id: string, barcodeValue: string, name: string) => ({
    productId: id,
    barcodeValue,
    name,
    packageSize: "100 tablets",
    expectedStoreQty: 15,
    suspectedLocations: [
      { locationId: secondLocation.id, code: secondLocation.code, verified: false, evidence: "ASSIGNED" },
      { locationId: thirdLocation.id, code: thirdLocation.code, verified: false, evidence: "RECENTLY_STOCKED" },
    ],
  });
  return {
    sessionId,
    expectedProducts: 3,
    locations: [
      { id: location.id, code: location.code, name: location.name, status: "VERIFIED", products: [] },
      {
        id: secondLocation.id,
        code: secondLocation.code,
        name: secondLocation.name,
        status: "PENDING",
        products: [
          routeProduct("product-a", "012345678905", "Vitamin B12"),
          routeProduct("product-b", "036000291452", "Vitamin C"),
        ],
      },
      {
        id: thirdLocation.id,
        code: thirdLocation.code,
        name: thirdLocation.name,
        status: "PENDING",
        products: [routeProduct("product-c", "000000000003", "Vitamin D")],
      },
    ],
  };
}

function tenProductRoute(sessionId = "session-a") {
  return {
    sessionId,
    expectedProducts: 10,
    locations: [{
      id: secondLocation.id,
      code: secondLocation.code,
      name: secondLocation.name,
      status: "PENDING",
      products: Array.from({ length: 10 }, (_, index) => ({
        productId: `product-${index + 1}`,
        barcodeValue: `0000000000${String(index).padStart(2, "0")}`,
        name: `Vitamin ${index + 1}`,
        packageSize: `${30 + index} tablets`,
        expectedStoreQty: 20 + index,
        suspectedLocations: [{ locationId: secondLocation.id, code: secondLocation.code, verified: false, evidence: "ASSIGNED" }],
      })),
    }],
  };
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
    localStorage.clear();
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

  async function renderPage(activeSession = countSession("session-a"), route: ReturnType<typeof countRoute> | null = null) {
    mocks.apiJson.mockImplementation(async (url: string) => {
      if (url === "/api/store-locations") return [location, secondLocation, thirdLocation];
      if (url === "/api/store-count/sessions/active") return activeSession;
      if (route && url === `/api/inventory-truth/counts/${activeSession.id}/route`) return route;
      throw new Error(`Unexpected request: ${url}`);
    });
    await act(async () => root.render(createElement(StoreCountPage)));
    await act(async () => undefined);
  }

  it("reopens the explicitly linked completed summary after reload instead of a newer active count", async () => {
    window.history.replaceState(null, "", "/store-count?sessionId=completed-original");
    mocks.apiJson.mockImplementation(async (url: string) => {
      if (url === "/api/store-locations") return [location];
      if (url === "/api/store-count/sessions/active") return countSession("newer-active");
      if (url === "/api/store-count/sessions/completed-original") return { ...countSession("completed-original"), siteId: "site", status: "COMPLETED" };
      if (url === "/api/store-count/sessions/completed-original/summary") return { ...countSummary("completed-original"), totalUnits: 13, session: { id: "completed-original", status: "COMPLETED", name: "Original locked count" } };
      throw new Error(url);
    });
    await act(async () => root.render(createElement(StoreCountPage)));
    expect(mocks.apiJson.mock.calls.some(([url]) => url === "/api/store-count/sessions/completed-original/summary")).toBe(true);
    expect(mocks.apiJson.mock.calls.some(([url]) => url === "/api/store-count/sessions/active")).toBe(false);
    expect(container.textContent).toContain("13");
    expect(container.querySelector('a[href="/store-count/review"]')).not.toBeNull();
    await act(async () => button("Review differences").click());
    expect(mocks.push).toHaveBeenCalledWith("/store-count/review?sessionId=completed-original");
  });

  it("hands an explained finished count to a manager after reload and returns to its original locked summary", async () => {
    const session = { ...countSession("session-a"), siteId: "site", name: "Original vitamin count" };
    const row = { id: "d1", productId: "vitamin", product: { name: "B12", barcodeValue: "01234", packageSize: "60 tablets" }, expectedStoreQty: 15, actualStoreQty: 13, difference: -2, status: "OPEN", reason: null as string | null, note: "", reviewToken: "a".repeat(64), countedLocations: [{ locationId: "shelf", code: "A1", name: "Shelf", quantity: 13 }] };
    const route = countRoute(); route.locations.forEach((location) => { location.status = "VERIFIED"; });
    mocks.apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/store-locations") return [location];
      if (url === "/api/store-count/sessions/active") return null;
      if (url === "/api/store-count/sessions/session-a") return structuredClone(session);
      if (url === "/api/inventory-truth/counts/session-a/route") return route;
      if (url === "/api/inventory-truth/counts/session-a/review") return { sessionId: session.id, sessionStatus: session.status, finalized: true, canExplain: session.status === "ACTIVE" && mocks.user.id === "employee-a", canApprove: mocks.user.id === "manager", discrepancies: [structuredClone(row)] };
      if (url.endsWith("/explain")) { Object.assign(row, JSON.parse(String(init?.body))); return row; }
      if (url.endsWith("/complete")) { expect(row.reason).toBe("COULD_NOT_FIND"); session.status = "COMPLETED"; return {}; }
      if (url.endsWith("/approve")) { expect(session.status).toBe("COMPLETED"); row.status = "APPROVED"; return {}; }
      if (url === "/api/inventory-truth/counts/reviews") return { pending: row.status === "OPEN" ? [{ ...session, site: { name: "Boynton" }, startedBy: { name: "Alex" } }] : [], completed: [] };
      if (url.endsWith("/summary")) return { ...countSummary(), session: { id: session.id, name: session.name, status: session.status }, totalUnits: 13 };
      throw new Error(url);
    });
    async function navigate(path: string, page: typeof StoreCountPage) {
      await act(async () => root.render(null));
      window.history.replaceState(null, "", path);
      await act(async () => root.render(createElement(page)));
    }
    await navigate("/store-count/review?sessionId=session-a", CountReviewPage);
    const select = container.querySelector("select")!;
    await act(async () => { select.value = "COULD_NOT_FIND"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => button("Save explanation").click());
    const returnPath = container.querySelector('a')!.getAttribute("href")!;
    await navigate(returnPath, StoreCountPage);
    await act(async () => button("Finish").click());
    expect(session.status).toBe("COMPLETED");
    mocks.user = { id: "manager" };
    await navigate("/store-count", StoreCountPage);
    const discovery = container.querySelector('a[href="/store-count/review"]')!;
    await navigate(discovery.getAttribute("href")!, CountReviewPage);
    const pending = container.querySelector('a[href="/store-count/review?sessionId=session-a"]')!;
    expect(pending.textContent).toContain("Original vitamin count");
    await navigate(pending.getAttribute("href")!, CountReviewPage);
    await act(async () => button("Approve new baseline").click());
    expect(row.status).toBe("APPROVED");
    await navigate(container.querySelector('a')!.getAttribute("href")!, StoreCountPage);
    expect(container.textContent).toContain("13 units");
    expect(container.textContent).toContain("Original vitamin count");
    expect(container.textContent).toContain("Finished and locked");
    expect(container.textContent).not.toContain("Barcode won’t scan?");
  });

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

  it("resumes the assigned session at its first unverified location and first unchecked product", async () => {
    const countedProduct = product("product-a", "012345678905", "Vitamin B12");
    const active = {
      ...countSession("session-resume"),
      siteId: "site-a",
      assignedToId: "employee-a",
      assignedTo: { id: "employee-a", name: "Alex Employee" },
      expectations: [{ id: "expectation-a", sessionId: "session-resume", productId: "product-a", expectedStoreQty: 15 }],
      locationVisits: [
        { id: "visit-1", sessionId: "session-resume", locationId: location.id, status: "VERIFIED", completedById: "employee-a", completedAt: "2026-09-13T01:00:00Z", location },
        { id: "visit-2", sessionId: "session-resume", locationId: secondLocation.id, status: "PENDING", completedById: null, completedAt: null, location: secondLocation },
      ],
      assignmentEvents: [],
      entries: [{
        ...entry("entry-resume", countedProduct.barcodeValue, countedProduct),
        locationId: secondLocation.id,
        location: { id: secondLocation.id, code: secondLocation.code },
      }],
    };

    await renderPage(active, countRoute(active.id));

    expect(container.querySelector("h2")?.textContent).toContain("END-01 — Endcap");
    expect(container.textContent).toContain("Assigned to Alex Employee");
    expect(container.textContent).toContain("Vitamin Count");
    expect(document.activeElement?.textContent?.trim()).toBe("Count Vitamin C");
    expect(mocks.apiJson.mock.calls.filter(([url]) => url === "/api/store-count/sessions")).toHaveLength(0);
    expect(mocks.apiJson.mock.calls.filter(([url]) => url === `/api/inventory-truth/counts/${active.id}/route`)).toHaveLength(1);
  });

  it("keeps product-list and manual UPC selection usable when the camera is denied and converges on quantity confirmation", async () => {
    mocks.cameraStart.mockRejectedValueOnce(new DOMException("Permission denied", "NotAllowedError"));
    await renderPage({ ...countSession("session-a"), siteId: "site-a" }, countRoute());

    await act(async () => button("Count Vitamin B12").click());
    expect(container.textContent).toContain("Item found");
    expect(container.textContent).toContain("Vitamin B12");
    expect(button("Confirm & Continue").disabled).toBe(false);

    await act(async () => button("Wrong item / Scan again").click());
    mocks.apiJson.mockImplementation(async (url: string) => {
      if (url === "/api/products/by-barcode/036000291452") return product("product-b", "036000291452", "Vitamin C");
      throw new Error(`Unexpected request: ${url}`);
    });
    await beginManualIdentification("036000291452");

    expect(container.textContent).toContain("Item found");
    expect(container.textContent).toContain("Vitamin C");
    expect(button("Confirm & Continue").disabled).toBe(false);
    expect(container.textContent).toContain("Camera permission is blocked.");
  });

  it("verifies a completed location with a flushed queue and advances to the next location only once", async () => {
    const first = product("product-a", "012345678905", "Vitamin B12");
    const second = product("product-b", "036000291452", "Vitamin C");
    const active = {
      ...countSession("session-a"),
      siteId: "site-a",
      entries: [
        { ...entry("entry-a", first.barcodeValue, first), locationId: secondLocation.id, location: { id: secondLocation.id, code: secondLocation.code } },
        { ...entry("entry-b", second.barcodeValue, second), locationId: secondLocation.id, location: { id: secondLocation.id, code: secondLocation.code } },
      ],
    };
    const verification = deferred<{ visit: { status: string }; discrepanciesFinalized: boolean; discrepancies: unknown[] }>();
    await renderPage(active, countRoute(active.id));
    const verificationPayloads: unknown[] = [];
    mocks.apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/inventory-truth/counts/session-a/locations/location-2/verify") {
        verificationPayloads.push(JSON.parse(String(init?.body)));
        return verification.promise;
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () => {
      button("Location complete").click();
      button("Location complete").click();
    });
    expect(verificationPayloads).toEqual([{ offlineQueueFlushed: true }]);
    expect(button("Location complete").disabled).toBe(true);

    await act(async () => verification.resolve({ visit: { status: "VERIFIED" }, discrepanciesFinalized: false, discrepancies: [] }));
    expect(container.querySelector("h2")?.textContent).toContain("BACK-01 — Back stock");
    expect(container.textContent).toContain("2 of 3 locations complete");
    expect(verificationPayloads).toHaveLength(1);
  });

  it("does not allow location verification while an offline count is still queued", async () => {
    const first = product("product-a", "012345678905", "Vitamin B12");
    const second = product("product-b", "036000291452", "Vitamin C");
    const active = {
      ...countSession("session-a"),
      siteId: "site-a",
      entries: [
        { ...entry("entry-a", first.barcodeValue, first), locationId: secondLocation.id, location: { id: secondLocation.id, code: secondLocation.code } },
        { ...entry("entry-b", second.barcodeValue, second), locationId: secondLocation.id, location: { id: secondLocation.id, code: secondLocation.code } },
      ],
    };
    enqueueCountScan({
      ownerUserId: "employee-a",
      sessionId: "session-a",
      locationId: secondLocation.id,
      barcodeValue: "036000291452",
      quantityDelta: 2,
    }, "queued-a");

    await renderPage(active, countRoute(active.id));

    expect(button("Location complete").disabled).toBe(true);
    expect(container.textContent).toContain("1 scan safely queued");
    expect(mocks.apiJson.mock.calls.filter(([url]) => String(url).endsWith("/verify"))).toHaveLength(0);
  });

  it("persists None here as an idempotent zero entry that survives reload and unlocks verification", async () => {
    const route = tenProductRoute();
    const positiveEntries = route.locations[0].products.slice(0, 9).map((routeProduct, index) => ({
      id: `entry-${index + 1}`,
      barcodeValue: routeProduct.barcodeValue,
      locationId: secondLocation.id,
      quantity: index + 1,
      product: { id: routeProduct.productId, name: routeProduct.name, manufacturer: null, packageSize: routeProduct.packageSize, barcodeValue: routeProduct.barcodeValue, isActive: true },
      location: { id: secondLocation.id, code: secondLocation.code },
    }));
    const active = { ...countSession("session-a"), siteId: "site-a", entries: positiveEntries };
    await renderPage(active, route);
    const posted: Array<Record<string, unknown>> = [];
    const absentProduct = route.locations[0].products[9];
    const zeroEntry = {
      id: "entry-zero",
      barcodeValue: absentProduct.barcodeValue,
      locationId: secondLocation.id,
      quantity: 0,
      product: { id: absentProduct.productId, name: absentProduct.name, manufacturer: null, packageSize: absentProduct.packageSize },
      location: { id: secondLocation.id, code: secondLocation.code },
    };
    mocks.apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/scan")) {
        posted.push(JSON.parse(String(init?.body)));
        return zeroEntry;
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () => button("None here for Vitamin 10").click());
    expect(posted).toEqual([{
      barcodeValue: absentProduct.barcodeValue,
      locationId: secondLocation.id,
      quantityDelta: 0,
      clientScanId: "scan-id-1",
    }]);
    expect(container.textContent).toContain("Vitamin 10");
    expect(container.textContent).toContain("0");

    await act(async () => root.unmount());
    root = createRoot(container);
    const resumed = { ...active, entries: [zeroEntry, ...positiveEntries] };
    let verified = 0;
    mocks.apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/store-locations") return [location, secondLocation, thirdLocation];
      if (url === "/api/store-count/sessions/active") return resumed;
      if (url === "/api/inventory-truth/counts/session-a/route") return route;
      if (url.endsWith("/verify")) {
        expect(JSON.parse(String(init?.body))).toEqual({ offlineQueueFlushed: true });
        verified++;
        return { visit: { status: "VERIFIED" }, discrepanciesFinalized: true, discrepancies: [] };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    await act(async () => root.render(createElement(StoreCountPage)));
    await act(async () => undefined);

    expect(button("Location complete").disabled).toBe(false);
    await act(async () => button("Location complete").click());
    expect(verified).toBe(1);
  });

  it("keeps managed counting disabled until a delayed new-session route establishes its location", async () => {
    const routeResponse = deferred<ReturnType<typeof countRoute>>();
    const created = { ...countSession("session-new"), siteId: "site-a" };
    mocks.apiJson.mockImplementation(async (url: string) => {
      if (url === "/api/store-locations") return [location, secondLocation, thirdLocation];
      if (url === "/api/store-count/sessions/active") return null;
      if (url === "/api/store-count/sessions") return created;
      if (url === "/api/store-count/sessions/session-new") return created;
      if (url === "/api/inventory-truth/counts/session-new/route") return routeResponse.promise;
      throw new Error(`Unexpected request: ${url}`);
    });
    await act(async () => root.render(createElement(StoreCountPage)));
    await act(async () => undefined);

    await act(async () => button("Start Count").click());
    expect(container.textContent).toContain("Loading assigned count route");
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector('[aria-label="Manual UPC"]')).toBeNull();
    for (const key of "012345678905") window.dispatchEvent(new KeyboardEvent("keydown", { key }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(mocks.apiJson.mock.calls.filter(([url]) => String(url).includes("/by-barcode/"))).toHaveLength(0);

    await act(async () => routeResponse.resolve(countRoute("session-new")));
    expect(container.querySelector("h2")?.textContent).toContain("END-01 — Endcap");
  });

  it("shows a retryable managed-route error instead of silently opening the legacy picker", async () => {
    const active = { ...countSession("session-a"), siteId: "site-a" };
    let attempts = 0;
    mocks.apiJson.mockImplementation(async (url: string) => {
      if (url === "/api/store-locations") return [location, secondLocation, thirdLocation];
      if (url === "/api/store-count/sessions/active") return active;
      if (url === "/api/inventory-truth/counts/session-a/route") {
        attempts++;
        if (attempts === 1) throw new Error("Route temporarily unavailable");
        return countRoute();
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    await act(async () => root.render(createElement(StoreCountPage)));
    await act(async () => undefined);

    expect(container.textContent).toContain("Route temporarily unavailable");
    expect(button("Retry route").disabled).toBe(false);
    expect(container.querySelector('[aria-label="Count location"]')).toBeNull();
    expect(container.querySelector("video")).toBeNull();
    await act(async () => button("Retry route").click());
    expect(attempts).toBe(2);
    expect(container.querySelector("h2")?.textContent).toContain("END-01 — Endcap");
  });

  it("distinguishes an authoritative legacy session and a managed empty route", async () => {
    await renderPage(countSession("legacy-session"));
    expect(button("Change").disabled).toBe(false);
    expect(mocks.apiJson.mock.calls.some(([url]) => String(url).includes("/inventory-truth/"))).toBe(false);

    await act(async () => root.unmount());
    root = createRoot(container);
    const managed = { ...countSession("managed-empty"), siteId: "site-a" };
    await renderPage(managed, { sessionId: managed.id, expectedProducts: 0, locations: [] });
    expect(container.textContent).toContain("No count locations are assigned");
    expect(container.querySelector('[aria-label="Count location"]')).toBeNull();
  });

  it("keeps compact selected-product evidence above quantity confirmation and returns focus after cancel and save", async () => {
    const active = { ...countSession("session-a"), siteId: "site-a" };
    await renderPage(active, countRoute());
    await act(async () => button("Count Vitamin B12").click());

    const context = container.querySelector<HTMLElement>('[aria-label="Current count context"]')!;
    const quantityCard = container.querySelector<HTMLElement>(".count-quantity-card")!;
    const checklist = container.querySelector<HTMLElement>('[aria-label="Location product checklist"]')!;
    expect(context.textContent).toContain("END-01 — Endcap");
    expect(context.textContent).toContain("Expected in store: 15");
    expect(context.textContent).toContain("Suggested places to check");
    expect(quantityCard.compareDocumentPosition(checklist) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    await act(async () => button("Wrong item / Scan again").click());
    expect(document.activeElement?.textContent?.trim()).toBe("Count Vitamin B12");

    await act(async () => button("Count Vitamin B12").click());
    const found = product("product-a", "012345678905", "Vitamin B12");
    mocks.apiJson.mockImplementation(async (url: string) => {
      if (url.endsWith("/scan")) return { ...entry("entry-a", found.barcodeValue, found), locationId: secondLocation.id, location: { id: secondLocation.id, code: secondLocation.code } };
      throw new Error(`Unexpected request: ${url}`);
    });
    await act(async () => button("Confirm & Continue").click());
    expect(document.activeElement?.textContent?.trim()).toBe("Count Vitamin C");
  });

  it("blocks verification for another owner's same-session queue record but not this owner's other-session record", async () => {
    const first = product("product-a", "012345678905", "Vitamin B12");
    const second = product("product-b", "036000291452", "Vitamin C");
    const active = {
      ...countSession("session-a"),
      siteId: "site-a",
      entries: [
        { ...entry("entry-a", first.barcodeValue, first), locationId: secondLocation.id, location: { id: secondLocation.id, code: secondLocation.code } },
        { ...entry("entry-b", second.barcodeValue, second), locationId: secondLocation.id, location: { id: secondLocation.id, code: secondLocation.code } },
      ],
    };
    const foreignId = enqueueCountScan({ ownerUserId: "employee-b", sessionId: "session-a", locationId: secondLocation.id, barcodeValue: first.barcodeValue, quantityDelta: 1 }, "foreign-owner");
    enqueueCountScan({ ownerUserId: "employee-a", sessionId: "different-session", locationId: location.id, barcodeValue: second.barcodeValue, quantityDelta: 1 }, "other-session");
    await renderPage(active, countRoute());

    expect(button("Count Vitamin B12").disabled).toBe(false);
    expect(button("Location complete").disabled).toBe(true);
    expect(container.textContent).toContain("Unsynced work for this count belongs to another sign-in");

    removeFromCountQueue(foreignId);
    await act(async () => window.dispatchEvent(new Event("online")));
    expect(button("Location complete").disabled).toBe(false);
  });

  it("captures multiple listed products offline with stable payloads, replays them after reload, then verifies", async () => {
    const active = { ...countSession("session-a"), siteId: "site-a" };
    const route = countRoute();
    await renderPage(active, route);
    mocks.apiJson.mockRejectedValue(new Error("Offline"));

    await act(async () => button("Count Vitamin B12").click());
    await act(async () => button("Confirm & Continue").click());
    expect(button("Count Vitamin C").disabled).toBe(false);
    await act(async () => button("Count Vitamin C").click());
    await act(async () => button("Confirm & Continue").click());

    expect(getCountQueue().map(({ id, sessionId, locationId, barcodeValue, quantityDelta, ownerUserId }) => ({ id, sessionId, locationId, barcodeValue, quantityDelta, ownerUserId }))).toEqual([
      { id: "scan-id-1", sessionId: "session-a", locationId: secondLocation.id, barcodeValue: "012345678905", quantityDelta: 1, ownerUserId: "employee-a" },
      { id: "scan-id-2", sessionId: "session-a", locationId: secondLocation.id, barcodeValue: "036000291452", quantityDelta: 1, ownerUserId: "employee-a" },
    ]);

    await act(async () => root.unmount());
    root = createRoot(container);
    const replayedEntries: ReturnType<typeof entry>[] = [];
    let verifyCalls = 0;
    mocks.apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/store-locations") return [location, secondLocation, thirdLocation];
      if (url === "/api/store-count/sessions/active") return active;
      if (url === "/api/inventory-truth/counts/session-a/route") return route;
      if (url.endsWith("/scan")) {
        const body = JSON.parse(String(init?.body)) as { barcodeValue: string; clientScanId: string };
        const routeProduct = route.locations[1].products.find((candidate) => candidate.barcodeValue === body.barcodeValue)!;
        const persisted = {
          ...entry(`entry-${body.clientScanId}`, body.barcodeValue, product(routeProduct.productId, body.barcodeValue, routeProduct.name)),
          locationId: secondLocation.id,
          location: { id: secondLocation.id, code: secondLocation.code },
        };
        replayedEntries.push(persisted);
        return persisted;
      }
      if (url === "/api/store-count/sessions/session-a") return { ...active, entries: replayedEntries };
      if (url.endsWith("/verify")) {
        verifyCalls++;
        return { visit: { status: "VERIFIED" }, discrepanciesFinalized: false, discrepancies: [] };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    await act(async () => root.render(createElement(StoreCountPage)));
    await act(async () => undefined);

    expect(getCountQueue()).toHaveLength(0);
    expect(button("Location complete").disabled).toBe(false);
    await act(async () => button("Location complete").click());
    expect(verifyCalls).toBe(1);
  });

  it("does not replay the previous employee's queue after identity changes within the same session", async () => {
    const active = { ...countSession("session-a"), siteId: "site-a" };
    await renderPage(active, countRoute());
    enqueueCountScan({ ownerUserId: "employee-a", sessionId: "session-a", locationId: secondLocation.id, barcodeValue: "012345678905", quantityDelta: 2 }, "previous-owner");
    const attempted: string[] = [];
    mocks.apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/store-locations") return [location, secondLocation, thirdLocation];
      if (url === "/api/store-count/sessions/active") return active;
      if (url === "/api/inventory-truth/counts/session-a/route") return countRoute();
      if (url.endsWith("/scan")) { attempted.push(JSON.parse(String(init?.body)).clientScanId); throw new Error("Offline"); }
      throw new Error(`Unexpected request: ${url}`);
    });
    mocks.user = { id: "employee-b" };
    await act(async () => root.render(createElement(StoreCountPage)));
    await act(async () => window.dispatchEvent(new Event("online")));
    expect(attempted).toEqual([]);
    expect(getCountQueue()).toMatchObject([{ id: "previous-owner", ownerUserId: "employee-a" }]);
    expect(container.textContent).toContain("Unsynced work for this count belongs to another sign-in");
  });

  it("preserves a pending quantity and location when foreground authentication returns a new object for the same employee", async () => {
    const active = { ...countSession("session-a"), siteId: "site-a" };
    await renderPage(active, countRoute());
    await act(async () => button("Count Vitamin B12").click());
    const quantity = container.querySelector<HTMLInputElement>(".count-quantity-card input")!;
    await changeInput(quantity, "17");
    const requestsBefore = mocks.apiJson.mock.calls.length;
    mocks.user = { id: "employee-a" };
    await act(async () => root.render(createElement(StoreCountPage)));
    expect(container.querySelector<HTMLInputElement>(".count-quantity-card input")?.value).toBe("17");
    expect(container.querySelector('[aria-label="Current count context"]')?.textContent).toContain("END-01");
    expect(container.textContent).not.toContain("Loading assigned count route");
    expect(mocks.apiJson.mock.calls).toHaveLength(requestsBefore);
    await act(async () => button("Wrong item / Scan again").click());
    expect(button("Count Vitamin B12").disabled).toBe(false);
  });

  it("preserves an in-flight save across a same-employee authentication refresh without a duplicate write", async () => {
    const active = { ...countSession("session-a"), siteId: "site-a" };
    await renderPage(active, countRoute());
    await act(async () => button("Count Vitamin B12").click());
    await changeInput(container.querySelector<HTMLInputElement>(".count-quantity-card input")!, "17");
    const saved = deferred<ReturnType<typeof entry>>();
    const payloads: Record<string, unknown>[] = [];
    mocks.apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/scan")) { payloads.push(JSON.parse(String(init?.body))); return saved.promise; }
      if (url === "/api/store-locations") return [location, secondLocation, thirdLocation];
      if (url === "/api/store-count/sessions/active") return active;
      if (url === "/api/inventory-truth/counts/session-a/route") return countRoute();
      throw new Error(`Unexpected request: ${url}`);
    });
    await act(async () => button("Confirm & Continue").click());
    mocks.user = { id: "employee-a" };
    await act(async () => root.render(createElement(StoreCountPage)));
    expect(container.querySelector<HTMLInputElement>(".count-quantity-card input")?.value).toBe("17");
    expect(container.textContent).not.toContain("Loading assigned count route");
    const found = product("product-a", "012345678905", "Vitamin B12");
    await act(async () => saved.resolve({ ...entry("saved-a", found.barcodeValue, found), quantity: 17, locationId: secondLocation.id, location: { id: secondLocation.id, code: secondLocation.code } }));
    expect(payloads).toEqual([{ barcodeValue: found.barcodeValue, quantityDelta: 17, locationId: secondLocation.id, clientScanId: "scan-id-1" }]);
    expect(button("Count Vitamin C").disabled).toBe(false);
    expect(container.textContent).toContain("17");
  });

  it("clears an unconfirmed prior employee item on a real identity change without writing it under the new employee", async () => {
    const active = { ...countSession("session-a"), siteId: "site-a" };
    await renderPage(active, countRoute());
    await act(async () => button("Count Vitamin B12").click());
    await changeInput(container.querySelector<HTMLInputElement>(".count-quantity-card input")!, "17");
    mocks.user = { id: "employee-b" };
    await act(async () => root.render(createElement(StoreCountPage)));
    expect(container.querySelector(".count-quantity-card")).toBeNull();
    expect(container.textContent).not.toContain("Loading assigned count route");
    expect(button("Count Vitamin B12").disabled).toBe(false);
    expect(mocks.apiJson.mock.calls.filter(([url]) => String(url).endsWith("/scan"))).toHaveLength(0);
    expect(mocks.show).toHaveBeenCalledWith("Sign-in changed. The unconfirmed item was not saved; check it again before counting.", "error");
  });

  it("ignores an old identity's deferred save response while preserving the new employee's pending count", async () => {
    const active = { ...countSession("session-a"), siteId: "site-a" };
    await renderPage(active, countRoute());
    const saved = deferred<ReturnType<typeof entry>>();
    let nextSession = active;
    mocks.apiJson.mockImplementation(async (url: string) => {
      if (url === "/api/store-locations") return [location, secondLocation, thirdLocation];
      if (url === "/api/store-count/sessions/active") return nextSession;
      if (url.includes("/route")) return countRoute(nextSession.id);
      if (url.endsWith("/scan")) return saved.promise;
      throw new Error(`Unexpected request: ${url}`);
    });
    await act(async () => button("Count Vitamin B12").click());
    await act(async () => button("Confirm & Continue").click());
    nextSession = { ...active, id: "session-b", name: "Employee B count" };
    mocks.user = { id: "employee-b" };
    await act(async () => root.render(createElement(StoreCountPage)));
    await act(async () => button("Count Vitamin C").click());
    await changeInput(container.querySelector<HTMLInputElement>(".count-quantity-card input")!, "23");
    const found = product("product-a", "012345678905", "Old employee result");
    await act(async () => saved.resolve({ ...entry("old-entry", found.barcodeValue, found), quantity: 91, locationId: secondLocation.id, location: { id: secondLocation.id, code: secondLocation.code } }));
    expect(container.textContent).toContain("Employee B count");
    expect(container.textContent).not.toContain("Old employee result");
    expect(container.querySelector<HTMLInputElement>(".count-quantity-card input")?.value).toBe("23");
    expect(button("Confirm & Continue").disabled).toBe(false);
    await act(async () => button("Wrong item / Scan again").click());
    expect(button("Count Vitamin C").disabled).toBe(false);
  });

  it("ignores a stale active-session initialization response after the employee changes", async () => {
    const stale = deferred<ReturnType<typeof countSession>>();
    let requests = 0;
    mocks.apiJson.mockImplementation(async (url: string) => {
      if (url === "/api/store-locations") return [location, secondLocation, thirdLocation];
      if (url === "/api/store-count/sessions/active") return ++requests === 1 ? stale.promise : { ...countSession("session-b"), siteId: "site-a", name: "Employee B count" };
      if (url.includes("/route")) return countRoute("session-b");
      throw new Error(`Unexpected request: ${url}`);
    });
    await act(async () => root.render(createElement(StoreCountPage)));
    mocks.user = { id: "employee-b" };
    await act(async () => root.render(createElement(StoreCountPage)));
    await act(async () => stale.resolve({ ...countSession("session-a"), name: "Stale employee A count" }));
    expect(container.textContent).toContain("Employee B count");
    expect(container.textContent).not.toContain("Stale employee A count");
    expect(button("Count Vitamin B12").disabled).toBe(false);
  });

  it.each([
    ["create", "success"], ["detail", "success"],
    ["create", "failure"], ["detail", "failure"],
  ])("ignores an old employee's deferred Start %s %s without changing the new pending count", async (stage, outcome) => {
    const oldRequest = deferred<ReturnType<typeof countSession>>();
    const oldSession = { ...countSession("session-old"), siteId: "site-a", name: "Old employee count" };
    const nextSession = { ...countSession("session-new"), siteId: "site-a", name: "New employee count" };
    const writes: Array<{ url: string; body: Record<string, unknown> }> = [];
    mocks.apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/store-locations") return [location, secondLocation, thirdLocation];
      if (url === "/api/store-count/sessions/active") return mocks.user.id === "employee-a" ? null : nextSession;
      if (url === "/api/store-count/sessions") return stage === "create" ? oldRequest.promise : oldSession;
      if (url === "/api/store-count/sessions/session-old") return stage === "detail" ? oldRequest.promise : oldSession;
      if (url === "/api/inventory-truth/counts/session-new/route") return countRoute("session-new");
      if (url === "/api/inventory-truth/counts/session-old/route") return countRoute("session-old");
      if (url.endsWith("/scan")) {
        writes.push({ url, body: JSON.parse(String(init?.body)) });
        const found = product("product-a", "012345678905", "Vitamin B12");
        return { ...entry("new-entry", found.barcodeValue, found), quantity: 17, locationId: secondLocation.id, location: { id: secondLocation.id, code: secondLocation.code } };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    await act(async () => root.render(createElement(StoreCountPage)));
    await act(async () => button("Start Count").click());
    mocks.user = { id: "employee-b" };
    await act(async () => root.render(createElement(StoreCountPage)));
    await act(async () => button("Count Vitamin B12").click());
    await changeInput(container.querySelector<HTMLInputElement>(".count-quantity-card input")!, "17");
    const callsBeforeOldResult = mocks.apiJson.mock.calls.length;
    if (outcome === "success") await act(async () => oldRequest.resolve(oldSession));
    else await act(async () => oldRequest.reject(new Error("Obsolete employee A error")));
    expect(container.textContent).toContain("New employee count");
    expect(container.textContent).not.toContain("Old employee count");
    expect(container.querySelector<HTMLInputElement>(".count-quantity-card input")?.value).toBe("17");
    expect(container.querySelector('[aria-label="Current count context"]')?.textContent).toContain("END-01");
    expect(mocks.apiJson.mock.calls).toHaveLength(callsBeforeOldResult);
    expect(mocks.show).not.toHaveBeenCalledWith("Obsolete employee A error", "error");
    await act(async () => button("Confirm & Continue").click());
    expect(writes).toEqual([{ url: "/api/store-count/sessions/session-new/scan", body: { barcodeValue: "012345678905", locationId: secondLocation.id, quantityDelta: 17, clientScanId: "scan-id-1" } }]);
  });

  it("continues a deferred Start after a same-employee auth-object refresh", async () => {
    const created = { ...countSession("session-new"), siteId: "site-a" };
    const creation = deferred<ReturnType<typeof countSession>>();
    mocks.apiJson.mockImplementation(async (url: string) => {
      if (url === "/api/store-locations") return [location, secondLocation, thirdLocation];
      if (url === "/api/store-count/sessions/active") return null;
      if (url === "/api/store-count/sessions") return creation.promise;
      if (url === "/api/store-count/sessions/session-new") return created;
      if (url === "/api/inventory-truth/counts/session-new/route") return countRoute("session-new");
      throw new Error(`Unexpected request: ${url}`);
    });
    await act(async () => root.render(createElement(StoreCountPage)));
    await act(async () => button("Start Count").click());
    mocks.user = { id: "employee-a" };
    await act(async () => root.render(createElement(StoreCountPage)));
    await act(async () => creation.resolve(created));
    expect(button("Count Vitamin B12").disabled).toBe(false);
    expect(mocks.apiJson.mock.calls.filter(([url]) => url === "/api/store-count/sessions")).toHaveLength(1);
  });

  it("enters a route-complete state after final verification and only reopens counting through Review", async () => {
    const found = product("product-a", "012345678905", "Vitamin B12");
    const route = countRoute();
    route.locations = [{ ...route.locations[1], products: [route.locations[1].products[0]] }];
    const active = {
      ...countSession("session-a"),
      siteId: "site-a",
      entries: [{ ...entry("entry-a", found.barcodeValue, found), locationId: secondLocation.id, location: { id: secondLocation.id, code: secondLocation.code } }],
    };
    await renderPage(active, route);
    mocks.apiJson.mockImplementation(async (url: string) => {
      if (url.endsWith("/verify")) return { visit: { status: "VERIFIED" }, discrepanciesFinalized: true, discrepancies: [] };
      throw new Error(`Unexpected request: ${url}`);
    });
    await act(async () => button("Location complete").click());

    expect(container.textContent).toContain("All assigned locations are checked");
    expect(button("Finish").disabled).toBe(false);
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector('[aria-label="Manual UPC"]')).toBeNull();
    await act(async () => button("Review locations").click());
    await act(async () => button("Review END-01").click());
    expect(container.querySelector("video")).not.toBeNull();
    expect(button("Count Vitamin B12").disabled).toBe(false);
  });

  it("resumes an all-verified managed session in route-complete state without reopening a location", async () => {
    const active = { ...countSession("session-a"), siteId: "site-a" };
    const route = countRoute();
    route.locations = route.locations.map((location) => ({ ...location, status: "VERIFIED" }));
    await renderPage(active, route);

    expect(container.textContent).toContain("All assigned locations are checked");
    expect(container.querySelector('[data-product-id]')).toBeNull();
    expect(button("Review locations").disabled).toBe(false);
    expect(button("Review differences").disabled).toBe(false);
    await act(async () => button("Review differences").click());
    expect(mocks.push).toHaveBeenCalledWith("/store-count/review?sessionId=session-a");
  });

  it("keeps hardware and manual UPC counting available when camera permission is denied", async () => {
    mocks.cameraStart.mockRejectedValueOnce(new DOMException("Permission denied", "NotAllowedError"));
    const active = { ...countSession("session-a"), siteId: "site-a" };
    await renderPage(active, countRoute());
    const found = product("product-a", "012345678905", "Vitamin B12");
    mocks.apiJson.mockImplementation(async (url: string) => {
      if (url === "/api/products/by-barcode/012345678905") return found;
      throw new Error(`Unexpected request: ${url}`);
    });

    for (const key of found.barcodeValue) window.dispatchEvent(new KeyboardEvent("keydown", { key }));
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })));
    expect(container.textContent).toContain("Item found");
    await act(async () => button("Wrong item / Scan again").click());
    expect(button("Barcode won’t scan?").disabled).toBe(false);
  });

  it("lets an employee discard only a rejected display-parent capture and continue the count", async () => {
    const display = product("display-parent", "012345678905", "Mixed vitamin display");
    await renderPage();
    mocks.apiJson.mockImplementation(async (url: string) => {
      if (url === "/api/products/by-barcode/012345678905") return display;
      if (url.endsWith("/scan")) {
        throw new ApiError("This is a display or mixed package. Count its individual component products, not the parent package.", 409);
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await beginManualIdentification(display.barcodeValue);
    await act(async () => button("Confirm & Continue").click());
    await act(async () => undefined);

    expect(getCountQueue()).toHaveLength(1);
    expect(container.textContent).toContain("Count each component product instead");
    expect(button("Discard parent & scan components")).not.toBeNull();
    await act(async () => button("Discard parent & scan components").click());

    expect(getCountQueue()).toHaveLength(0);
    expect(container.textContent).not.toContain("captured scan needs review");
    expect(container.textContent).toContain("Barcode won’t scan?");
    expect(mocks.apiJson.mock.calls.some(([url]) => String(url).endsWith("/cancel"))).toBe(false);
  });

  it("keeps ordinary server rejections retained and completion-blocking without a discard action", async () => {
    enqueueCountScan({ ownerUserId: "employee-a", sessionId: "session-a", locationId: location.id, barcodeValue: "012345678905", quantityDelta: 1 }, "generic-failure");
    const queued = getCountQueue()[0];
    localStorage.setItem("continuixai_count_queue", JSON.stringify([{ ...queued, status: "failed", failureReason: "count session is not active" }]));

    await renderPage();

    expect(container.textContent).toContain("count session is not active");
    expect(container.querySelectorAll("button")).not.toSatisfy((buttons: NodeListOf<HTMLButtonElement>) => Array.from(buttons).some((candidate) => candidate.textContent === "Discard parent & scan components"));
    expect(button("Finish").disabled).toBe(true);
  });

  it("corrects a saved entry with an absolute PATCH and safely retries the same total after an offline failure", async () => {
    const countedProduct = product("product-a", "012345678905", "Vitamin B12");
    const active = countSession("session-a");
    active.entries = [entry("entry-a", countedProduct.barcodeValue, countedProduct)];
    await renderPage(active);
    const writes: Array<{ url: string; method?: string; body: unknown }> = [];
    let attempt = 0;
    mocks.apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/store-count/sessions/session-a/entries/entry-a") {
        writes.push({ url, method: init?.method, body: JSON.parse(String(init?.body)) });
        attempt++;
        if (attempt === 1) throw new Error("offline");
        return { ...active.entries[0], quantity: 9 };
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () => button("Correct total").click());
    const total = container.querySelector<HTMLInputElement>('input[aria-label="Correct total for Vitamin B12"]')!;
    expect(total.value).toBe("4");
    expect(container.textContent).toContain("Set the full total at this location");
    await changeInput(total, "9");
    await act(async () => button("Set total").click());
    await act(async () => undefined);

    expect(container.querySelector<HTMLInputElement>('input[aria-label="Correct total for Vitamin B12"]')?.value).toBe("9");
    expect(getCountQueue()).toHaveLength(0);
    await act(async () => button("Set total").click());

    expect(writes).toEqual([
      { url: "/api/store-count/sessions/session-a/entries/entry-a", method: "PATCH", body: { quantity: 9, expectedQuantity: 4 } },
      { url: "/api/store-count/sessions/session-a/entries/entry-a", method: "PATCH", body: { quantity: 9, expectedQuantity: 4 } },
    ]);
    expect(container.textContent).toContain("Vitamin B12");
    expect(container.textContent).toContain("9");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Correct total for Vitamin B12"]')).toBeNull();
  });

  it("blocks absolute correction while a matching additive delta is queued or syncing", async () => {
    const countedProduct = product("product-a", "012345678905", "Vitamin B12");
    const active = countSession("session-a");
    active.entries = [entry("entry-a", countedProduct.barcodeValue, countedProduct)];
    const replay = deferred<ReturnType<typeof entry>>();
    enqueueCountScan({ ownerUserId: "employee-a", sessionId: active.id, locationId: location.id, barcodeValue: countedProduct.barcodeValue, quantityDelta: 2 }, "queued-addition");
    mocks.apiJson.mockImplementation(async (url: string) => {
      if (url === "/api/store-locations") return [location, secondLocation, thirdLocation];
      if (url === "/api/store-count/sessions/active") return active;
      if (url === "/api/store-count/sessions/session-a/scan") return replay.promise;
      if (url === "/api/store-count/sessions/session-a") return { ...active, entries: [{ ...active.entries[0], quantity: 6 }] };
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () => root.render(createElement(StoreCountPage)));
    await act(async () => undefined);

    expect(button("Correct total").disabled).toBe(true);
    expect(container.textContent).toContain("Sync the 2 pending added units before correcting this total");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Correct total for Vitamin B12"]')).toBeNull();
    expect(getCountQueue()).toHaveLength(1);

    await act(async () => replay.resolve({ ...active.entries[0], quantity: 6 }));
    await act(async () => undefined);
    expect(getCountQueue()).toHaveLength(0);
    expect(button("Correct total").disabled).toBe(false);
  });

  it("does not PATCH or replay a matching delta that appears during correction, then syncs it after cancellation", async () => {
    const countedProduct = product("product-a", "012345678905", "Vitamin B12");
    const active = countSession("session-a");
    active.entries = [entry("entry-a", countedProduct.barcodeValue, countedProduct)];
    await renderPage(active);
    const writes: string[] = [];
    mocks.apiJson.mockImplementation(async (url: string) => {
      if (url === "/api/store-count/sessions/session-a/entries/entry-a") {
        writes.push("absolute correction");
        return { ...active.entries[0], quantity: 9 };
      }
      if (url === "/api/store-count/sessions/session-a/scan") {
        writes.push("queued delta");
        return { ...active.entries[0], quantity: 6 };
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () => button("Correct total").click());
    await changeInput(container.querySelector<HTMLInputElement>('input[aria-label="Correct total for Vitamin B12"]')!, "9");
    enqueueCountScan({ ownerUserId: "employee-a", sessionId: active.id, locationId: location.id, barcodeValue: countedProduct.barcodeValue, quantityDelta: 2 }, "late-addition");
    await act(async () => button("Set total").click());

    expect(writes).toEqual([]);
    expect(container.textContent).toContain("Pending added units must sync first. Cancel correction to sync them, then try again.");
    expect(getCountQueue()).toHaveLength(1);
    await act(async () => window.dispatchEvent(new Event("online")));
    expect(writes).toEqual([]);
    expect(getCountQueue()).toHaveLength(1);

    await act(async () => button("Cancel correction").click());
    await act(async () => undefined);
    expect(writes).toEqual(["queued delta"]);
    expect(getCountQueue()).toHaveLength(0);
  });

  it("allows correction when queued work belongs to another session, location, or barcode", async () => {
    const countedProduct = product("product-a", "012345678905", "Vitamin B12");
    const active = countSession("session-a");
    active.entries = [entry("entry-a", countedProduct.barcodeValue, countedProduct)];
    enqueueCountScan({ ownerUserId: "employee-a", sessionId: "another-session", locationId: location.id, barcodeValue: countedProduct.barcodeValue, quantityDelta: 2 }, "other-session");
    enqueueCountScan({ ownerUserId: "employee-a", sessionId: active.id, locationId: secondLocation.id, barcodeValue: countedProduct.barcodeValue, quantityDelta: 3 }, "other-location");
    enqueueCountScan({ ownerUserId: "employee-a", sessionId: active.id, locationId: location.id, barcodeValue: "unknown-upc", quantityDelta: 4 }, "other-barcode");

    await renderPage(active);
    await act(async () => button("Correct total").click());

    expect(container.querySelector<HTMLInputElement>('input[aria-label="Correct total for Vitamin B12"]')).not.toBeNull();
    expect(container.textContent).not.toContain("pending added units before correcting this total");
  });

  it("counts all ten products in one location with keyboard confirmation, no premature Finish, and an offline zero", async () => {
    const route = tenProductRoute();
    const active = { ...countSession("session-a"), siteId: "site-a" };
    await renderPage(active, route);
    const saved: ReturnType<typeof entry>[] = [];
    let offline = false;
    let verified = 0;
    const payloads: Array<{ barcodeValue: string; quantityDelta: number; clientScanId: string; locationId: string }> = [];
    mocks.apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/scan")) {
        if (offline) throw new Error("Offline");
        const body = JSON.parse(String(init?.body));
        payloads.push(body);
        const routeProduct = route.locations[0].products.find((product) => product.barcodeValue === body.barcodeValue)!;
        const result = { ...entry(`entry-${routeProduct.productId}`, body.barcodeValue, product(routeProduct.productId, body.barcodeValue, routeProduct.name)), quantity: body.quantityDelta, locationId: secondLocation.id, location: { id: secondLocation.id, code: secondLocation.code } };
        saved.push(result);
        return result;
      }
      if (url === "/api/store-count/sessions/session-a") return { ...active, entries: saved };
      if (url.endsWith("/verify")) { verified++; return { visit: { status: "VERIFIED" } }; }
      throw new Error(`Unexpected request: ${url}`);
    });
    for (let index = 0; index < 9; index++) {
      expect(button("Finish").disabled).toBe(true);
      expect(document.activeElement?.textContent?.trim()).toBe(`Count Vitamin ${index + 1}`);
      await act(async () => button(`Count Vitamin ${index + 1}`).click());
      const quantity = container.querySelector<HTMLInputElement>('.count-quantity-card input')!;
      expect(document.activeElement).toBe(quantity);
      expect(container.querySelector('[aria-label="Current count context"]')?.textContent).toContain(`Vitamin ${index + 1}`);
      await changeInput(quantity, String(index + 1));
      await act(async () => quantity.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    }
    offline = true;
    await act(async () => rapidMode().click());
    await act(async () => button("None here for Vitamin 10").click());
    expect(getCountQueue()).toMatchObject([{ id: "scan-id-10", quantityDelta: 0, locationId: secondLocation.id, ownerUserId: "employee-a" }]);
    expect(button("Location complete").disabled).toBe(true);
    offline = false;
    await act(async () => window.dispatchEvent(new Event("online")));
    expect(getCountQueue()).toHaveLength(0);
    expect(payloads.map((body) => body.quantityDelta)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 0]);
    expect(payloads.every((body) => body.locationId === secondLocation.id)).toBe(true);
    expect(payloads[9].clientScanId).toBe("scan-id-10");
    expect(document.activeElement?.textContent?.trim()).toBe("Location complete");
    await act(async () => button("Location complete").click());
    expect(verified).toBe(1);
    expect(container.textContent).toContain("All assigned locations are checked");
  });
});
