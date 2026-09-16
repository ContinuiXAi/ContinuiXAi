export type CameraScanStamp = { value: string; at: number };

export const CAMERA_DUPLICATE_GUARD_MS = 1000;

export function shouldAcceptCameraScan(
  value: string,
  previous: CameraScanStamp | null,
  now: number,
  guardMs = CAMERA_DUPLICATE_GUARD_MS,
) {
  if (!value.trim()) return false;
  if (!previous || previous.value !== value) return true;
  return now - previous.at >= guardMs;
}

export function shouldUseZxingCamera(retailAssistReady: boolean) {
  return !retailAssistReady;
}
