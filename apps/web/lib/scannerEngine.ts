export type QuaggaResult = {
  codeResult?: { code?: string; format?: string };
};

export type QuaggaApi = {
  decodeSingle: (config: Record<string, unknown>, callback: (result: QuaggaResult | null) => void) => void;
};

declare global {
  interface Window {
    Quagga?: QuaggaApi;
  }
}

let loadPromise: Promise<QuaggaApi> | null = null;

export const SCANNER_FRAME_INTERVAL_MS = 180;
export const RETAIL_FRAME_MAX_WIDTH = 720;

export type ScannerStatus = "starting" | "ready" | "retail" | "fallback";
export type RetailScannerStatus = Extract<ScannerStatus, "retail" | "fallback">;
type RetailScannerStatusTarget = EventTarget & { __continuixRetailScannerStatus?: RetailScannerStatus };

export function publishRetailScannerStatus(target: RetailScannerStatusTarget, status: RetailScannerStatus) {
  target.__continuixRetailScannerStatus = status;
  target.dispatchEvent(new Event(`continuix:retail-scanner-${status === "retail" ? "loaded" : "failed"}`));
}

export function readRetailScannerStatus(target: RetailScannerStatusTarget) {
  return target.__continuixRetailScannerStatus;
}

export function markCameraReady(status: ScannerStatus): ScannerStatus {
  return status === "starting" ? "ready" : status;
}

export function describeScannerStatus(state: ScannerStatus, locationCode?: string) {
  const location = locationCode ? ` at ${locationCode}` : "";
  if (state === "starting") return `Starting camera${location}…`;
  if (state === "retail") return `Retail scanner ready${location} · aim the barcode inside the box`;
  if (state === "fallback") return `Backup scanner active${location} · aim the barcode inside the box`;
  return `Camera ready${location} · aim the barcode inside the box`;
}

export function getScannerGuidance(elapsedMs: number) {
  if (elapsedMs < 2_000) return "Center one barcode inside the box.";
  if (elapsedMs < 5_000) return "Hold steady and fill the box with the barcode.";
  return "Try more light or tap ‘Barcode won’t scan?’";
}

export function getRetailScannerFocusRegion(width: number, height: number) {
  const sw = Math.max(1, Math.round(width * 0.76));
  const sh = Math.max(1, Math.round(height * 0.42));
  return {
    sx: Math.max(0, Math.round((width - sw) / 2)),
    sy: Math.max(0, Math.round((height - sh) / 2)),
    sw,
    sh,
  };
}

export function mapRetailScannerFocusToDisplay(
  sourceWidth: number,
  sourceHeight: number,
  displayWidth: number,
  displayHeight: number,
) {
  const focus = getRetailScannerFocusRegion(sourceWidth, sourceHeight);
  const scale = Math.max(displayWidth / sourceWidth, displayHeight / sourceHeight);
  const offsetX = (displayWidth - sourceWidth * scale) / 2;
  const offsetY = (displayHeight - sourceHeight * scale) / 2;
  const left = Math.max(0, Math.round(offsetX + focus.sx * scale));
  const top = Math.max(0, Math.round(offsetY + focus.sy * scale));
  const right = Math.min(displayWidth, Math.round(offsetX + (focus.sx + focus.sw) * scale));
  const bottom = Math.min(displayHeight, Math.round(offsetY + (focus.sy + focus.sh) * scale));
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

export function retailDecodeConfig(src: string) {
  return {
    src,
    numOfWorkers: 0,
    locate: true,
    inputStream: {
      size: RETAIL_FRAME_MAX_WIDTH,
      singleChannel: false,
    },
    locator: {
      patchSize: "medium",
      halfSample: true,
    },
    decoder: {
      readers: ["upc_reader", "ean_reader", "ean_8_reader", "upc_e_reader", "code_128_reader"],
      multiple: false,
    },
  };
}

export function preferredScannerEngine(quaggaAvailable: boolean) {
  return quaggaAvailable ? "quagga" : "zxing";
}

export function shouldEmitRetailScan(
  value: string,
  previous: { value: string; at: number } | null,
  now: number,
  quietMs = 1200,
) {
  if (!value) return false;
  return !previous || previous.value !== value || now - previous.at >= quietMs;
}

export function loadRetailScanner(): Promise<QuaggaApi> {
  if (typeof window === "undefined") return Promise.reject(new Error("Scanner requires a browser"));
  if (window.Quagga) return Promise.resolve(window.Quagga);
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const scannerBundle = await import("@ericblade/quagga2");
    const scanner = (scannerBundle.default ?? scannerBundle) as unknown as QuaggaApi;
    if (typeof scanner.decodeSingle !== "function") throw new Error("Retail scanner loaded without its decode API");
    window.Quagga = scanner;
    return scanner;
  })();

  return loadPromise;
}
