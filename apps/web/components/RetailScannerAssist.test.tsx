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

    expect(captureFrame(video, canvas, 0)).toBe("data:image/jpeg;base64,focused-frame");
    expect(canvas.width).toBe(720);
    expect(canvas.height).toBe(223);
    expect(drawImage).toHaveBeenCalledWith(video, 154, 209, 973, 302, 0, 0, 720, 223);
  });

  it("uses a tighter pass followed by a contrast pass without scanning outside the guide", () => {
    const video = document.createElement("video");
    Object.defineProperties(video, {
      readyState: { value: HTMLMediaElement.HAVE_CURRENT_DATA },
      videoWidth: { value: 1280 },
      videoHeight: { value: 720 },
    });
    const filters: string[] = [];
    const context = { drawImage: vi.fn(function (this: { filter: string }) { filters.push(this.filter); }), filter: "none" };
    const canvas = document.createElement("canvas");
    vi.spyOn(canvas, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
    vi.spyOn(canvas, "toDataURL").mockReturnValue("data:image/jpeg;base64,variant");

    captureFrame(video, canvas, 1);
    expect(context.drawImage).toHaveBeenLastCalledWith(video, 243, 238, 794, 245, 0, 0, 720, 222);

    captureFrame(video, canvas, 2);
    expect(context.drawImage).toHaveBeenLastCalledWith(video, 154, 209, 973, 302, 0, 0, 720, 223);
    expect(context.filter).toBe("none");
    expect(filters).toEqual(["none", "grayscale(1) contrast(1.45)"]);
  });
});
