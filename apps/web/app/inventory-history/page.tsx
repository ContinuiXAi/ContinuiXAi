"use client";

import { useEffect, useRef, useState } from "react";
import { apiJson } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";
import { inventoryHistoryCsv, type InventoryHistory } from "../../lib/inventoryHistoryCsv";

type Site = { id: string; name: string };
function Report() {
  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState("");
  const [asOf, setAsOf] = useState(() => new Date().toISOString());
  const [recorded, setRecorded] = useState("");
  const [report, setReport] = useState<InventoryHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [siteError, setSiteError] = useState<string | null>(null);
  const [sitesLoading, setSitesLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const alive = useRef(false), locked = useRef(false), version = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; version.current += 1; };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setSitesLoading(true); setSiteError(null);
    void apiJson<Site[]>("/api/inventory-truth/sites").then((result) => {
      if (!cancelled) { setSites(result); setSiteId(result[0]?.id ?? ""); }
    }).catch((reason: unknown) => { if (!cancelled) setSiteError(reason instanceof Error ? reason.message : "Cannot load stores."); })
      .finally(() => { if (!cancelled) setSitesLoading(false); });
    return () => { cancelled = true; };
  }, [retry]);
  function invalidate() {
    version.current += 1; locked.current = false; setBusy(false); setReport(null); setError(null);
  }
  async function load(cursor?: string) {
    if (locked.current || !siteId || !asOf.trim()) return;
    locked.current = true; const requestVersion = ++version.current;
    setBusy(true); setError(null); setReport(null);
    const query = new URLSearchParams({ asOfExclusive: asOf.trim(), limit: "50" });
    if (recorded.trim()) query.set("recordedBefore", recorded.trim());
    if (cursor) query.set("cursor", cursor);
    try {
      const result = await apiJson<InventoryHistory>(`/api/inventory-history/sites/${encodeURIComponent(siteId)}/as-of?${query}`);
      if (alive.current && requestVersion === version.current) setReport(result);
    } catch (reason) {
      if (alive.current && requestVersion === version.current) setError(reason instanceof Error ? reason.message : "Cannot load quantities. Try again.");
    } finally {
      if (alive.current && requestVersion === version.current) { locked.current = false; setBusy(false); }
    }
  }
  function download() {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([inventoryHistoryCsv(report)], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = "inventory-history-page.csv";
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <>
    <p>Monetary valuation unavailable — cost accounting is not configured.</p>
    <p>Includes signed ledger quantities where occurredAt &lt; the effective cutoff. A blank recorded cutoff includes later-recorded backdated events. Set it to include only events where createdAt &lt; recorded before. Both boundaries are exclusive.</p>
    <p>Enter ISO timestamps with a timezone (Z means UTC), up to millisecond precision. Product labels are current catalog metadata, including archived products. Units are never combined.</p>
    {sitesLoading && <p role="status">Loading stores…</p>}
    {siteError && <div><p role="alert">{siteError}</p><button type="button" onClick={() => setRetry((n) => n + 1)}>Retry stores</button></div>}
    {!sitesLoading && !siteError && sites.length === 0 && <p>No accessible active stores.</p>}
    <form onSubmit={(event) => { event.preventDefault(); void load(); }} style={{ display: "grid", gap: 12, maxWidth: 640 }}>
      <label>Store<select aria-label="Store" value={siteId} disabled={sitesLoading || !sites.length} onChange={(event) => { invalidate(); setSiteId(event.target.value); }}>{sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label>
      <label>Effective cutoff (exclusive)<input aria-label="Effective cutoff (exclusive)" required maxLength={40} value={asOf} onChange={(event) => { invalidate(); setAsOf(event.target.value); }} /></label>
      <label>Recorded before (optional)<input aria-label="Recorded before (optional)" maxLength={40} value={recorded} placeholder="All recording times" onChange={(event) => { invalidate(); setRecorded(event.target.value); }} /></label>
      <button disabled={busy || !siteId || !asOf.trim()} type="submit">Load quantities</button>
    </form>
    {busy && <p role="status">Loading quantities…</p>}
    {error && <p role="alert">{error}</p>}
    {report && <section aria-label="Quantity results">
      <p>Store: {sites.find((site) => site.id === report.siteId)?.name ?? report.siteId} · Effective cutoff: {report.asOfExclusive} · Recorded before: {report.recordedBefore ?? "Unbounded (includes later-recorded events)"}</p>
      <p>Up to 50 products per page. This page&apos;s CSV includes cutoffs and provenance; import text columns as text in spreadsheets to preserve identifiers and decimal precision. Pages are not a frozen catalog snapshot.</p>
      <button type="button" onClick={download}>Export this page CSV</button>
      {report.rows.length === 0 ? <p>No products on this page.</p> : <div style={{ overflowX: "auto" }}><table><thead><tr><th>Product (current)</th><th>Quantity</th><th>Unit</th><th>Events</th><th>First effective</th><th>Last effective</th><th>Last recorded</th></tr></thead><tbody>
        {report.rows.map((row) => <tr key={`${row.product.id}:${row.unitOfMeasure ?? "none"}`}>
          <td>{row.product.name} · {row.product.barcodeValue ?? "No barcode"}{!row.product.isActive && " · Archived"}</td>
          <td>{row.quantity}{row.provenance.eventCount === 0 && <span> — No ledger history before these cutoffs</span>}</td><td>{row.unitOfMeasure ?? "—"}</td>
          <td>{row.provenance.eventCount} · {row.provenance.source}</td><td>{row.provenance.firstOccurredAt ?? "—"}</td><td>{row.provenance.lastOccurredAt ?? "—"}</td><td>{row.provenance.lastRecordedAt ?? "—"}</td>
        </tr>)}
      </tbody></table></div>}
      {report.nextCursor && <button type="button" onClick={() => void load(report.nextCursor!)}>Next page</button>}
    </section>}
  </>;
}

export default function InventoryHistoryPage() {
  const { user, loading } = useAuth();
  return <main style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 18px 100px" }}>
    <a href="/store-products">Products</a><h1>Point-in-time inventory quantities</h1>
    {loading ? <p role="status">Loading sign-in…</p> : user ? <Report key={user.id} /> : <p>Sign in to view inventory history.</p>}
  </main>;
}
