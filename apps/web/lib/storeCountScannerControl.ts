// The page owns capture permission. Decoders must acknowledge page acceptance
// before arming a value, and must discard results from an older capture epoch.
export const RETAIL_CAPTURE_CONTROL_EVENT = "continuix:retail-capture-control";
export const CAMERA_BARCODE_MISSING_EVENT = "continuix:camera-barcode-missing";
export type CameraScanDetail = { value: string; accepted?: boolean };
type CaptureControl = { paused: boolean; generation: number; rearm: boolean };
type CaptureTarget = EventTarget & { __continuixRetailCapture?: CaptureControl };

export function readRetailCaptureControl(target: CaptureTarget) {
  return target.__continuixRetailCapture;
}

export function setRetailCapturePaused(target: CaptureTarget, paused: boolean, rearm = false) {
  const previous = readRetailCaptureControl(target);
  if (previous?.paused === paused && !rearm) return;
  target.__continuixRetailCapture = { paused, generation: (previous?.generation ?? 0) + 1, rearm };
  target.dispatchEvent(new Event(RETAIL_CAPTURE_CONTROL_EVENT));
}
