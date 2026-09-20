"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { normalizeCountQuantity, type PendingCountItem } from "../lib/countQuantityFlow";

export type CountQuantityCardProps = {
  item: PendingCountItem;
  locationLabel: string;
  onConfirm: (quantity: number) => void | Promise<void>;
  onCancel: () => void;
  submitting?: boolean;
  retryQuantity?: number | null;
};

export default function CountQuantityCard({
  item,
  locationLabel,
  onConfirm,
  onCancel,
  submitting = false,
  retryQuantity = null,
}: CountQuantityCardProps) {
  const [value, setValue] = useState("1");
  const [internalSubmitting, setInternalSubmitting] = useState(false);
  const submittedRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const editableQuantity = normalizeCountQuantity(value);
  const quantityLocked = retryQuantity !== null;
  const quantity = quantityLocked ? retryQuantity : editableQuantity;
  const isSubmitting = submitting || internalSubmitting;

  useEffect(() => {
    setValue(retryQuantity === null ? "1" : String(retryQuantity));
    setInternalSubmitting(false);
    submittedRef.current = false;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [item.barcodeValue, retryQuantity]);

  function updateValue(nextValue: string) {
    if (quantityLocked) return;
    setValue(nextValue);
  }

  function adjustQuantity(delta: number) {
    if (quantityLocked) return;
    const current = quantity ?? 1;
    setValue(String(Math.min(999, Math.max(1, current + delta))));
  }

  function confirm(event?: FormEvent | KeyboardEvent<HTMLInputElement>) {
    event?.preventDefault();
    if (quantity === null || isSubmitting || submittedRef.current) return;
    submittedRef.current = true;
    setInternalSubmitting(true);
    void Promise.resolve()
      .then(() => onConfirm(quantity))
      .catch(() => {
        // A failed save is retryable, but only after the in-flight submission ends.
        submittedRef.current = false;
        setInternalSubmitting(false);
      });
  }

  const productLabel = item.known && item.productName ? item.productName : "Product not recognized";
  const details = item.known && item.packageSize ? item.packageSize : "Product details need review";

  return (
    <section aria-labelledby="count-quantity-title" className="count-quantity-card">
      <div id="count-quantity-identity" className="count-quantity-card__identity">
        <p className="count-quantity-card__eyebrow">Item found</p>
        <h2 id="count-quantity-title">{productLabel}</h2>
        <p>{details}</p>
        <p><strong>UPC:</strong> {item.barcodeValue}</p>
      </div>

      <p id="count-quantity-location" className="count-quantity-card__location"><strong>Counting at</strong><br />{locationLabel}</p>

      <form onSubmit={confirm}>
        <label htmlFor="count-quantity-input">Units to add</label>
        <div className="count-quantity-card__controls">
          <button type="button" className="secondary" aria-label="Decrease quantity" onClick={() => adjustQuantity(-1)} disabled={isSubmitting || quantityLocked || quantity === 1}>
            −
          </button>
          <input
            ref={inputRef}
            id="count-quantity-input"
            name="quantity"
            type="text"
            inputMode="numeric"
            min={1}
            max={999}
            value={value}
            readOnly={quantityLocked}
            onChange={(event) => updateValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") confirm(event);
            }}
            aria-invalid={quantity === null}
            aria-describedby="count-quantity-identity count-quantity-location count-quantity-help"
            required
          />
          <button type="button" className="secondary" aria-label="Increase quantity" onClick={() => adjustQuantity(1)} disabled={isSubmitting || quantityLocked || quantity === 999}>
            +
          </button>
        </div>
        <p id="count-quantity-help">Enter only the units you are adding now. Use Correct total below for a recount.</p>
        {quantityLocked && <p>Quantity {retryQuantity} is locked for this safe retry.</p>}
        {quantity === null && <p role="alert">Enter a whole number from 1 to 999.</p>}
        <button type="submit" disabled={isSubmitting || quantity === null}>
          {isSubmitting ? "Saving…" : quantityLocked ? "Retry Save" : "Confirm & Continue"}
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={isSubmitting || quantityLocked}>
          Wrong item / Scan again
        </button>
      </form>
    </section>
  );
}
