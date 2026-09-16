"use client";

import { useEffect, useRef } from "react";
import { CAMERA_BARCODE_MISSING_EVENT, readRetailCaptureControl, RETAIL_CAPTURE_CONTROL_EVENT, type CameraScanDetail } from "../lib/storeCountScannerControl";
import {
  getRetailScannerFocusRegion,
  loadRetailScanner,
  publishRetailScannerStatus,
  RETAIL_FRAME_MAX_WIDTH,
  retailDecodeConfig,
  SCANNER_FRAME_INTERVAL_MS,
} from "../lib/scannerEngine";

const REARM_AFTER_MISSING_MS = 1500;
const CAMERA_SCAN_EVENT = "continuix:camera-scan";
const RETAIL_SCANNER_READY_EVENT = "continuix:retail-scanner-ready";

type ScannerWindow = Window & { __continuixRetailScannerReady?: boolean };

function emitCameraBarcode(value: string) {
  const detail: CameraScanDetail = { value };
  window.dispatchEvent(new CustomEvent(CAMERA_SCAN_EVENT, { detail }));
  return detail.accepted === true;
}

function markRetailScannerReady() {
  (window as ScannerWindow).__continuixRetailScannerReady = true;
  window.dispatchEvent(new Event(RETAIL_SCANNER_READY_EVENT));
}

export function captureFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement) {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth < 2 || video.videoHeight < 2) return null;

  const region = getRetailScannerFocusRegion(video.videoWidth, video.videoHeight);
  const scale = Math.min(1, RETAIL_FRAME_MAX_WIDTH / region.sw);
  const width = Math.max(2, Math.round(region.sw * scale));
  const height = Math.max(2, Math.round(region.sh * scale));
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;

  context.drawImage(video, region.sx, region.sy, region.sw, region.sh, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", 0.9);
}

export function RetailScannerAssist() {
  const decodingRef = useRef(false);
  const lastSeenRef = useRef<{ value: string; at: number } | null>(null);
  const armedValueRef = useRef<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let readyMarked = false;
    const canvas = document.createElement("canvas");
    function onCaptureControl() {
      if (readRetailCaptureControl(window)?.rearm) {
        armedValueRef.current = null;
        lastSeenRef.current = null;
      }
    }
    window.addEventListener(RETAIL_CAPTURE_CONTROL_EVENT, onCaptureControl);

    void (async () => {
      let quagga;
      try {
        quagga = await loadRetailScanner();
      } catch {
        publishRetailScannerStatus(window, "fallback");
        return;
      }
      if (cancelled) return;
      publishRetailScannerStatus(window, "retail");

      timer = setInterval(() => {
        if (cancelled || decodingRef.current || window.location.pathname !== "/store-count") return;
        const capture = readRetailCaptureControl(window);
        if (!capture || capture.paused) return;
        const video = document.querySelector<HTMLVideoElement>(".scanner-frame video");
        if (!video || !video.srcObject) return;

        const frame = captureFrame(video, canvas);
        if (!frame) return;
        decodingRef.current = true;

        quagga.decodeSingle(retailDecodeConfig(frame), (result) => {
          decodingRef.current = false;
          if (cancelled || readRetailCaptureControl(window)?.generation !== capture.generation) return;

          const now = Date.now();
          const value = result?.codeResult?.code?.trim() ?? "";
          if (!value) {
            if (lastSeenRef.current && now - lastSeenRef.current.at >= REARM_AFTER_MISSING_MS) {
              window.dispatchEvent(new CustomEvent(CAMERA_BARCODE_MISSING_EVENT, { detail: { value: lastSeenRef.current.value } }));
              armedValueRef.current = null;
              lastSeenRef.current = null;
            }
            return;
          }

          if (!readyMarked) {
            markRetailScannerReady();
            readyMarked = true;
          }
          lastSeenRef.current = { value, at: now };
          if (armedValueRef.current === value) return;
          if (emitCameraBarcode(value)) armedValueRef.current = value;
        });
      }, SCANNER_FRAME_INTERVAL_MS);
    })();

    return () => {
      cancelled = true;
      window.removeEventListener(RETAIL_CAPTURE_CONTROL_EVENT, onCaptureControl);
      if (timer) clearInterval(timer);
      decodingRef.current = false;
      lastSeenRef.current = null;
      armedValueRef.current = null;
      (window as ScannerWindow).__continuixRetailScannerReady = false;
    };
  }, []);

  return null;
}
