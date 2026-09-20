"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiJson } from "../../../lib/api";
import { useAuth } from "../../../lib/auth-context";
import { getCountQueue } from "../../../lib/storeCountQueue";
import { shortageInstruction, overageInstruction } from "../../../lib/inventoryTruthPresentation";

const reasons = [
  ["COULD_NOT_FIND", "Could not find"], ["WRONG_SHELF_OR_LOCATION", "Wrong shelf/location"],
  ["RECEIVING_PROBLEM", "Receiving problem"], ["STOCKING_PROBLEM", "Stocking problem"],
  ["SALE_NOT_RECORDED", "Sale not recorded"], ["DAMAGE_OR_EXPIRATION", "Damage or expiration"],
  ["EMPTY_PACKAGE_POSSIBLE_THEFT", "Empty package/possible theft"], ["PRODUCT_OR_PACKAGE_CHANGED", "Product or package changed"],
  ["OTHER_MANAGER_REVIEW", "Other/manager review"],
];
type Discrepancy = {
  id: string; productId: string; product: { name: string; barcodeValue: string | null; packageSize: string | null };
  expectedStoreQty: number; actualStoreQty: number; difference: number; reason: string | null; note: string | null;
  status: "OPEN" | "RESOLVED" | "APPROVED" | "REJECTED"; reviewToken: string;
  explainedBy?: { name: string | null } | null; explainedAt?: string | null;
  reviewedBy?: { name: string | null } | null; reviewedAt?: string | null;
  countedLocations: Array<{ locationId: string; code: string; name: string | null; quantity: number }>;
};
type Review = { sessionId: string; sessionStatus: string; finalized: boolean; canExplain: boolean; canApprove: boolean; discrepancies: Discrepancy[] };
const controlStyle = { minHeight: 44, width: "100%" };

type Draft = { reason: string; note: string };
function DifferenceCard({ row, review, busy, blocked, onWrite, draft, onDraft }: {
  row: Discrepancy; review: Review; busy: string | null; blocked: boolean;
  draft?: Draft; onDraft: (draft: Draft) => void;
  onWrite: (row: Discrepancy, action: "explain" | "approve", body: object) => Promise<void>;
}) {
  const { reason, note } = draft ?? { reason: row.reason ?? "", note: row.note ?? "" };
  const editable = row.status === "OPEN" && review.finalized;
  const locked = Boolean(busy) || blocked;
  const dirty = reason !== (row.reason ?? "") || note !== (row.note ?? "");
  const productName = row.product.name;
  return <section className="card" aria-labelledby={`product-${row.id}`} style={{ padding: 18, display: "grid", gap: 14 }}>
    <header><h2 id={`product-${row.id}`} style={{ margin: 0 }}>{productName}</h2><p>{row.product.packageSize} · UPC {row.product.barcodeValue ?? "not recorded"}</p></header>
    <dl style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12, margin: 0 }}>
      <div><dt>Expected in store</dt><dd style={{ margin: 0, fontSize: 24 }}>{row.expectedStoreQty}</dd></div>
      <div><dt>Actual counted</dt><dd style={{ margin: 0, fontSize: 24 }}>{row.actualStoreQty}</dd></div>
      <div><dt>Difference</dt><dd style={{ margin: 0, fontSize: 24 }}>{row.difference > 0 ? "+" : ""}{row.difference}</dd></div>
    </dl>
    <p>{row.status === "RESOLVED" ? "No difference remains. No adjustment is needed." : row.difference < 0 ? shortageInstruction(Math.abs(row.difference)) : row.difference > 0 ? overageInstruction(row.difference) : "The count matches the expected store total."}</p>
    <div><h3>Counted locations</h3><ul>{row.countedLocations.map((location) => <li key={location.locationId}>{location.code}{location.name ? ` — ${location.name}` : ""}: <strong>{location.quantity}</strong> units</li>)}</ul>{row.countedLocations.length === 0 && <p>No physical location entries recorded.</p>}</div>
    <div><h3>Employee explanation</h3><p>{reasons.find(([value]) => value === row.reason)?.[1] ?? "Not yet explained"}</p>{row.note && <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{row.note}</p>}
      {row.explainedAt && <p>Saved{row.explainedBy?.name ? ` by ${row.explainedBy.name}` : ""} · {new Date(row.explainedAt).toLocaleString()}</p>}
    </div>
    {editable && review.canExplain && <div style={{ display: "grid", gap: 10 }}>
      <label htmlFor={`reason-${row.id}`}>What did you find?</label>
      <select id={`reason-${row.id}`} aria-label={`Reason for ${productName}`} value={reason} onChange={(event) => onDraft({ reason: event.target.value, note })} disabled={locked} style={controlStyle}>
        <option value="">Choose a reason</option>{reasons.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <label htmlFor={`note-${row.id}`}>Optional note (up to 500 characters)</label>
      <textarea id={`note-${row.id}`} aria-label={`Note for ${productName}`} value={note} maxLength={500} onChange={(event) => onDraft({ reason, note: event.target.value })} disabled={locked} rows={3} style={controlStyle} />
      <button type="button" disabled={locked || !reason} style={controlStyle} onClick={() => void onWrite(row, "explain", { reason, note })}>{busy === `${row.id}:explain` ? "Saving…" : "Save explanation"}</button>
    </div>}
    {row.status === "APPROVED" ? <p role="status"><strong>Baseline approved</strong>{row.reviewedBy?.name ? ` by ${row.reviewedBy.name}` : ""}{row.reviewedAt ? ` · ${new Date(row.reviewedAt).toLocaleString()}` : ""}. Original count evidence is retained.</p>
      : row.status === "REJECTED" ? <p>Baseline not approved. Contact your manager for the next step.</p>
        : editable && review.canApprove ? <div><p>Review the product, every counted location, and the explanation. Approval records a {row.difference > 0 ? "+" : ""}{row.difference}-unit store adjustment and locks this product&apos;s count evidence.</p>
          {!row.reason && <p>The assigned employee must save a reason first.</p>}
          {dirty && review.canExplain && <p>Save your explanation changes before approval.</p>}
          <button type="button" style={controlStyle} disabled={locked || !row.reason || (dirty && review.canExplain)} onClick={() => void onWrite(row, "approve", { reviewToken: row.reviewToken })}>{busy === `${row.id}:approve` ? "Approving…" : "Approve new baseline"}</button>
        </div> : row.status === "OPEN" && <p>A manager will review this difference. A difference alone does not establish its cause.</p>}
  </section>;
}

function ReviewContext({ sessionId }: { sessionId: string }) {
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  // ReviewContext is keyed by actor+session; drafts survive server reloads but
  // cannot transfer to another signed-in employee or count.
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const alive = useRef(false);
  const busyRef = useRef(false);
  const requestVersion = useRef(0);
  const messageRef = useRef<HTMLParagraphElement>(null);
  const blocked = getCountQueue().some((scan) => scan.sessionId === sessionId);
  const load = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoading(true); setError(null); setReview(null);
    try {
      const result = await apiJson<Review>(`/api/inventory-truth/counts/${encodeURIComponent(sessionId)}/review`);
      if (alive.current && version === requestVersion.current) setReview(result);
    } catch (error) {
      if (alive.current && version === requestVersion.current) setError(error instanceof Error ? error.message : "Could not load this count. Try again.");
    } finally { if (alive.current && version === requestVersion.current) setLoading(false); }
  }, [sessionId]);
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; requestVersion.current += 1; }; }, [load]);
  useEffect(() => { if (message || error) messageRef.current?.focus(); }, [message, error]);

  async function write(row: Discrepancy, action: "explain" | "approve", body: object) {
    if (!alive.current || busyRef.current || getCountQueue().some((scan) => scan.sessionId === sessionId)) return;
    busyRef.current = true; setBusy(`${row.id}:${action}`); setError(null); setMessage(null);
    try {
      await apiJson(`/api/inventory-truth/counts/${encodeURIComponent(sessionId)}/discrepancies/${encodeURIComponent(row.id)}/${action}`, { method: action === "explain" ? "PATCH" : "POST", body: JSON.stringify(body) });
      if (!alive.current) return;
      if (action === "explain") setDrafts((current) => { const next = { ...current }; delete next[row.id]; return next; });
      setMessage(action === "explain" ? "Explanation saved. Return to Count when every difference is explained." : "Baseline approved. The original count and explanation are retained.");
      await load();
    } catch (error) {
      if (alive.current) setError(error instanceof Error ? error.message : "Could not save. Your review is still here; try again.");
    } finally { if (alive.current) { busyRef.current = false; setBusy(null); } }
  }
  return <>
    {loading && <p role="status">Loading count review…</p>}
    {error && <p ref={messageRef} role="alert" tabIndex={-1}>{error}</p>}
    {message && !error && <p ref={messageRef} role="status" tabIndex={-1}>{message}</p>}
    {error && !busy && <button type="button" onClick={() => void load()} style={{ minHeight: 44 }}>Retry loading review</button>}
    {blocked && <p role="alert">This device has unsynced work for this count. Return to Count to sync before explaining or approving.</p>}
    {!loading && review && <>
      {review.sessionStatus === "COMPLETED" && <p>Count is finished and locked. A manager may still approve its explained differences.</p>}
      {!review.finalized && <p>Check every assigned location in Count before reviewing the final differences.</p>}
      {review.finalized && review.discrepancies.length === 0 && <p>No differences need review. Return to Count to finish and lock your work.</p>}
      <div style={{ display: "grid", gap: 18 }}>{review.discrepancies.map((row) => <DifferenceCard key={`${row.id}:${row.reviewToken}`} row={row} review={review} busy={busy} draft={drafts[row.id]} onDraft={(draft) => setDrafts((current) => ({ ...current, [row.id]: draft }))} blocked={blocked || !review.finalized || review.sessionStatus === "CANCELLED"} onWrite={write} />)}</div>
    </>}
  </>;
}

type ReviewCount = { id: string; name: string | null; status: string; startedAt: string; site: { name: string }; startedBy: { name: string } | null };
function ReviewDiscovery() {
  const [counts, setCounts] = useState<{ pending: ReviewCount[]; completed: ReviewCount[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true;
    void apiJson<{ pending: ReviewCount[]; completed: ReviewCount[] }>("/api/inventory-truth/counts/reviews")
      .then((result) => { if (alive) setCounts(result); })
      .catch((error) => { if (alive) setError(error instanceof Error ? error.message : "Could not load count reviews."); });
    return () => { alive = false; };
  }, [retry]);
  const list = (rows: ReviewCount[]) => <ul>{rows.map((count) => <li key={count.id} style={{ marginBottom: 16 }}>
    <a style={{ display: "inline-block", minHeight: 44 }} href={`/store-count/review?sessionId=${encodeURIComponent(count.id)}`}>{count.name || "Store count"} — {count.site.name}</a>
    <div>{count.status === "COMPLETED" ? "Finished and locked" : "Count in progress"} · {count.startedBy?.name ?? "Employee not recorded"} · {new Date(count.startedAt).toLocaleString()}</div>
  </li>)}</ul>;
  return <section>
    {error ? <><p role="alert">{error}</p><button onClick={() => { setError(null); setRetry((value) => value + 1); }}>Retry count list</button></> : !counts ? <p role="status">Loading count reviews…</p> : <>
      <h2>Awaiting review</h2><p>Oldest first, up to 100 counts from stores you can access. Open a count to see whether its location checks and explanations are ready.</p>
      {counts.pending.length ? list(counts.pending) : <p>No counts awaiting review.</p>}
      <h2>Recently reviewed completed counts</h2><p>Last 20 counts with no open differences.</p>
      {counts.completed.length ? list(counts.completed) : <p>No reviewed completed counts yet.</p>}
    </>}
  </section>;
}

function ReviewPageContent() {
  const { user, loading } = useAuth();
  const sessionId = useSearchParams().get("sessionId");
  return <main style={{ maxWidth: 760, margin: "0 auto", padding: 18 }}>
    <a href={sessionId ? `/store-count?sessionId=${encodeURIComponent(sessionId)}` : "/store-count"} style={{ display: "inline-block", minHeight: 44 }}>Return to Count</a>
    {sessionId && <a href="/store-count/review" style={{ display: "inline-block", minHeight: 44, marginLeft: 18 }}>All count reviews</a>}
    <h1>Review count differences</h1><p>Check the evidence, explain what you found, and let a manager approve any inventory adjustment.</p>
    {loading ? <p role="status">Checking sign-in…</p> : !user ? <p>Sign in to review this count.</p> : !sessionId ? <ReviewDiscovery key={user.id} /> : <ReviewContext key={`${user.id}:${sessionId}`} sessionId={sessionId} />}
  </main>;
}
export default function CountReviewPage() { return <Suspense fallback={<p role="status">Loading count review…</p>}><ReviewPageContent /></Suspense>; }
