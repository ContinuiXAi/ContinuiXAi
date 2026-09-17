"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { BrowserCodeReader, BrowserMultiFormatReader, type IScannerControls } from "@zxing/browser";
import { apiFetch, apiJson, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";
import { useToast } from "../../lib/toast-context";
import { createScanHints, isQrScanFormat, SCAN_VIDEO_CONSTRAINTS } from "../../lib/barcodeScanner";
import { shouldAcceptCameraScan, shouldUseZxingCamera } from "../../lib/cameraScanGuard";
import { CAMERA_BARCODE_MISSING_EVENT, setRetailCapturePaused, type CameraScanDetail } from "../../lib/storeCountScannerControl";
import { describeScannerStatus, getScannerGuidance, mapRetailScannerFocusToDisplay, markCameraReady, readRetailScannerStatus, type ScannerStatus } from "../../lib/scannerEngine";
import { playBeep, unlockBeepAudio } from "../../lib/beep";
import { buildCountScanPresentation, type CountScanPresentation } from "../../lib/countScanPresentation";
import { type PendingCountItem } from "../../lib/countQuantityFlow";
import { TorchButton } from "../../components/TorchButton";
import { BrandLockup } from "../../components/BrandLockup";
import CountQuantityCard from "../../components/CountQuantityCard";
import LocationCountChecklist from "../../components/LocationCountChecklist";
import { type CountRoute } from "../../lib/inventoryTruthPresentation";
import {
  clearCountQueueForSession,
  createCountScanId,
  enqueueCountScan,
  getCountQueue,
  getFailedCountQueue,
  getPendingCountQueue,
  isDiscardableComponentParentScan,
  markCountScanFailed,
  removeFromCountQueue,
  retryFailedCountScan,
  type QueuedCountScan,
} from "../../lib/storeCountQueue";

const WEDGE_TIMEOUT_MS = 80;
const PRODUCT_LOOKUP_TIMEOUT_MS = 3_000;
const CAMERA_SCAN_EVENT = "continuix:camera-scan";
const RETAIL_SCANNER_READY_EVENT = "continuix:retail-scanner-ready";
const RETAIL_SCANNER_LOADED_EVENT = "continuix:retail-scanner-loaded";
const RETAIL_SCANNER_FAILED_EVENT = "continuix:retail-scanner-failed";

type StoreLocation = { id: string; code: string; name: string | null; isActive: boolean };
type Product = { id: string; name: string; manufacturer: string | null; packageSize: string | null } | null;
type CountEntry = {
  id: string;
  barcodeValue: string;
  locationId: string;
  quantity: number;
  product: Product;
  location: { id: string; code: string };
};
type CountSession = {
  id: string;
  siteId?: string | null;
  name: string | null;
  status: "ACTIVE" | "COMPLETED" | "CANCELLED";
  startedAt: string;
  entries: CountEntry[];
  assignedToId?: string | null;
  assignedTo?: { id: string; name: string | null } | null;
};
type SummaryRow = {
  productId: string | null;
  barcodeValue: string;
  productName: string | null;
  packageSize: string | null;
  total: number;
  byLocation: Record<string, { locationCode: string; quantity: number }>;
};
type SummaryResponse = {
  session: { id: string; name: string | null; status: string };
  distinctProducts: number;
  totalUnits: number;
  locations: string[];
  rows: SummaryRow[];
};
type PendingCountSubmission = {
  sessionId: string;
  locationId: string;
  barcodeValue: string;
  quantityDelta: number;
  clientScanId: string;
};
type ScannerWindow = Window & { __continuixRetailScannerReady?: boolean };
type CountRouteStatus = "idle" | "loading" | "loaded" | "empty" | "legacy" | "error" | "complete";

function addRouteProgress(route: CountRoute): CountRoute {
  const completedLocations = route.locations.filter((location) => location.status === "VERIFIED").length;
  const totalLocations = route.locations.length;
  return {
    ...route,
    locations: route.locations.map((location, index) => ({
      ...location,
      routePosition: index + 1,
      completedLocations,
      totalLocations,
    })),
  };
}

function isQueuedDeltaForEntry(scan: QueuedCountScan, sessionId: string, entry: CountEntry): boolean {
  return scan.sessionId === sessionId
    && scan.locationId === entry.locationId
    && scan.barcodeValue === entry.barcodeValue;
}

export default function StoreCountPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const { show } = useToast();
  const replayOwnerRef = useRef(user?.id);
  replayOwnerRef.current = user?.id;
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerFrameRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const cameraScanRef = useRef<{ value: string; at: number } | null>(null);
  const retailAssistReadyRef = useRef(false);
  const locationIdRef = useRef("");
  const sessionRef = useRef<CountSession | null>(null);
  const countRouteRef = useRef<CountRoute | null>(null);
  const contextVersionRef = useRef(0);
  const viewRef = useRef<"count" | "summary">("count");
  const pendingItemRef = useRef<PendingCountItem | null>(null);
  const identifyingRef = useRef(false);
  const identificationVersionRef = useRef(0);
  const quantitySubmittingRef = useRef(false);
  const rapidModeRef = useRef(false);
  const rapidCameraValueRef = useRef<string | null>(null);
  const pendingSubmissionRef = useRef<PendingCountSubmission | null>(null);
  const correctingEntryRef = useRef<string | null>(null);
  const transitionInFlightRef = useRef(false);
  const transitionVersionRef = useRef(0);
  const busyRef = useRef(false);
  const flushingRef = useRef(false);
  const wedgeBufferRef = useRef("");
  const wedgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [session, setSession] = useState<CountSession | null>(null);
  const [countRoute, setCountRoute] = useState<CountRoute | null>(null);
  const [countRouteStatus, setCountRouteStatus] = useState<CountRouteStatus>("idle");
  const [countRouteError, setCountRouteError] = useState<string | null>(null);
  const [reviewingVerifiedLocation, setReviewingVerifiedLocation] = useState(false);
  const [reviewPickerOpen, setReviewPickerOpen] = useState(false);
  const [focusProductId, setFocusProductId] = useState<string | null>(null);
  const [locations, setLocations] = useState<StoreLocation[]>([]);
  const [locationId, setLocationId] = useState("");
  const [view, setView] = useState<"count" | "summary">("count");
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [scannerStatus, setScannerStatus] = useState<ScannerStatus>("starting");
  const [scannerGuidanceElapsedMs, setScannerGuidanceElapsedMs] = useState(0);
  const [scannerGuideRegion, setScannerGuideRegion] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [manualValue, setManualValue] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [changingLocation, setChangingLocation] = useState(false);
  const [identifying, setIdentifying] = useState(false);
  const [transitionInFlight, setTransitionInFlight] = useState(false);
  const [pendingItem, setPendingItem] = useState<PendingCountItem | null>(null);
  const [quantitySubmitting, setQuantitySubmitting] = useState(false);
  const [rapidMode, setRapidMode] = useState(false);
  const [retryQuantity, setRetryQuantity] = useState<number | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [failedScans, setFailedScans] = useState<QueuedCountScan[]>([]);
  const [sessionQueueEntries, setSessionQueueEntries] = useState<QueuedCountScan[]>([]);
  const [flash, setFlash] = useState<{ kind: "known" | "unknown" | "queued" | "error"; text: string } | null>(null);
  const [lastConfirmedScan, setLastConfirmedScan] = useState<CountScanPresentation | null>(null);
  const [correctingEntryId, setCorrectingEntryId] = useState<string | null>(null);
  const [correctedTotal, setCorrectedTotal] = useState("");
  const [correctionSaving, setCorrectionSaving] = useState(false);
  const [correctionBlockedReason, setCorrectionBlockedReason] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const routeLocationForContext = countRoute?.locations.find((location) => location.id === locationId);
  const countingContextReady = session?.status === "ACTIVE" && (
    (countRouteStatus === "legacy" && Boolean(locationId))
    || (countRouteStatus === "loaded" && routeLocationForContext !== undefined && (routeLocationForContext.status !== "VERIFIED" || reviewingVerifiedLocation))
  );
  const activeCountingSessionId = countingContextReady ? session.id : null;

  function refreshQueueState() {
    const activeSessionId = sessionRef.current?.id;
    setPendingCount(getPendingCountQueue(user?.id).filter((entry) => !activeSessionId || entry.sessionId === activeSessionId).length);
    setFailedScans(getFailedCountQueue(user?.id).filter((entry) => !activeSessionId || entry.sessionId === activeSessionId));
    setSessionQueueEntries(activeSessionId ? getCountQueue().filter((entry) => entry.sessionId === activeSessionId) : []);
  }

  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [loading, user, router]);

  useEffect(() => {
    locationIdRef.current = locationId;
  }, [locationId]);

  async function loadManagedCountRoute(activeSession: CountSession) {
    // Never erase a live confirmation merely to refresh route metadata.
    if (pendingItemRef.current || identifyingRef.current || quantitySubmittingRef.current) return;
    const contextVersion = contextVersionRef.current;
    countRouteRef.current = null;
    setCountRoute(null);
    setCountRouteError(null);
    setCountRouteStatus("loading");
    setReviewingVerifiedLocation(false);
    setReviewPickerOpen(false);
    locationIdRef.current = "";
    setLocationId("");
    try {
      const route = addRouteProgress(await apiJson<CountRoute>(`/api/inventory-truth/counts/${activeSession.id}/route`));
      if (contextVersion !== contextVersionRef.current || sessionRef.current?.id !== activeSession.id) return;
      countRouteRef.current = route;
      setCountRoute(route);
      if (route.locations.length === 0) {
        setCountRouteStatus("empty");
        return;
      }
      const nextLocation = route.locations.find((location) => location.status !== "VERIFIED");
      if (!nextLocation) {
        setCountRouteStatus("complete");
        return;
      }
      locationIdRef.current = nextLocation.id;
      setLocationId(nextLocation.id);
      setCountRouteStatus("loaded");
    } catch (error) {
      if (contextVersion !== contextVersionRef.current || sessionRef.current?.id !== activeSession.id) return;
      setCountRouteError(error instanceof Error ? error.message : "Could not load the assigned count route.");
      setCountRouteStatus("error");
    }
  }

  useEffect(() => {
    const contextVersion = ++contextVersionRef.current;
    // This effect belongs to an identity, not to /auth/me object instances.
    // A different employee must never inherit an unconfirmed item or retry.
    if (pendingItemRef.current && !pendingSubmissionRef.current) show("Sign-in changed. The unconfirmed item was not saved; check it again before counting.", "error");
    identificationVersionRef.current++;
    transitionVersionRef.current++;
    pendingItemRef.current = null;
    pendingSubmissionRef.current = null;
    correctingEntryRef.current = null;
    identifyingRef.current = false;
    quantitySubmittingRef.current = false;
    transitionInFlightRef.current = false;
    busyRef.current = false;
    sessionRef.current = null;
    countRouteRef.current = null;
    locationIdRef.current = "";
    viewRef.current = "count";
    setPendingItem(null);
    setCorrectingEntryId(null);
    setCorrectedTotal("");
    setCorrectionSaving(false);
    setCorrectionBlockedReason(null);
    setRetryQuantity(null);
    setIdentifying(false);
    setQuantitySubmitting(false);
    setTransitionInFlight(false);
    setSession(null);
    setCountRoute(null);
    setCountRouteStatus("idle");
    setLocationId("");
    setSummary(null);
    setView("count");
    setLastConfirmedScan(null);
    setInitializing(true);
    if (!user) return;
    void (async () => {
      try {
        const requestedSessionId = new URLSearchParams(window.location.search).get("sessionId");
        const [locs, active] = await Promise.all([
          apiJson<StoreLocation[]>("/api/store-locations"),
          apiJson<CountSession | null>(requestedSessionId ? `/api/store-count/sessions/${encodeURIComponent(requestedSessionId)}` : "/api/store-count/sessions/active"),
        ]);
        if (contextVersion !== contextVersionRef.current) return;
        setLocations(locs);
        if (active) {
          sessionRef.current = active;
          setSession(active);
          if (active.status === "COMPLETED") {
            const completedSummary = await apiJson<SummaryResponse>(`/api/store-count/sessions/${encodeURIComponent(active.id)}/summary`);
            if (contextVersion !== contextVersionRef.current) return;
            setSummary(completedSummary); setView("summary"); viewRef.current = "summary";
            setCountRouteStatus("complete");
          } else if (active.siteId === null) {
            countRouteRef.current = null;
            setCountRoute(null);
            setCountRouteStatus("legacy");
            const nextLocationId = active.entries[0]?.locationId ?? locs[0]?.id ?? "";
            locationIdRef.current = nextLocationId;
            setLocationId(nextLocationId);
          } else {
            setInitializing(false);
            await loadManagedCountRoute(active);
          }
        } else {
          sessionRef.current = null;
          setSession(null);
          countRouteRef.current = null;
          setCountRoute(null);
          setCountRouteStatus("idle");
          setCountRouteError(null);
          const nextLocationId = locs[0]?.id ?? "";
          locationIdRef.current = nextLocationId;
          setLocationId(nextLocationId);
        }
      } catch (error) {
        if (contextVersion === contextVersionRef.current) show(error instanceof Error ? error.message : "Could not load Store Count.", "error");
      } finally {
        if (contextVersion === contextVersionRef.current) setInitializing(false);
      }
    })();
    return () => { contextVersionRef.current = contextVersion + 1; };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    refreshQueueState();
    void flushQueue();
    window.addEventListener("online", flushQueue);
    return () => window.removeEventListener("online", flushQueue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, user?.id]);

  useEffect(() => {
    window.addEventListener("pointerdown", unlockBeepAudio, { once: true });
    return () => window.removeEventListener("pointerdown", unlockBeepAudio);
  }, []);

  useEffect(() => {
    const paused = !activeCountingSessionId || view !== "count" || !cameraReady || Boolean(cameraError)
      || identifying || Boolean(pendingItem) || quantitySubmitting || transitionInFlight || Boolean(correctingEntryId);
    setRetailCapturePaused(window, paused, !paused && !rapidMode);
    return () => setRetailCapturePaused(window, true);
  }, [activeCountingSessionId, view, cameraReady, cameraError, identifying, pendingItem, quantitySubmitting, transitionInFlight, correctingEntryId, rapidMode]);

  useEffect(() => {
    if (
      !activeCountingSessionId
      || view !== "count"
      || pendingItem
      || cameraError
      || !cameraReady
    ) return;

    setScannerGuidanceElapsedMs(0);
    const steadyTimer = window.setTimeout(() => setScannerGuidanceElapsedMs(2_000), 2_000);
    const fallbackTimer = window.setTimeout(() => setScannerGuidanceElapsedMs(5_000), 5_000);
    return () => {
      window.clearTimeout(steadyTimer);
      window.clearTimeout(fallbackTimer);
    };
  }, [activeCountingSessionId, view, pendingItem, cameraError, cameraReady]);

  useEffect(() => {
    if (!activeCountingSessionId || view !== "count" || pendingItem || cameraError || !cameraReady) {
      setScannerGuideRegion(null);
      return;
    }
    const video = videoRef.current;
    const frame = scannerFrameRef.current;
    if (!video || !frame) return;
    const activeVideo = video;
    const activeFrame = frame;

    function updateScannerGuide() {
      const { width, height } = activeFrame.getBoundingClientRect();
      if (activeVideo.videoWidth < 2 || activeVideo.videoHeight < 2 || width < 2 || height < 2) return;
      setScannerGuideRegion(mapRetailScannerFocusToDisplay(activeVideo.videoWidth, activeVideo.videoHeight, width, height));
    }

    updateScannerGuide();
    activeVideo.addEventListener("loadedmetadata", updateScannerGuide);
    window.addEventListener("resize", updateScannerGuide);
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateScannerGuide);
    resizeObserver?.observe(activeFrame);
    return () => {
      activeVideo.removeEventListener("loadedmetadata", updateScannerGuide);
      window.removeEventListener("resize", updateScannerGuide);
      resizeObserver?.disconnect();
    };
  }, [activeCountingSessionId, view, pendingItem, cameraError, cameraReady]);

  useEffect(() => {
    if (!activeCountingSessionId || view !== "count") return;
    retailAssistReadyRef.current = Boolean((window as ScannerWindow).__continuixRetailScannerReady);
    const persistedScannerStatus = readRetailScannerStatus(window);
    if (persistedScannerStatus) setScannerStatus(persistedScannerStatus);

    function onRetailScannerReady() {
      retailAssistReadyRef.current = true;
      setScannerStatus("retail");
    }

    function onRetailScannerLoaded() { setScannerStatus("retail"); }
    function onRetailScannerFailed() { setScannerStatus("fallback"); }

    function onCameraScan(event: Event) {
      const detail = (event as CustomEvent<CameraScanDetail>).detail;
      if (detail?.value) void handleCameraBarcode(detail.value, () => { detail.accepted = true; });
    }
    function onBarcodeMissing(event: Event) {
      const value = (event as CustomEvent<{ value: string }>).detail?.value;
      if (rapidCameraValueRef.current === value) rapidCameraValueRef.current = null;
    }

    window.addEventListener(RETAIL_SCANNER_READY_EVENT, onRetailScannerReady);
    window.addEventListener(RETAIL_SCANNER_LOADED_EVENT, onRetailScannerLoaded);
    window.addEventListener(RETAIL_SCANNER_FAILED_EVENT, onRetailScannerFailed);
    window.addEventListener(CAMERA_SCAN_EVENT, onCameraScan);
    window.addEventListener(CAMERA_BARCODE_MISSING_EVENT, onBarcodeMissing);
    return () => {
      window.removeEventListener(RETAIL_SCANNER_READY_EVENT, onRetailScannerReady);
      window.removeEventListener(RETAIL_SCANNER_LOADED_EVENT, onRetailScannerLoaded);
      window.removeEventListener(RETAIL_SCANNER_FAILED_EVENT, onRetailScannerFailed);
      window.removeEventListener(CAMERA_SCAN_EVENT, onCameraScan);
      window.removeEventListener(CAMERA_BARCODE_MISSING_EVENT, onBarcodeMissing);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCountingSessionId, locationId, view]);

  useEffect(() => {
    if (!activeCountingSessionId || view !== "count") return;
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (event.key === "Enter") {
        const value = wedgeBufferRef.current.trim();
        wedgeBufferRef.current = "";
        if (wedgeTimerRef.current) clearTimeout(wedgeTimerRef.current);
        wedgeTimerRef.current = null;
        if (value.length >= 4) {
          event.preventDefault();
          void identifyBarcode(value);
        }
        return;
      }
      if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
      wedgeBufferRef.current += event.key;
      if (wedgeTimerRef.current) clearTimeout(wedgeTimerRef.current);
      wedgeTimerRef.current = setTimeout(() => {
        wedgeBufferRef.current = "";
        wedgeTimerRef.current = null;
      }, WEDGE_TIMEOUT_MS);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (wedgeTimerRef.current) clearTimeout(wedgeTimerRef.current);
      wedgeBufferRef.current = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCountingSessionId, locationId, view]);

  useEffect(() => {
    if (!activeCountingSessionId || !videoRef.current || view !== "count") return;
    let cancelled = false;
    let rapidLastSeen: { value: string; at: number } | null = null;
    setCameraReady(false);
    void (async () => {
      const hints = await createScanHints();
      if (cancelled || !videoRef.current) return;
      const reader = new BrowserMultiFormatReader(hints);
      try {
        const controls = await reader.decodeFromConstraints(
          { video: SCAN_VIDEO_CONSTRAINTS },
          videoRef.current,
          (result) => {
            if (cancelled || !shouldUseZxingCamera(retailAssistReadyRef.current)) return;
            if (identifyingRef.current || pendingItemRef.current || transitionInFlightRef.current || correctingEntryRef.current) return;
            if (!result) {
              if (rapidLastSeen && Date.now() - rapidLastSeen.at >= 1500 && rapidCameraValueRef.current === rapidLastSeen.value) {
                rapidCameraValueRef.current = null;
              }
              return;
            }
            if (isQrScanFormat(result.getBarcodeFormat())) return;
            const value = result.getText().trim();
            if (rapidModeRef.current) rapidLastSeen = { value, at: Date.now() };
            void handleCameraBarcode(value);
          },
        );
        if (cancelled) return controls.stop();
        controlsRef.current = controls;
        setCameraError(null);
        setCameraReady(true);
        setScannerStatus(markCameraReady);
        const stream = videoRef.current?.srcObject;
        if (stream instanceof MediaStream) setTorchSupported(BrowserCodeReader.mediaStreamIsTorchCompatible(stream));
      } catch (error) {
        if (!cancelled) {
          const name = error instanceof DOMException ? error.name : "";
          if (name === "NotAllowedError") setCameraError("Camera permission is blocked. Allow camera access in browser settings, or use a handheld scanner/manual UPC entry.");
          else if (name === "NotReadableError") setCameraError("The camera is busy in another app or tab. Close it there, or use a handheld scanner/manual UPC entry.");
          else setCameraError("Camera unavailable. Handheld scanner and manual UPC entry still work.");
        }
      }
    })();
    return () => {
      cancelled = true;
      controlsRef.current?.stop();
      controlsRef.current = null;
      setCameraReady(false);
      setTorchOn(false);
      setScannerStatus("starting");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCountingSessionId, view]);

  async function flushQueue() {
    if (flushingRef.current) return;
    flushingRef.current = true;
    try {
      let synced = 0;
      let newlyFailed = 0;
      if (!user || replayOwnerRef.current !== user.id) return;
      for (const queued of getPendingCountQueue(user.id)) {
        if (replayOwnerRef.current !== user.id) break;
        const correctingEntry = sessionRef.current?.entries.find((entry) => entry.id === correctingEntryRef.current);
        if (correctingEntry && isQueuedDeltaForEntry(queued, sessionRef.current!.id, correctingEntry)) continue;
        try {
          await apiJson(`/api/store-count/sessions/${queued.sessionId}/scan`, {
            method: "POST",
            body: JSON.stringify({ barcodeValue: queued.barcodeValue, locationId: queued.locationId, quantityDelta: queued.quantityDelta, clientScanId: queued.id }),
          });
          removeFromCountQueue(queued.id);
          synced++;
        } catch (error) {
          if (error instanceof ApiError && [400, 404, 409].includes(error.status)) {
            markCountScanFailed(queued.id, error.message || `Server rejected queued scan (${error.status})`);
            newlyFailed++;
            continue;
          }
          // A temporary failure for one scan must not block independent queued
          // scans behind it. Leave this entry pending and continue the pass.
          continue;
        }
      }
      refreshQueueState();
      if (synced && sessionRef.current) await refreshSession(sessionRef.current.id);
      if (synced) show(`${synced} queued scan${synced === 1 ? "" : "s"} synced.`, "success");
      if (newlyFailed) show(`${newlyFailed} scan${newlyFailed === 1 ? " needs" : "s need"} review — nothing was discarded.`, "error");
    } finally {
      flushingRef.current = false;
    }
  }

  async function retryFailedScan(id: string) {
    retryFailedCountScan(id);
    refreshQueueState();
    await flushQueue();
  }

  function discardComponentParentScan(scan: QueuedCountScan) {
    if (!isDiscardableComponentParentScan(scan) || scan.ownerUserId !== user?.id || scan.sessionId !== sessionRef.current?.id) return;
    removeFromCountQueue(scan.id);
    refreshQueueState();
    setFlash({ kind: "known", text: "Parent package discarded. Scan each component product." });
  }

  async function startSession() {
    const contextVersion = contextVersionRef.current;
    const ownerUserId = user?.id;
    if (!ownerUserId) return;
    const isCurrentStart = () => contextVersion === contextVersionRef.current && ownerUserId === replayOwnerRef.current;
    try {
      const created = await apiJson<CountSession>("/api/store-count/sessions", { method: "POST" });
      if (!isCurrentStart()) return;
      const full = await apiJson<CountSession>(`/api/store-count/sessions/${created.id}`);
      if (!isCurrentStart()) return;
      sessionRef.current = full;
      setSession(full);
      if (full.siteId === null) {
        countRouteRef.current = null;
        setCountRoute(null);
        setCountRouteStatus("legacy");
        const nextLocationId = locations[0]?.id ?? "";
        locationIdRef.current = nextLocationId;
        setLocationId(nextLocationId);
      } else {
        await loadManagedCountRoute(full);
      }
      if (!isCurrentStart()) return;
      viewRef.current = "count";
      setView("count");
    } catch (error) {
      if (isCurrentStart()) show(error instanceof Error ? error.message : "Could not start count.", "error");
    }
  }

  async function refreshSession(id: string) {
    const contextVersion = contextVersionRef.current;
    try {
      const refreshed = await apiJson<CountSession>(`/api/store-count/sessions/${id}`);
      if (contextVersion !== contextVersionRef.current || sessionRef.current?.id !== id) return;
      sessionRef.current = refreshed;
      setSession(refreshed);
    } catch { /* best-effort */ }
  }

  async function handleCameraBarcode(rawValue: string, onAccepted?: () => void) {
    const barcode = rawValue.trim();
    if (!barcode) return;
    if (pendingItemRef.current || identifyingRef.current || transitionInFlightRef.current || correctingEntryRef.current) return;
    if (!user || sessionRef.current?.status !== "ACTIVE" || viewRef.current !== "count" || !locationIdRef.current) return;
    if (rapidModeRef.current && rapidCameraValueRef.current === barcode) return;
    const now = Date.now();
    if (!shouldAcceptCameraScan(barcode, cameraScanRef.current, now)) return;
    cameraScanRef.current = { value: barcode, at: now };
    if (rapidModeRef.current) rapidCameraValueRef.current = barcode;
    onAccepted?.();
    await identifyBarcode(barcode);
  }

  async function identifyBarcode(rawValue: string, selectedProduct?: Product, absent = false) {
    const barcode = rawValue.trim();
    const activeSession = sessionRef.current;
    if (!barcode || !user || !activeSession || activeSession.status !== "ACTIVE" || viewRef.current !== "count" || !locationIdRef.current || pendingItemRef.current || identifyingRef.current || transitionInFlightRef.current || correctingEntryRef.current) return;
    const identificationVersion = ++identificationVersionRef.current;
    const rapidCapture = rapidModeRef.current && !absent;
    const identificationContext = {
      sessionId: activeSession.id,
      locationId: locationIdRef.current,
      view: viewRef.current,
    };
    identifyingRef.current = true;
    setRetailCapturePaused(window, true);
    setIdentifying(true);
    setFlash(null);
    setLastConfirmedScan(null);
    try {
      const existingProduct = activeSession.entries.find((entry) => entry.barcodeValue === barcode && entry.product)?.product ?? null;
      let product = selectedProduct ?? existingProduct;
      let detailsUnavailable = false;
      if (!product && !rapidCapture) {
        const controller = new AbortController();
        let lookupTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          product = await Promise.race([
            apiJson<NonNullable<Product>>(`/api/products/by-barcode/${encodeURIComponent(barcode)}`, { signal: controller.signal }),
            new Promise<never>((_resolve, reject) => {
              lookupTimer = setTimeout(() => {
                controller.abort();
                reject(new Error("Product lookup timed out"));
              }, PRODUCT_LOOKUP_TIMEOUT_MS);
            }),
          ]);
        } catch (error) {
          detailsUnavailable = !(error instanceof ApiError && error.status === 404);
        } finally {
          clearTimeout(lookupTimer);
        }
      }
      const currentSession = sessionRef.current;
      if (
        identificationVersion !== identificationVersionRef.current
        || !currentSession
        || currentSession.id !== identificationContext.sessionId
        || currentSession.status !== "ACTIVE"
        || locationIdRef.current !== identificationContext.locationId
        || viewRef.current !== identificationContext.view
        || viewRef.current !== "count"
      ) return;
      if (detailsUnavailable) setFlash({ kind: "queued", text: "Product details are unavailable. You can still enter the physical quantity." });
      const item: PendingCountItem = {
        barcodeValue: barcode,
        productId: product?.id ?? null,
        productName: product?.name ?? null,
        packageSize: product?.packageSize ?? null,
        known: Boolean(product),
      };
      pendingItemRef.current = item;
      pendingSubmissionRef.current = null;
      setRetryQuantity(null);
      setPendingItem(item);
      setChangingLocation(false);
      setManualOpen(false);
      setManualValue("");
      if (rapidCapture) {
        // Opt-in one-by-one capture uses the identical frozen submission and
        // authenticated/offline path. A failed capture keeps its retry card.
        await confirmPendingQuantity(1).catch(() => undefined);
      }
    } finally {
      if (identificationVersion === identificationVersionRef.current) {
        identifyingRef.current = false;
        setIdentifying(false);
      }
    }
  }

  function cancelPendingQuantity() {
    if (quantitySubmittingRef.current || pendingSubmissionRef.current) return;
    setFocusProductId(pendingItemRef.current?.productId ?? null);
    pendingItemRef.current = null;
    pendingSubmissionRef.current = null;
    setRetryQuantity(null);
    setPendingItem(null);
    setQuantitySubmitting(false);
    cameraScanRef.current = null;
  }

  async function confirmPendingQuantity(requestedQuantity: number) {
    const contextVersion = contextVersionRef.current;
    const item = pendingItemRef.current;
    const activeSession = sessionRef.current;
    if (!item || !activeSession || activeSession.status !== "ACTIVE" || quantitySubmittingRef.current || transitionInFlightRef.current) return;
    const submission = pendingSubmissionRef.current ?? {
      sessionId: activeSession.id,
      locationId: locationIdRef.current,
      barcodeValue: item.barcodeValue,
      quantityDelta: requestedQuantity,
      clientScanId: createCountScanId(),
    };
    pendingSubmissionRef.current = submission;
    setRetryQuantity(submission.quantityDelta);
    const quantity = submission.quantityDelta;
    quantitySubmittingRef.current = true;
    setQuantitySubmitting(true);
    try {
      const captured = await handleBarcode(item.barcodeValue, quantity);
      if (!captured) throw new Error("The item could not be captured. Try confirming it again.");
      if (pendingItemRef.current !== item) return;
      cameraScanRef.current = { value: item.barcodeValue, at: Date.now() };
      pendingItemRef.current = null;
      pendingSubmissionRef.current = null;
      setRetryQuantity(null);
      setPendingItem(null);
      setFocusProductId(null);
    } catch (error) {
      show(error instanceof Error ? error.message : "Could not capture this count.", "error");
      throw error;
    } finally {
      if (contextVersion === contextVersionRef.current) {
        quantitySubmittingRef.current = false;
        setQuantitySubmitting(false);
      }
    }
  }

  async function handleBarcode(rawValue: string, quantityDelta = 1) {
    const contextVersion = contextVersionRef.current;
    const barcode = rawValue.trim();
    const submission = pendingSubmissionRef.current;
    const activeSession = sessionRef.current;
    if (
      !barcode
      || !user
      || !submission
      || !activeSession
      || activeSession.status !== "ACTIVE"
      || activeSession.id !== submission.sessionId
      || barcode !== submission.barcodeValue
      || quantityDelta !== submission.quantityDelta
      || busyRef.current
    ) return;
    const activeLocationId = submission.locationId;
    const clientScanId = submission.clientScanId;
    busyRef.current = true;
    try {
      const entry = await apiJson<CountEntry>(`/api/store-count/sessions/${submission.sessionId}/scan`, {
        method: "POST",
        body: JSON.stringify({ barcodeValue: barcode, locationId: activeLocationId, quantityDelta, clientScanId }),
      });
      if (contextVersion !== contextVersionRef.current || sessionRef.current?.id !== submission.sessionId) return "saved" as const;
      playBeep();
      if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(45);
      setSession((current) => {
        const next = current ? { ...current, entries: [entry, ...current.entries.filter((existing) => existing.id !== entry.id)] } : current;
        sessionRef.current = next;
        return next;
      });
      const selectedLocation = locations.find((location) => location.id === activeLocationId);
      const presentation = buildCountScanPresentation({
        barcodeValue: entry.barcodeValue || barcode,
        quantityAdded: quantityDelta,
        currentQuantity: entry.quantity,
        productName: entry.product?.name ?? null,
        locationCode: selectedLocation?.code ?? entry.location.code,
        locationName: selectedLocation?.name ?? null,
      });
      setLastConfirmedScan(presentation);
      setFlash({ kind: entry.product ? "known" : "unknown", text: presentation.announcement });
      return "saved" as const;
    } catch (error) {
      enqueueCountScan({ ownerUserId: user.id, sessionId: submission.sessionId, locationId: activeLocationId, barcodeValue: barcode, quantityDelta }, clientScanId);
      if (contextVersion !== contextVersionRef.current) return "queued" as const;
      if (error instanceof ApiError && [400, 404, 409].includes(error.status)) {
        markCountScanFailed(clientScanId, error.message || `Server rejected scan (${error.status})`);
        refreshQueueState();
        setFlash({ kind: "error", text: `Count captured but needs review: ${barcode} × ${quantityDelta}` });
        return "review" as const;
      } else {
        refreshQueueState();
        setFlash({ kind: "queued", text: `Offline — count safely queued: ${barcode} × ${quantityDelta}` });
        return "queued" as const;
      }
    } finally {
      if (contextVersion === contextVersionRef.current) {
        busyRef.current = false;
        window.setTimeout(() => { if (contextVersion === contextVersionRef.current) setFlash(null); }, 1600);
      }
    }
  }

  async function toggleTorch() {
    const next = !torchOn;
    try {
      await controlsRef.current?.switchTorch?.(next);
      setTorchOn(next);
    } catch { show("Flash is not available on this device.", "error"); }
  }

  function beginEntryCorrection(entry: CountEntry) {
    if (transitionInFlightRef.current || pendingItemRef.current || quantitySubmittingRef.current || correctionSaving) return;
    const activeSession = sessionRef.current;
    const matchingDeltas = activeSession ? getCountQueue().filter((scan) => isQueuedDeltaForEntry(scan, activeSession.id, entry)) : [];
    if (matchingDeltas.length > 0) {
      show("Sync pending added units before correcting this total.", "error");
      return;
    }
    correctingEntryRef.current = entry.id;
    setCorrectingEntryId(entry.id);
    setCorrectedTotal(String(entry.quantity));
    setCorrectionBlockedReason(null);
  }

  function cancelEntryCorrection() {
    if (correctionSaving) return;
    correctingEntryRef.current = null;
    setCorrectingEntryId(null);
    setCorrectedTotal("");
    setCorrectionBlockedReason(null);
    void flushQueue();
  }

  async function saveCorrectedTotal(event: FormEvent, entry: CountEntry) {
    event.preventDefault();
    const activeSession = sessionRef.current;
    if (!activeSession || correctingEntryRef.current !== entry.id || correctionSaving || !/^\d+$/.test(correctedTotal)) return;
    if (getCountQueue().some((scan) => isQueuedDeltaForEntry(scan, activeSession.id, entry))) {
      setCorrectionBlockedReason("Pending added units must sync first. Cancel correction to sync them, then try again.");
      return;
    }
    const quantity = Number(correctedTotal);
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 999999) return;
    const contextVersion = contextVersionRef.current;
    setCorrectionSaving(true);
    try {
      const updated = await apiJson<CountEntry>(`/api/store-count/sessions/${activeSession.id}/entries/${entry.id}`, {
        method: "PATCH",
        body: JSON.stringify({ quantity, expectedQuantity: entry.quantity }),
      });
      if (contextVersion !== contextVersionRef.current || sessionRef.current?.id !== activeSession.id) return;
      setSession((current) => {
        const next = current ? { ...current, entries: current.entries.map((candidate) => candidate.id === updated.id ? updated : candidate) } : current;
        sessionRef.current = next;
        return next;
      });
      correctingEntryRef.current = null;
      setCorrectingEntryId(null);
      setCorrectedTotal("");
      setCorrectionBlockedReason(null);
      show("Count total corrected.", "success");
    } catch (error) {
      show(error instanceof Error ? error.message : "Could not correct this total. Try again when connected.", "error");
      if (error instanceof ApiError && error.status === 409) await refreshSession(activeSession.id);
    } finally {
      if (contextVersion === contextVersionRef.current) setCorrectionSaving(false);
    }
  }

  function beginCountTransition() {
    if (transitionInFlightRef.current || identifyingRef.current || pendingItemRef.current || quantitySubmittingRef.current || correctingEntryRef.current) return null;
    const transitionVersion = ++transitionVersionRef.current;
    transitionInFlightRef.current = true;
    setRetailCapturePaused(window, true);
    setTransitionInFlight(true);
    return transitionVersion;
  }

  function finishCountTransition(transitionVersion: number) {
    if (transitionVersion !== transitionVersionRef.current) return;
    transitionInFlightRef.current = false;
    setTransitionInFlight(false);
  }

  async function showSummary() {
    const activeSession = sessionRef.current;
    if (!activeSession || !["ACTIVE", "COMPLETED"].includes(activeSession.status) || viewRef.current !== "count") return;
    const transitionVersion = beginCountTransition();
    if (transitionVersion === null) return;
    try {
      const nextSummary = await apiJson<SummaryResponse>(`/api/store-count/sessions/${activeSession.id}/summary`);
      if (
        transitionVersion !== transitionVersionRef.current
        || sessionRef.current?.id !== activeSession.id
        || sessionRef.current.status !== activeSession.status
        || viewRef.current !== "count"
        || identifyingRef.current
        || pendingItemRef.current
        || quantitySubmittingRef.current
      ) return;
      setSummary(nextSummary);
      viewRef.current = "summary";
      setView("summary");
    } catch (error) {
      show(error instanceof Error ? error.message : "Could not load summary.", "error");
    } finally {
      finishCountTransition(transitionVersion);
    }
  }

  async function downloadCsv() {
    if (!session || exporting) return;
    setExporting(true);
    try {
      const response = await apiFetch(`/api/store-count/sessions/${session.id}/export.csv`);
      if (!response.ok) throw new Error(`Export failed (${response.status})`);
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const filenameMatch = disposition.match(/filename="?([^";]+)"?/i);
      const filename = filenameMatch?.[1] || `count-${session.id}.csv`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      show("CSV export downloaded.", "success");
    } catch (error) {
      show(error instanceof Error ? error.message : "Could not download CSV export.", "error");
    } finally {
      setExporting(false);
    }
  }

  async function finishSession() {
    const unresolvedCount = getCountQueue().filter((entry) => entry.sessionId === sessionRef.current?.id).length;
    if (!session || !["legacy", "complete"].includes(countRouteStatus) || transitionInFlightRef.current || identifyingRef.current || pendingItemRef.current || quantitySubmittingRef.current || unresolvedCount > 0) {
      if (unresolvedCount > 0) show("Resolve or sync every captured scan before finishing this count.", "error");
      return;
    }
    if (!window.confirm("Complete and lock this count? After completion, counted quantities cannot be edited.")) return;
    const transitionVersion = beginCountTransition();
    if (transitionVersion === null) return;
    let completed = false;
    try {
      await apiJson(`/api/store-count/sessions/${session.id}/complete`, { method: "POST" });
      if (transitionVersion !== transitionVersionRef.current || sessionRef.current?.id !== session.id) return;
      completed = true;
      setSession((current) => {
        const next = current ? { ...current, status: "COMPLETED" as const } : current;
        sessionRef.current = next;
        return next;
      });
      const nextSummary = await apiJson<SummaryResponse>(`/api/store-count/sessions/${session.id}/summary`);
      if (transitionVersion !== transitionVersionRef.current || sessionRef.current?.id !== session.id) return;
      setSummary(nextSummary);
      viewRef.current = "summary";
      setView("summary");
    } catch (error) {
      const fallback = completed ? "Count completed, but the summary could not load." : "Could not finish count.";
      show(error instanceof Error ? error.message : fallback, "error");
    } finally {
      finishCountTransition(transitionVersion);
    }
  }

  async function cancelSession() {
    if (!session || transitionInFlightRef.current || identifyingRef.current || pendingItemRef.current || quantitySubmittingRef.current) return;
    const unresolvedForSession = getCountQueue().filter((entry) => entry.sessionId === session.id && entry.ownerUserId === user?.id).length;
    const warning = unresolvedForSession > 0 ? `Cancel this count session? This will deliberately discard ${unresolvedForSession} locally captured unresolved scan${unresolvedForSession === 1 ? "" : "s"}.` : "Cancel this count session?";
    if (!window.confirm(warning)) return;
    const transitionVersion = beginCountTransition();
    if (transitionVersion === null) return;
    try {
      await apiJson(`/api/store-count/sessions/${session.id}/cancel`, { method: "POST" });
      if (transitionVersion !== transitionVersionRef.current || sessionRef.current?.id !== session.id) return;
      clearCountQueueForSession(session.id, user?.id);
      refreshQueueState();
      sessionRef.current = null;
      setSession(null);
      countRouteRef.current = null;
      setCountRoute(null);
      setSummary(null);
      setLastConfirmedScan(null);
      viewRef.current = "count";
      setView("count");
    } catch (error) {
      show(error instanceof Error ? error.message : "Could not cancel count.", "error");
    } finally {
      finishCountTransition(transitionVersion);
    }
  }

  async function handleManualSubmit(event: FormEvent) {
    event.preventDefault();
    const value = manualValue.trim();
    if (!value) {
      show("Enter a UPC.", "error");
      return;
    }
    await identifyBarcode(value);
  }

  async function selectRouteProduct(productId: string, absent = false) {
    const product = countRouteRef.current?.locations
      .find((location) => location.id === locationIdRef.current)
      ?.products.find((candidate) => candidate.productId === productId);
    if (!product || pendingItemRef.current || identifyingRef.current || transitionInFlightRef.current) return;
    setFocusProductId(null);
    const selectedProduct: NonNullable<Product> = {
      id: product.productId,
      name: product.name,
      manufacturer: null,
      packageSize: product.packageSize,
    };
    await identifyBarcode(product.barcodeValue, selectedProduct, absent);
    // Identification owns this mutable ref across the await.
    const identifiedItem = pendingItemRef.current as PendingCountItem | null;
    if (absent && identifiedItem?.productId === productId) await confirmPendingQuantity(0).catch(() => undefined);
  }

  async function completeCurrentLocation() {
    const activeSession = sessionRef.current;
    const route = countRouteRef.current;
    const activeLocationId = locationIdRef.current;
    const activeLocation = route?.locations.find((location) => location.id === activeLocationId);
    if (!activeSession || activeSession.status !== "ACTIVE" || !route || !activeLocation || activeLocation.status === "VERIFIED") return;
    const unresolvedForSession = getCountQueue().some((entry) => entry.sessionId === activeSession.id);
    const checkedProductIds = new Set(activeSession.entries
      .filter((entry) => entry.locationId === activeLocationId && entry.product?.id)
      .map((entry) => entry.product!.id));
    if (unresolvedForSession || activeLocation.products.some((product) => !checkedProductIds.has(product.productId))) return;
    const transitionVersion = beginCountTransition();
    if (transitionVersion === null) return;
    try {
      await apiJson(`/api/inventory-truth/counts/${activeSession.id}/locations/${activeLocationId}/verify`, {
        method: "POST",
        body: JSON.stringify({ offlineQueueFlushed: true }),
      });
      if (transitionVersion !== transitionVersionRef.current || sessionRef.current?.id !== activeSession.id || locationIdRef.current !== activeLocationId) return;
      const verifiedRoute = addRouteProgress({
        ...route,
        locations: route.locations.map((location) => ({
          ...location,
          status: location.id === activeLocationId ? "VERIFIED" : location.status,
          products: location.products.map((product) => ({
            ...product,
            suspectedLocations: product.suspectedLocations.map((suspected) => suspected.locationId === activeLocationId
              ? { ...suspected, verified: true }
              : suspected),
          })),
        })),
      });
      countRouteRef.current = verifiedRoute;
      setCountRoute(verifiedRoute);
      const currentIndex = verifiedRoute.locations.findIndex((location) => location.id === activeLocationId);
      const nextLocation = verifiedRoute.locations.slice(currentIndex + 1).find((location) => location.status !== "VERIFIED");
      if (nextLocation) {
        locationIdRef.current = nextLocation.id;
        setLocationId(nextLocation.id);
      } else {
        locationIdRef.current = "";
        setLocationId("");
        setCountRouteStatus("complete");
      }
    } catch (error) {
      show(error instanceof Error ? error.message : "Could not complete this location.", "error");
    } finally {
      finishCountTransition(transitionVersion);
    }
  }

  if (loading || !user || initializing) return null;
  const currentLocation = locations.find((location) => location.id === locationId);
  const currentRouteLocation = countRoute?.locations.find((location) => location.id === locationId);
  const displayedLocation = currentRouteLocation ?? currentLocation;
  const currentLocationLabel = displayedLocation
    ? `${displayedLocation.code}${displayedLocation.name ? ` — ${displayedLocation.name}` : ""}`
    : "No location selected";
  const entriesHere = session?.entries.filter((entry) => entry.locationId === locationId) ?? [];
  const unitsHere = entriesHere.reduce((sum, entry) => sum + entry.quantity, 0);
  const transitionLocked = transitionInFlight || identifying || Boolean(pendingItem) || quantitySubmitting || Boolean(correctingEntryId);
  const checkedProductIds = new Set(entriesHere.flatMap((entry) => entry.product?.id ? [entry.product.id] : []));
  for (const queued of sessionQueueEntries.filter((entry) => entry.locationId === locationId)) {
    const product = currentRouteLocation?.products.find((product) => product.barcodeValue === queued.barcodeValue);
    if (product) checkedProductIds.add(product.productId);
  }
  const selectedRouteProduct = currentRouteLocation?.products.find((product) => product.productId === pendingItem?.productId || product.barcodeValue === pendingItem?.barcodeValue);

  return (
    <main className="container" style={{ maxWidth: 680, paddingBottom: 48 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "end", marginBottom: 14, gap: 12 }}>
        <div><BrandLockup compact /><h1 style={{ margin: "8px 0 0" }}>Count</h1></div>
        {session && <button type="button" className="secondary" disabled={transitionLocked} onClick={() => {
          if (transitionLocked) return;
          if (view === "count") void showSummary();
          else {
            viewRef.current = "count";
            setView("count");
          }
        }}>{view === "count" ? "Summary" : "Count"}</button>}
      </header>

      <a href="/store-count/review" style={{ display: "inline-block", minHeight: 44 }}>Find count reviews</a>

      {session?.siteId && (countRouteStatus === "complete" || session.status === "COMPLETED") && <button type="button" className="secondary" style={{ minHeight: 44, marginBottom: 12 }} disabled={transitionLocked || getCountQueue().some((scan) => scan.sessionId === session.id)} onClick={() => {
        if (transitionLocked || getCountQueue().some((scan) => scan.sessionId === session.id)) return;
        router.push(`/store-count/review?sessionId=${encodeURIComponent(session.id)}`);
      }}>Review differences</button>}

      {!session && <section className="card" style={{ padding: 24, textAlign: "center" }}><h2 style={{ marginTop: 0 }}>Ready to count?</h2><p style={{ opacity: 0.75 }}>Start a session, pick a location, then scan continuously.</p><button type="button" onClick={() => void startSession()} style={{ minHeight: 52, width: "100%" }}>Start Count</button></section>}

      {session && view === "count" && <>
        {(session.name || session.assignedTo) && <div className="card" style={{ padding: 10, marginBottom: 12, fontSize: 13 }}>
          {session.name && <strong>{session.name}</strong>}
          {session.assignedTo && <span>{session.name ? " · " : ""}Assigned to {session.assignedTo.name ?? "current employee"}</span>}
        </div>}
        {countRouteStatus === "legacy" && <section className="card" style={{ position: "sticky", top: 8, zIndex: 30, padding: 12, marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 800, opacity: 0.7 }}>Counting at</div>
              <div style={{ fontSize: 19, fontWeight: 900 }}>{currentLocation?.code ?? "Choose a location"}</div>
              {currentLocation?.name && <div style={{ fontSize: 14, marginTop: 2 }}>{currentLocation.name}</div>}
            </div>
            <button
              type="button"
              className="secondary"
              disabled={transitionLocked}
              onClick={() => {
                if (transitionInFlightRef.current || identifyingRef.current || pendingItemRef.current || quantitySubmittingRef.current) return;
                setChangingLocation((open) => !open);
              }}
              style={{ flex: "none", margin: 0 }}
            >
              Change
            </button>
          </div>
          <div style={{ marginTop: 6, fontSize: 13, opacity: 0.72 }}>{entriesHere.length} products · {unitsHere} units counted here</div>
          {changingLocation && <select
            aria-label="Count location"
            value={locationId}
            disabled={transitionLocked}
            onChange={(event) => {
              if (transitionInFlightRef.current || identifyingRef.current || pendingItemRef.current || quantitySubmittingRef.current) return;
              const nextLocationId = event.target.value;
              locationIdRef.current = nextLocationId;
              setLocationId(nextLocationId);
              setChangingLocation(false);
              event.currentTarget.blur();
            }}
            style={{ width: "100%", fontSize: 18, fontWeight: 800, minHeight: 50, marginTop: 10 }}
          >
            {locations.length === 0 && <option value="">No active locations configured</option>}
            {locations.map((location) => <option key={location.id} value={location.id}>{location.code}{location.name ? ` — ${location.name}` : ""}</option>)}
          </select>}
        </section>}

        {session.status === "ACTIVE" && <>
          {countRouteStatus === "loading" && <p role="status">Loading assigned count route… Counting will be available when the location is ready.</p>}
          {countRouteStatus === "error" && <section role="alert"><p>{countRouteError}</p><p>Your count is saved. Retry the route before continuing.</p><button type="button" onClick={() => void loadManagedCountRoute(session)}>Retry route</button></section>}
          {countRouteStatus === "empty" && <p>No count locations are assigned. Ask your supervisor to assign locations before counting.</p>}
          {countRouteStatus === "complete" && <section className="card" style={{ padding: 16 }}><h2>All assigned locations are checked</h2><p>Review your results, then finish and lock this count.</p><button className="secondary" type="button" onClick={() => setReviewPickerOpen(!reviewPickerOpen)}>Review locations</button>{reviewPickerOpen && countRoute?.locations.map((location) => <button key={location.id} type="button" className="secondary" onClick={() => {
            locationIdRef.current = location.id;
            setLocationId(location.id);
            setReviewingVerifiedLocation(true);
            setReviewPickerOpen(false);
            setCountRouteStatus("loaded");
          }}>Review {location.code}</button>)}</section>}
          {countingContextReady && <>
          {currentRouteLocation && <section aria-label="Current count context" className="card" style={{ position: "sticky", top: 0, zIndex: 30, padding: 12, background: "var(--background, #fff)", color: "var(--foreground, #111)" }}>
            <strong>Counting at {currentLocationLabel}</strong>
            {pendingItem && <><div>{pendingItem.productName ?? pendingItem.barcodeValue} · {pendingItem.packageSize} · UPC {pendingItem.barcodeValue}</div><div>Expected in store: {selectedRouteProduct?.expectedStoreQty ?? "Not available"}</div><div>Suggested places to check — stock is not guaranteed there</div><div>{selectedRouteProduct?.suspectedLocations.map((location) => <span key={location.locationId} style={{ marginRight: 8 }}>{location.code} · {location.verified ? "Checked" : "Not checked"}</span>) ?? "No suggested locations available"}</div></>}
          </section>}
          <label style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 44, marginBottom: 10 }}>
            <input
              type="checkbox"
              aria-label="Rapid one-by-one mode"
              aria-describedby="count-scan-mode-help"
              checked={rapidMode}
              disabled={transitionLocked}
              onChange={(event) => {
                if (transitionInFlightRef.current || identifyingRef.current || pendingItemRef.current || quantitySubmittingRef.current) return;
                setRetailCapturePaused(window, true);
                rapidModeRef.current = event.target.checked;
                rapidCameraValueRef.current = null;
                setRapidMode(event.target.checked);
              }}
            />
            <span>Rapid one-by-one <small>(optional — adds 1 per scan)</small></span>
          </label>
          <p id="count-scan-mode-help" style={{ marginTop: 0, fontSize: 13 }}>
            {rapidMode ? "Each scan adds 1. Move the barcode away before scanning it again." : "Scan once, then enter only the units you are adding now."}
          </p>
          {pendingItem && <div className="card" style={{ padding: 16 }}><CountQuantityCard
              item={pendingItem}
              locationLabel={currentLocationLabel}
              onConfirm={confirmPendingQuantity}
              onCancel={cancelPendingQuantity}
              submitting={quantitySubmitting}
              retryQuantity={retryQuantity}
            /></div>}
          <div
            ref={scannerFrameRef}
            className="scanner-frame"
            aria-hidden={Boolean(pendingItem)}
            aria-busy={identifying}
            style={{ display: pendingItem ? "none" : undefined, minHeight: 260, borderRadius: 18, overflow: "hidden", position: "relative" }}
          >
            {cameraError ? <div style={{ minHeight: 260, display: "grid", placeItems: "center", padding: 24, textAlign: "center" }}>{cameraError}</div> : <video ref={videoRef} muted playsInline style={{ width: "100%", minHeight: 260, objectFit: "cover" }} />}
            {!cameraError && <div className="scanner-overlay">{scannerGuideRegion && <div className="scan-box store-count-scan-box" style={scannerGuideRegion}><span className="corner tl" /><span className="corner tr" /><span className="corner bl" /><span className="corner br" /><span className="scan-line" /></div>}</div>}
            {torchSupported && <TorchButton active={torchOn} onClick={() => void toggleTorch()} label={torchOn ? "Turn flash off" : "Turn flash on"} />}
          </div>
          {!pendingItem && <>
            <div aria-live="polite" style={{ textAlign: "center", margin: "10px 0 12px", minHeight: 42, fontWeight: flash || identifying ? 800 : 500 }}>{identifying ? "Looking up item…" : flash ? flash.text : cameraError ? "Tap ‘Barcode won’t scan?’ to enter the UPC." : currentLocation ? !cameraReady ? describeScannerStatus("starting", currentLocation.code) : getScannerGuidance(scannerGuidanceElapsedMs) : "Configure and select a location first"}</div>
            <button
              type="button"
              className="secondary"
              disabled={transitionInFlight || identifying}
              onClick={() => setManualOpen((open) => !open)}
              style={{ width: "100%", marginTop: 0 }}
            >
              Barcode won’t scan?
            </button>
            {manualOpen && <form onSubmit={handleManualSubmit} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 8, marginTop: 8 }}>
              <input inputMode="numeric" value={manualValue} onChange={(event) => setManualValue(event.target.value)} placeholder="Enter UPC" aria-label="Manual UPC" style={{ minWidth: 0, minHeight: 48 }} />
              <button type="submit" disabled={transitionInFlight || identifying || !manualValue.trim() || !locationId}>Find item</button>
            </form>}
          </>}
          {!pendingItem && lastConfirmedScan && <section className="card" style={{ margin: "10px 0", padding: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 800, opacity: 0.66, letterSpacing: ".06em" }}>{lastConfirmedScan.known ? "LAST ITEM COUNTED" : "UNKNOWN UPC COUNTED"}</div>
            <div style={{ fontSize: 19, fontWeight: 900, marginTop: 3 }}>{lastConfirmedScan.title}</div>
            <div style={{ marginTop: 6, fontSize: 13 }}><strong>UPC:</strong> {lastConfirmedScan.upc}</div>
            <div style={{ marginTop: 3, fontSize: 13 }}><strong>Location:</strong> {lastConfirmedScan.location}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10 }}>
              <div><div style={{ fontSize: 11, opacity: 0.65 }}>ADDED</div><strong style={{ fontSize: 20 }}>+{lastConfirmedScan.added}</strong></div>
              <div><div style={{ fontSize: 11, opacity: 0.65 }}>TOTAL HERE</div><strong style={{ fontSize: 20 }}>{lastConfirmedScan.current}</strong></div>
            </div>
          </section>}
          {pendingItem && <div aria-live="polite" style={{ textAlign: "center", margin: "10px 0 12px", minHeight: 24, fontWeight: flash ? 800 : 500 }}>{flash?.text ?? "Enter units to add, then confirm."}</div>}
          {currentRouteLocation && <LocationCountChecklist
            location={currentRouteLocation}
            checkedProductIds={checkedProductIds}
            locked={transitionLocked}
            completionBlocked={sessionQueueEntries.length > 0}
            focusProductId={focusProductId}
            onSelectProduct={(id) => void selectRouteProduct(id)}
            onMarkProductAbsent={(id) => void selectRouteProduct(id, true)}
            onCompleteLocation={completeCurrentLocation}
          />}
          {reviewingVerifiedLocation && <><p>Review adds newly found units to the saved count. Do not count the same units twice.</p><button type="button" className="secondary" disabled={transitionLocked} onClick={() => { locationIdRef.current = ""; setLocationId(""); setReviewingVerifiedLocation(false); setCountRouteStatus("complete"); }}>Done reviewing</button></>}
          </>}
          {sessionQueueEntries.some((entry) => entry.ownerUserId !== user.id) && <p role="alert">Unsynced work for this count belongs to another sign-in. Have that employee sync it, or ask a supervisor to reconcile it before completing this location.</p>}
          {pendingCount > 0 && <div className="card" style={{ marginTop: 10, padding: 12, textAlign: "center", fontWeight: 800 }}>{pendingCount} scan{pendingCount === 1 ? "" : "s"} safely queued — waiting to sync</div>}
          {failedScans.length > 0 && <section className="card" style={{ marginTop: 10, padding: 12, border: "2px solid rgba(220, 80, 80, .55)" }}><strong>{failedScans.length} captured scan{failedScans.length === 1 ? " needs" : "s need"} review</strong><p style={{ margin: "5px 0 10px", fontSize: 13 }}>These scans were not discarded. Resolve them before finishing the count.</p><div style={{ display: "grid", gap: 8 }}>{failedScans.map((scan) => { const discardableParent = isDiscardableComponentParentScan(scan); return <div key={scan.id} style={{ paddingTop: 8, borderTop: "1px solid rgba(127,127,127,.25)" }}><div><strong>{scan.barcodeValue}</strong> · {locations.find((location) => location.id === scan.locationId)?.code ?? "unknown location"}</div><div style={{ fontSize: 12, opacity: 0.75, margin: "3px 0 6px" }}>{scan.failureReason ?? "Server rejected this queued scan."}</div>{discardableParent && <p style={{ fontSize: 13 }}><strong>Count each component product instead.</strong> Discard only this invalid parent capture, then scan the individual items.</p>}<div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}><button type="button" className="secondary" onClick={() => void retryFailedScan(scan.id)} style={{ minHeight: 40 }}>Retry</button>{discardableParent && <button type="button" onClick={() => discardComponentParentScan(scan)} style={{ minHeight: 40 }}>Discard parent & scan components</button>}</div></div>; })}</div></section>}
          {entriesHere.length > 0 && <section style={{ marginTop: 18 }}><h2 style={{ fontSize: 14 }}>Counted here</h2><div style={{ display: "grid", gap: 6 }}>{entriesHere.slice(0, 20).map((entry) => {
            const matchingDeltas = session ? sessionQueueEntries.filter((scan) => isQueuedDeltaForEntry(scan, session.id, entry)) : [];
            const pendingAddedUnits = matchingDeltas.reduce((sum, scan) => sum + scan.quantityDelta, 0);
            return <article key={entry.id} className="card" style={{ padding: 10 }}>{correctingEntryId === entry.id ? <form onSubmit={(event) => void saveCorrectedTotal(event, entry)} style={{ display: "grid", gap: 8 }}><strong>{entry.product?.name ?? entry.barcodeValue}</strong><label>Correct total<input aria-label={`Correct total for ${entry.product?.name ?? entry.barcodeValue}`} inputMode="numeric" value={correctedTotal} onChange={(event) => setCorrectedTotal(event.target.value)} disabled={correctionSaving} /></label><p style={{ margin: 0, fontSize: 13 }}>Set the full total at this location. This replaces {entry.quantity}; it does not add units. Corrections need a connection.</p>{correctionBlockedReason && <p role="alert" style={{ margin: 0 }}>{correctionBlockedReason}</p>}<div style={{ display: "flex", gap: 8 }}><button type="submit" disabled={correctionSaving || !/^\d+$/.test(correctedTotal) || Number(correctedTotal) > 999999}>{correctionSaving ? "Saving…" : "Set total"}</button><button type="button" className="secondary" onClick={cancelEntryCorrection} disabled={correctionSaving}>Cancel correction</button></div></form> : <div><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}><span>{entry.product?.name ?? entry.barcodeValue}</span><div style={{ display: "flex", alignItems: "center", gap: 10 }}><strong>{entry.quantity}</strong><button type="button" className="secondary" disabled={matchingDeltas.length > 0} onClick={() => beginEntryCorrection(entry)}>Correct total</button></div></div>{matchingDeltas.length > 0 && <p style={{ margin: "6px 0 0", fontSize: 13 }}>Sync the {pendingAddedUnits} pending added unit{pendingAddedUnits === 1 ? "" : "s"} before correcting this total.</p>}</div>}</article>;
          })}</div></section>}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 20 }}><button type="button" onClick={() => void finishSession()} disabled={sessionQueueEntries.length > 0 || transitionLocked || !["legacy", "complete"].includes(countRouteStatus)} style={{ minHeight: 50 }}>Finish</button><button type="button" className="secondary" onClick={() => void cancelSession()} disabled={transitionLocked} style={{ minHeight: 50 }}>Cancel</button></div>
        </>}
      </>}

      {session && view === "summary" && summary && <section>
        <h2>{session.name || "Count summary"}</h2>
        {session.status === "COMPLETED" && <p>Finished and locked. Original count evidence is retained.</p>}
        <div className="card" style={{ padding: 14, marginBottom: 12 }}><strong>{summary.distinctProducts} products · {summary.totalUnits} units</strong><div style={{ fontSize: 13, opacity: 0.7 }}>{summary.locations.length} locations</div></div>
        <button type="button" className="secondary" onClick={() => void downloadCsv()} disabled={exporting} style={{ width: "100%", minHeight: 46, marginBottom: 12 }}>{exporting ? "Preparing CSV…" : "Download CSV"}</button>
        <div style={{ display: "grid", gap: 8 }}>{summary.rows.map((row) => <div key={row.productId ?? row.barcodeValue} className="card" style={{ padding: 12 }}><div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}><strong>{row.productName ?? row.barcodeValue}</strong><strong>{row.total}</strong></div><div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>{Object.values(row.byLocation).map((location) => <span key={location.locationCode} style={{ fontSize: 12, padding: "2px 8px", borderRadius: 999, background: "rgba(127,127,127,.16)" }}>{location.locationCode}: {location.quantity}</span>)}</div></div>)}</div>
      </section>}
    </main>
  );
}
