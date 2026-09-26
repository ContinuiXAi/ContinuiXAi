import { describe, expect, it, vi } from "vitest";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";
import { BrowserCodeReader } from "@zxing/browser";
import { createScanHints, getScannerFocusRegion, isQrScanFormat, normalizeBarcodeFromScanFormat, symbologyFromScanFormat } from "./barcodeScanner";

describe("barcodeScanner format constants vs @zxing/library", () => {
  it("validates ZXing UPC/EAN reads and canonicalizes UPC-A encoded as EAN-13", () => {
    expect(normalizeBarcodeFromScanFormat("036000291452", BarcodeFormat.UPC_A)).toBe("036000291452");
    expect(normalizeBarcodeFromScanFormat("0036000291452", BarcodeFormat.EAN_13)).toBe("036000291452");
    expect(normalizeBarcodeFromScanFormat("04210007", BarcodeFormat.UPC_E)).toBe("042000001007");
    expect(normalizeBarcodeFromScanFormat("04210008", BarcodeFormat.UPC_E)).toBeNull();
    expect(normalizeBarcodeFromScanFormat("036000291453", BarcodeFormat.UPC_A)).toBeNull();
    expect(normalizeBarcodeFromScanFormat("ABC-123", BarcodeFormat.CODE_128)).toBe("ABC-123");
  });

  it("maps BarcodeFormat enum values to the expected symbology", () => {
    expect(symbologyFromScanFormat(BarcodeFormat.EAN_13)).toBe("EAN13");
    expect(symbologyFromScanFormat(BarcodeFormat.UPC_A)).toBe("UPCA");
    expect(symbologyFromScanFormat(BarcodeFormat.CODE_128)).toBe("CODE128");
    expect(symbologyFromScanFormat(BarcodeFormat.QR_CODE)).toBe("QR");
    expect(symbologyFromScanFormat(BarcodeFormat.EAN_8)).toBe("OTHER");
    expect(symbologyFromScanFormat(BarcodeFormat.UPC_E)).toBe("OTHER");
  });

  it("detects QR via the library enum value", () => {
    expect(isQrScanFormat(BarcodeFormat.QR_CODE)).toBe(true);
    expect(isQrScanFormat(BarcodeFormat.EAN_13)).toBe(false);
  });

  it("enables aggressive decoding for live retail UPC/EAN camera scans", async () => {
    const hints = await createScanHints();
    expect(hints.get(DecodeHintType.TRY_HARDER)).toBe(true);
    expect(hints.get(DecodeHintType.POSSIBLE_FORMATS)).toEqual([
      BarcodeFormat.EAN_13,
      BarcodeFormat.EAN_8,
      BarcodeFormat.UPC_A,
      BarcodeFormat.UPC_E,
      BarcodeFormat.CODE_128,
      BarcodeFormat.QR_CODE,
    ]);
  });

  it("crops live video to the center scan guide so retail barcodes occupy more pixels", () => {
    expect(getScannerFocusRegion(1280, 720)).toEqual({
      sx: 154,
      sy: 209,
      sw: 973,
      sh: 302,
      outputWidth: 1216,
      outputHeight: 378,
    });
  });

  it("cycles the ZXing fallback through normal, tight, and contrast-focused passes", async () => {
    await createScanHints();
    const video = document.createElement("video");
    Object.defineProperties(video, {
      videoWidth: { value: 1280 },
      videoHeight: { value: 720 },
    });
    const filters: string[] = [];
    const context = {
      canvas: document.createElement("canvas"),
      filter: "none",
      drawImage: vi.fn(function (this: { filter: string }) { filters.push(this.filter); }),
    } as unknown as CanvasRenderingContext2D;

    BrowserCodeReader.drawImageOnCanvas(context, video);
    BrowserCodeReader.drawImageOnCanvas(context, video);
    BrowserCodeReader.drawImageOnCanvas(context, video);

    expect((context.drawImage as ReturnType<typeof vi.fn>).mock.calls.map((call) => call.slice(1, 5))).toEqual([
      [154, 209, 973, 302],
      [243, 238, 794, 245],
      [154, 209, 973, 302],
    ]);
    expect(filters).toEqual(["none", "none", "grayscale(1) contrast(1.45)"]);
    expect(context.filter).toBe("none");
  });
});
