// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { captureFrame } from "./RetailScannerAssist";

describe("RetailScannerAssist capture", () => {
  it("crops to the shared retail focus region and caps decoded output at 720 pixels", () => {
    const video = document.createElement("video");
    Object.defineProperties(video, {
      readyState: { value: HTMLMediaElement.HAVE_CURRENT_DATA },
      videoWidth: { value: 1280 },
      videoHeight: { value: 720 },
    });

    const drawImage = vi.fn();
    const canvas = document.createElement("canvas");
    vi.spyOn(canvas, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    vi.spyOn(canvas, "toDataURL").mockReturnValue("data:image/jpeg;base64,focused-frame");

    expect(captureFrame(video, canvas)).toBe("data:image/jpeg;base64,focused-frame");
    expect(canvas.width).toBe(720);
    expect(canvas.height).toBe(223);
    expect(drawImage).toHaveBeenCalledWith(video, 154, 209, 973, 302, 0, 0, 720, 223);
  });
});
