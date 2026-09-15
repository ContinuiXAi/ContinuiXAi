import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "app/store-count/page.tsx"), "utf8");

describe("Store Count guided camera reliability", () => {
  it("identifies a detected barcode without posting inventory before quantity confirmation", () => {
    const cameraStart = source.indexOf("async function handleCameraBarcode");
    const identifyStart = source.indexOf("async function identifyBarcode", cameraStart);
    const confirmStart = source.indexOf("async function confirmPendingQuantity", identifyStart);
    const persistStart = source.indexOf("async function handleBarcode", confirmStart);
    const cameraHandler = source.slice(cameraStart, identifyStart);
    const identifyHandler = source.slice(identifyStart, confirmStart);
    const confirmHandler = source.slice(confirmStart, persistStart);

    expect(source).toContain("const [pendingItem, setPendingItem] = useState<PendingCountItem | null>(null)");
    expect(cameraHandler).toContain("await identifyBarcode(barcode)");
    expect(cameraHandler).not.toContain("handleBarcode(");
    expect(identifyHandler).toContain("setPendingItem(item)");
    expect(confirmHandler).toContain("await handleBarcode(item.barcodeValue, quantity)");
  });

  it("keeps quantity confirmation on the existing location-scoped idempotent write path", () => {
    const confirmStart = source.indexOf("async function confirmPendingQuantity");
    const start = source.indexOf("async function handleBarcode");
    const end = source.indexOf("async function toggleTorch", start);
    const confirmHandler = source.slice(confirmStart, start);
    const handler = source.slice(start, end);

    expect(confirmHandler).toContain("pendingSubmissionRef.current = submission");
    expect(confirmHandler).toContain("await handleBarcode(item.barcodeValue, quantity)");
    expect(handler).toContain("const submission = pendingSubmissionRef.current");
    expect(handler).toContain("const activeLocationId = submission.locationId");
    expect(handler).toContain("const clientScanId = submission.clientScanId");
    expect(handler).toContain("locationId: activeLocationId, quantityDelta, clientScanId");
    expect(source.match(/\/api\/store-count\/sessions\/\$\{submission\.sessionId\}\/scan/g)).toHaveLength(1);
  });

  it("routes manual UPC entry through the same quantity card instead of a second quantity workflow", () => {
    const manualStart = source.indexOf("async function handleManualSubmit");
    const renderStart = source.indexOf("if (loading", manualStart);
    const manualHandler = source.slice(manualStart, renderStart);

    expect(manualHandler).toContain("await identifyBarcode(value)");
    expect(manualHandler).not.toContain("handleBarcode(");
    expect(source).toContain("Barcode won’t scan?");
    expect(source).toContain("<CountQuantityCard");
    expect(source).not.toContain("manualQuantity");
  });

  it("keeps the current location visible and locked throughout confirmation", () => {
    expect(source).toContain('position: "sticky"');
    expect(source).toContain("Counting at");
    expect(source).toContain("products · {unitsHere} units counted here");
    expect(source).toContain("const transitionLocked = transitionInFlight || identifying || Boolean(pendingItem) || quantitySubmitting");
    expect(source).toContain("disabled={transitionLocked}");
    expect(source).toContain("locationLabel={currentLocationLabel}");
  });

  it("pauses capture for confirmation and rearms cancellation immediately", () => {
    const cameraStart = source.indexOf("async function handleCameraBarcode");
    const identifyStart = source.indexOf("async function identifyBarcode", cameraStart);
    const cameraHandler = source.slice(cameraStart, identifyStart);
    const cancelStart = source.indexOf("function cancelPendingQuantity");
    const confirmStart = source.indexOf("async function confirmPendingQuantity", cancelStart);
    const cancelHandler = source.slice(cancelStart, confirmStart);

    expect(cameraHandler).toContain("if (pendingItemRef.current || identifyingRef.current || transitionInFlightRef.current) return");
    expect(cancelHandler).toContain("cameraScanRef.current = null");
    expect(cancelHandler).toContain("setPendingItem(null)");
  });

  it("keeps the active camera element mounted while confirmation hides its capture view", () => {
    expect(source).toContain("aria-hidden={Boolean(pendingItem)}");
    expect(source).toContain('display: pendingItem ? "none" : undefined');
    expect(source).not.toContain("{pendingItem ? <CountQuantityCard");
  });

  it("restarts same-item duplicate protection only after successful confirmation", () => {
    const confirmStart = source.indexOf("async function confirmPendingQuantity");
    const persistStart = source.indexOf("async function handleBarcode", confirmStart);
    const confirmHandler = source.slice(confirmStart, persistStart);
    const persisted = confirmHandler.indexOf("await handleBarcode(item.barcodeValue, quantity)");
    const rearmed = confirmHandler.indexOf("cameraScanRef.current = { value: item.barcodeValue, at: Date.now() }");

    expect(persisted).toBeGreaterThanOrEqual(0);
    expect(rearmed).toBeGreaterThan(persisted);
  });

  it("uses the normal beep only after the server confirms persistence", () => {
    const start = source.indexOf("async function handleBarcode");
    const end = source.indexOf("async function toggleTorch", start);
    const handler = source.slice(start, end);
    const request = handler.indexOf("const entry = await apiJson<CountEntry>");
    const beep = handler.indexOf("playBeep()", request);

    expect(request).toBeGreaterThanOrEqual(0);
    expect(beep).toBeGreaterThan(request);
  });
});
