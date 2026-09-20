// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import * as scannerEngine from "./scannerEngine";
import {
  getRetailScannerFocusRegion,
  mapRetailScannerFocusToDisplay,
  getScannerGuidance,
  preferredScannerEngine,
  RETAIL_FRAME_MAX_WIDTH,
  retailDecodeConfig,
  SCANNER_FRAME_INTERVAL_MS,
  shouldEmitRetailScan,
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
