"use client";

import { useEffect, useRef, useState } from "react";
import { countInstruction, type CountRoute } from "../lib/inventoryTruthPresentation";

export type LocationCountChecklistProps = {
  location: CountRoute["locations"][number];
  checkedProductIds: ReadonlySet<string>;
  locked: boolean;
  completionBlocked?: boolean;
  focusProductId?: string | null;
  onSelectProduct(productId: string): void;
  onMarkProductAbsent?(productId: string): void;
  onCompleteLocation(): Promise<void>;
};

export default function LocationCountChecklist({
  location,
  checkedProductIds,
  locked,
  completionBlocked = false,
  focusProductId = null,
  onSelectProduct,
  onMarkProductAbsent,
  onCompleteLocation,
}: LocationCountChecklistProps) {
  const [completing, setCompleting] = useState(false);
  const [focusedProductId, setFocusedProductId] = useState<string | null>(null);
  const firstUncheckedRef = useRef<HTMLButtonElement>(null);
  const completeButtonRef = useRef<HTMLButtonElement>(null);
  const productButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const firstUncheckedProductId = location.products.find((product) => !checkedProductIds.has(product.productId))?.productId;
  const allProductsChecked = location.products.every((product) => checkedProductIds.has(product.productId));
  const completedLocations = location.completedLocations ?? 0;
  const totalLocations = location.totalLocations ?? 1;
  const routePosition = location.routePosition ?? 1;

  useEffect(() => {
    if (locked) return;
    const nextControl = focusProductId ? productButtonRefs.current.get(focusProductId) : firstUncheckedProductId ? firstUncheckedRef.current : !completionBlocked ? completeButtonRef.current : null;
    nextControl?.focus();
  }, [location.id, firstUncheckedProductId, focusProductId, locked, completionBlocked]);

  async function completeLocation() {
    if (locked || completionBlocked || completing || !allProductsChecked || location.status === "VERIFIED") return;
    setCompleting(true);
    try {
      await onCompleteLocation();
    } finally {
      setCompleting(false);
    }
  }

  return (
    <section className="card" aria-labelledby="current-count-location" style={{ padding: 16, marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 800, opacity: 0.7 }}>CURRENT LOCATION</div>
      <h2 id="current-count-location" style={{ margin: "4px 0" }}>
        {location.code}{location.name ? ` — ${location.name}` : ""}
      </h2>
      <p style={{ margin: "0 0 4px", fontWeight: 800 }}>Location {routePosition} of {totalLocations}</p>
      <p style={{ margin: "0 0 14px", fontSize: 14 }}>{completedLocations} of {totalLocations} locations complete</p>

      <div aria-label="Location product checklist" style={{ display: "grid", gap: 10 }}>
        {location.products.map((product) => {
          const checked = checkedProductIds.has(product.productId);
          const firstUnchecked = product.productId === firstUncheckedProductId;
          return (
            <article key={product.productId} data-product-id={product.productId} style={{ border: "1px solid rgba(127,127,127,.28)", borderRadius: 12, padding: 12 }}>
              <div style={{ display: "flex", alignItems: "start", justifyContent: "space-between", gap: 10 }}>
                <div>
                  <strong style={{ fontSize: 17 }}>{product.name}</strong>
                  <div style={{ marginTop: 3, fontSize: 13 }}>{product.packageSize ?? "Package size not listed"}</div>
                  <div style={{ marginTop: 3, fontSize: 13 }}>UPC {product.barcodeValue}</div>
                </div>
                <span aria-label={checked ? "Counted" : "Not counted"} style={{ fontSize: 12, fontWeight: 800 }}>
                  {checked ? "✓ Counted" : "To count"}
                </span>
              </div>
              <div style={{ marginTop: 10, fontSize: 13 }}>
                <strong>Expected in store</strong>
                <div>{countInstruction(product)}</div>
              </div>
              <div style={{ marginTop: 10, fontSize: 12, fontWeight: 800 }}>Suggested places to check — stock is not guaranteed there</div>
              <div aria-label={`Suggested places to check for ${product.name}`} style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 5 }}>
                {product.suspectedLocations.map((suspected) => (
                  <span key={suspected.locationId} style={{ padding: "3px 8px", borderRadius: 999, background: "rgba(127,127,127,.16)", fontSize: 12 }}>
                    {suspected.code} · {suspected.verified ? "Checked" : "Not checked"}
                  </span>
                ))}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 8, marginTop: 10 }}>
                <button
                  ref={(node) => {
                    if (node) productButtonRefs.current.set(product.productId, node);
                    else productButtonRefs.current.delete(product.productId);
                    if (firstUnchecked) firstUncheckedRef.current = node;
                  }}
                  type="button"
                  className="secondary"
                  disabled={locked || completing}
                  onClick={() => onSelectProduct(product.productId)}
                  onFocus={() => setFocusedProductId(product.productId)}
                  onBlur={() => setFocusedProductId((current) => current === product.productId ? null : current)}
                  style={{
                    minHeight: 44,
                    outline: focusedProductId === product.productId ? "3px solid #2563eb" : "2px solid transparent",
                    outlineOffset: 2,
                  }}
                >
                  Count {product.name}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={locked || completing || checked}
                  onClick={() => onMarkProductAbsent?.(product.productId)}
                  style={{ minHeight: 44 }}
                >
                  None here for {product.name}
                </button>
              </div>
            </article>
          );
        })}
      </div>

      <button
        ref={completeButtonRef}
        type="button"
        disabled={locked || completionBlocked || completing || !allProductsChecked || location.status === "VERIFIED"}
        onClick={() => void completeLocation()}
        style={{ width: "100%", minHeight: 52, marginTop: 16 }}
      >
        {completing ? "Completing location…" : "Location complete"}
      </button>
    </section>
  );
}
