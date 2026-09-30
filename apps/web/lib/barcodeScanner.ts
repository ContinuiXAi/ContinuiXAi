import type { BarcodeSymbology } from "./types";
import { getRetailScannerCapturePlan, normalizeRetailBarcode } from "./scannerEngine";

const FORMAT_EAN_13 = 7;
const FORMAT_EAN_8 = 6;
const FORMAT_UPC_A = 14;
const FORMAT_UPC_E = 15;
const FORMAT_CODE_128 = 4;
const FORMAT_QR_CODE = 11;

export const SCAN_VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: "environment",
  width: { ideal: 1280 },
  height: { ideal: 720 },
  advanced: [{ focusMode: "continuous" }] as unknown as MediaTrackConstraintSet[],
};

export function getScannerFocusRegion(width: number, height: number) {
  const { sx, sy, sw, sh } = getRetailScannerCapturePlan(width, height, 0);
  return {
    sx,
    sy,
    sw,
    sh,
    outputWidth: Math.max(1, Math.round(sw * 1.25)),
    outputHeight: Math.max(1, Math.round(sh * 1.25)),
  };
}

function applyPortableContrast(context: CanvasRenderingContext2D, width: number, height: number) {
  try {
    const image = context.getImageData(0, 0, width, height);
    const pixels = image.data;
    for (let index = 0; index < pixels.length; index += 4) {
      const grayscale = Math.round(
        pixels[index] * 0.299
        + pixels[index + 1] * 0.587
        + pixels[index + 2] * 0.114,
      );
      const contrasted = Math.max(0, Math.min(255, Math.round((grayscale - 128) * 1.45 + 128)));
      pixels[index] = contrasted;
      pixels[index + 1] = contrasted;
      pixels[index + 2] = contrasted;
    }
    context.putImageData(image, 0, 0);
  } catch {
    // A normal unfiltered frame was already drawn. Keep scanning if a browser
    // or constrained WebView refuses pixel reads rather than disabling camera use.
  }
}

async function installFocusedScannerCapture() {
  const { BrowserCodeReader } = await import("@zxing/browser");
  let captureAttempt = 0;

  BrowserCodeReader.drawImageOnCanvas = (context, source) => {
    const { width, height } = BrowserCodeReader.getMediaElementDimensions(source);
    const region = getRetailScannerCapturePlan(width, height, captureAttempt);
    captureAttempt = (captureAttempt + 1) % 3;
    const canvas = context.canvas;
    const outputWidth = Math.max(1, Math.round(region.sw * 1.25));
    const outputHeight = Math.max(1, Math.round(region.sh * 1.25));

    if (canvas.width !== outputWidth) canvas.width = outputWidth;
    if (canvas.height !== outputHeight) canvas.height = outputHeight;

    context.drawImage(
      source,
      region.sx,
      region.sy,
      region.sw,
      region.sh,
      0,
      0,
      outputWidth,
      outputHeight,
    );
    if (region.contrast) applyPortableContrast(context, outputWidth, outputHeight);
  };
}

export async function createScanHints(): Promise<Map<number, unknown>> {
  await installFocusedScannerCapture();
  const { BarcodeFormat, DecodeHintType } = await import("@zxing/library");
  return new Map<number, unknown>([
    [DecodeHintType.TRY_HARDER, true],
    [
      DecodeHintType.POSSIBLE_FORMATS,
      [
        BarcodeFormat.EAN_13,
        BarcodeFormat.EAN_8,
        BarcodeFormat.UPC_A,
        BarcodeFormat.UPC_E,
        BarcodeFormat.CODE_128,
        BarcodeFormat.QR_CODE,
      ],
    ],
  ]);
}

export function symbologyFromScanFormat(format: number): BarcodeSymbology {
  switch (format) {
    case FORMAT_EAN_13:
      return "EAN13";
    case FORMAT_UPC_A:
      return "UPCA";
    case FORMAT_CODE_128:
      return "CODE128";
    case FORMAT_QR_CODE:
      return "QR";
    default:
      return "OTHER";
  }
}

export function isQrScanFormat(format: number): boolean {
  return format === FORMAT_QR_CODE;
}

export function normalizeBarcodeFromScanFormat(value: string, format: number) {
  if (format === FORMAT_UPC_A) return normalizeRetailBarcode(value, "upc_a");
  if (format === FORMAT_EAN_13) return normalizeRetailBarcode(value, "ean_13");
  if (format === FORMAT_EAN_8) return normalizeRetailBarcode(value, "ean_8");
  if (format === FORMAT_UPC_E) return normalizeRetailBarcode(value, "upc_e");
  return normalizeRetailBarcode(value);
}
