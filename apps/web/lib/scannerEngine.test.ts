// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import * as scannerEngine from "./scannerEngine";
import {
  getRetailScannerFocusRegion,
  getRetailScannerCapturePlan,
  mapRetailScannerFocusToDisplay,
  getScannerGuidance,
  preferredScannerEngine,
  RETAIL_FRAME_MAX_WIDTH,
  retailDecodeConfig,
  SCANNER_FRAME_INTERVAL_MS,
  shouldEmitRetailScan,
  normalizeRetailBarcode,
} from "./scannerEngine";

afterEach(() => {
  document.head.querySelectorAll("script[data-continuix-quagga]").forEach((script) => script.remove());
  delete window.Quagga;
  vi.resetModules();
});

describe("retail scanner engine", () => {
  it("uses Quagga when the retail scanner is available and ZXing only as fallback", () => {
    expect(preferredScannerEngine(true)).toBe("quagga");
    expect(preferredScannerEngine(false)).toBe("zxing");
  });

  it("limits decoding to the retail formats used by store products", () => {
    const config = retailDecodeConfig("data:image/jpeg;base64,frame") as {
      locate: boolean;
      inputStream: { size: number };
      decoder: { readers: string[] };
    };
    expect(config.locate).toBe(true);
    expect(config.inputStream.size).toBeLessThanOrEqual(RETAIL_FRAME_MAX_WIDTH);
    expect(config.decoder.readers).toEqual([
      "upc_reader",
      "ean_reader",
      "ean_8_reader",
      "upc_e_reader",
      "code_128_reader",
    ]);
    expect(config.decoder.readers).not.toContain("qr_reader");
  });

  it("centers a focused retail decode region and excludes the outer frame", () => {
    expect(getRetailScannerFocusRegion(1280, 720)).toEqual({
      sx: 154,
      sy: 209,
      sw: 973,
      sh: 302,
    });
  });

  it("alternates normal, tighter, and contrast-enhanced focused capture plans", () => {
    expect(getRetailScannerCapturePlan(1280, 720, 0)).toEqual({
      sx: 154, sy: 209, sw: 973, sh: 302, contrast: false,
    });
    expect(getRetailScannerCapturePlan(1280, 720, 1)).toEqual({
      sx: 243, sy: 238, sw: 794, sh: 245, contrast: false,
    });
    expect(getRetailScannerCapturePlan(1280, 720, 2)).toEqual({
      sx: 154, sy: 209, sw: 973, sh: 302, contrast: true,
    });
    expect(getRetailScannerCapturePlan(1280, 720, 3)).toEqual(getRetailScannerCapturePlan(1280, 720, 0));
  });

  it("accepts valid retail checksums and canonicalizes EAN-13 encoded UPC-A", () => {
    expect(normalizeRetailBarcode("036000291452", "upc_a")).toBe("036000291452");
    expect(normalizeRetailBarcode("0036000291452", "ean_13")).toBe("036000291452");
    expect(normalizeRetailBarcode("96385074", "ean_8")).toBe("96385074");
    expect(normalizeRetailBarcode("ABC-123", "code_128")).toBe("ABC-123");
  });

  it("validates compressed UPC-E and expands it to the catalog's UPC-A value", () => {
    expect(normalizeRetailBarcode("04210007", "upc_e")).toBe("042000001007");
    expect(normalizeRetailBarcode("01234531", "upc_e")).toBe("012300000451");
    expect(normalizeRetailBarcode("01234543", "upc_e")).toBe("012340000053");
    expect(normalizeRetailBarcode("01234558", "upc_e")).toBe("012345000058");
    expect(normalizeRetailBarcode("11234502", "upc_e")).toBe("112000003452");
    expect(normalizeRetailBarcode("04210008", "upc_e")).toBeNull();
    expect(normalizeRetailBarcode("21234558", "upc_e")).toBeNull();
  });

  it("rejects corrupted UPC/EAN camera reads instead of looking up the wrong product", () => {
    expect(normalizeRetailBarcode("036000291453", "upc_a")).toBeNull();
    expect(normalizeRetailBarcode("0036000291453", "ean_13")).toBeNull();
    expect(normalizeRetailBarcode("96385075", "ean_8")).toBeNull();
    expect(normalizeRetailBarcode("0360O0291452", "upc_a")).toBeNull();
  });

  it("maps the decoded region onto a landscape video displayed with cover scaling", () => {
    expect(mapRetailScannerFocusToDisplay(1280, 720, 360, 270)).toEqual({
      left: 0,
      top: 78,
      width: 360,
      height: 114,
    });
  });

  it("maps the decoded region onto a portrait video displayed with cover scaling", () => {
    expect(mapRetailScannerFocusToDisplay(720, 1280, 360, 270)).toEqual({
      left: 44,
      top: 1,
      width: 273,
      height: 269,
    });
  });

  it("uses a bounded faster decode cadence", () => {
    expect(SCANNER_FRAME_INTERVAL_MS).toBeGreaterThanOrEqual(140);
    expect(SCANNER_FRAME_INTERVAL_MS).toBeLessThanOrEqual(220);
  });

  it("gives calm, actionable guidance as a scan attempt takes longer", () => {
    expect(getScannerGuidance(0)).toBe("Center one barcode inside the box.");
    expect(getScannerGuidance(1_999)).toBe("Center one barcode inside the box.");
    expect(getScannerGuidance(2_000)).toBe("Hold steady and fill the box with the barcode.");
    expect(getScannerGuidance(4_999)).toBe("Hold steady and fill the box with the barcode.");
    expect(getScannerGuidance(5_000)).toBe("Try more light or tap ‘Barcode won’t scan?’");
  });

  it("suppresses repeated reads of the same barcode until the quiet period passes", () => {
    expect(shouldEmitRetailScan("123456789012", null, 1000)).toBe(true);
    expect(shouldEmitRetailScan("123456789012", { value: "123456789012", at: 1000 }, 1500)).toBe(false);
    expect(shouldEmitRetailScan("123456789012", { value: "123456789012", at: 1000 }, 2300)).toBe(true);
    expect(shouldEmitRetailScan("999999999999", { value: "123456789012", at: 1000 }, 1100)).toBe(true);
  });

  it("loads the retail decoder without injecting a third-party runtime script", async () => {
    const { loadRetailScanner } = await import("./scannerEngine");
    const loading = loadRetailScanner();
    await Promise.resolve();

    const externalScripts = [...document.scripts].filter((script) => /^https?:/.test(script.src));
    expect(externalScripts).toHaveLength(0);

    for (const script of document.head.querySelectorAll<HTMLScriptElement>("script[data-continuix-quagga]")) {
      script.dispatchEvent(new Event("error"));
    }
    await loading.catch(() => undefined);
  });

  it("describes the scanner state in plain language for the Count screen", () => {
    const describeScannerStatus = (scannerEngine as unknown as {
      describeScannerStatus?: (state: string, locationCode?: string) => string;
    }).describeScannerStatus;

    expect(describeScannerStatus?.("starting", "A-01")).toBe("Starting camera at A-01…");
    expect(describeScannerStatus?.("ready", "A-01")).toBe("Camera ready at A-01 · aim the barcode inside the box");
    expect(describeScannerStatus?.("retail", "A-01")).toBe("Retail scanner ready at A-01 · aim the barcode inside the box");
    expect(describeScannerStatus?.("fallback", "A-01")).toBe("Backup scanner active at A-01 · aim the barcode inside the box");
  });

  it("persists decoder status so Count can restore an event emitted before the session starts", () => {
    type StatusTarget = EventTarget & { __continuixRetailScannerStatus?: string };
    const target = new EventTarget() as StatusTarget;
    const publishStatus = (scannerEngine as unknown as {
      publishRetailScannerStatus?: (target: StatusTarget, status: string) => void;
    }).publishRetailScannerStatus;
    const readStatus = (scannerEngine as unknown as {
      readRetailScannerStatus?: (target: StatusTarget) => string | undefined;
    }).readRetailScannerStatus;

    publishStatus?.(target, "fallback");

    expect(readStatus?.(target)).toBe("fallback");
  });

  it("does not overwrite a terminal decoder status when the camera stream becomes ready", () => {
    const markCameraReady = (scannerEngine as unknown as {
      markCameraReady?: (status: string) => string;
    }).markCameraReady;

    expect(markCameraReady?.("starting")).toBe("ready");
    expect(markCameraReady?.("retail")).toBe("retail");
    expect(markCameraReady?.("fallback")).toBe("fallback");
  });
});
