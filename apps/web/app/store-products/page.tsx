"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, apiJson } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";
import { useToast } from "../../lib/toast-context";
import { BrandLockup } from "../../components/BrandLockup";
import { frozenCountExpectationNotice } from "../../lib/inventoryTruthPresentation";
import type { InventoryStockSite, InventoryStockState } from "../../lib/types";

type Category = { id: string; name: string; isActive?: boolean };
type Product = { id: string; barcodeValue: string | null; name: string; manufacturer: string | null; description: string | null; packageSize: string | null; imageUrl: string | null; categoryId: string | null; category?: Category | null; isActive: boolean };
type ProductDraft = { name: string; manufacturer: string; description: string; packageSize: string; imageUrl: string; categoryId: string; barcodeValue: string };
type ProductCsvPreview = { previewId: string; organizationId: string; errorCsv: string; totals: { rows: number; valid: number; warnings: number; errors: number }; rows: Array<{ row: number; status: "valid" | "warning" | "error"; errors: string[]; warnings: string[] }> };
const emptyProduct: ProductDraft = { name: "", manufacturer: "", description: "", packageSize: "", imageUrl: "", categoryId: "", barcodeValue: "" };

export default function StoreProductsPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const { show } = useToast();
  const [products, setProducts] = useState<Product[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [query, setQuery] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<ProductDraft>(emptyProduct);
  const [saving, setSaving] = useState(false);
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [csvPreview, setCsvPreview] = useState<ProductCsvPreview | null>(null);
  const [reviewingCsv, setReviewingCsv] = useState(false);
  const [importingCsv, setImportingCsv] = useState(false);
  const [stockSites, setStockSites] = useState<InventoryStockSite[]>([]);
  const [stockSitesLoading, setStockSitesLoading] = useState(true);
  const [stockSitesError, setStockSitesError] = useState<string | null>(null);
  const [stockSiteId, setStockSiteId] = useState("");
  const [stockState, setStockState] = useState<InventoryStockState | null>(null);
  const [stockLoading, setStockLoading] = useState(false);
  const [stockError, setStockError] = useState<string | null>(null);
  const stockRequestId = useRef(0);
  useEffect(() => () => { stockRequestId.current += 1; }, []);

  useEffect(() => { if (!loading && !user) router.push("/login"); }, [loading, user, router]);
  async function loadStockSites() {
    setStockSitesLoading(true); setStockSitesError(null);
    try {
      setStockSites(await apiJson<InventoryStockSite[]>("/api/inventory-truth/sites"));
    } catch (error) {
      setStockSitesError(error instanceof Error ? error.message : "Could not load sites.");
    } finally { setStockSitesLoading(false); }
  }
  async function loadCatalog() {
    setCatalogError(null);
    try {
      const [productRows, categoryRows] = await Promise.all([
        apiJson<Product[]>("/api/products?includeInactive=true"),
        apiJson<Category[]>("/api/categories").catch(() => []),
      ]);
      setProducts(productRows); setCategories(categoryRows.filter((category) => category.isActive !== false));
    } catch (error) {
      setCatalogError(error instanceof Error ? error.message : "Could not load product catalog.");
    }
  }
  async function load() {
    // Site access is independent of the catalog's organization selector.
    // Each loader applies its own result and handles its own errors.
    await Promise.all([loadCatalog(), loadStockSites()]);
  }
  useEffect(() => { if (user) void load(); }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return products.filter((product) => {
      if (!showInactive && !product.isActive) return false;
      if (!needle) return true;
      return [product.name, product.manufacturer ?? "", product.description ?? "", product.barcodeValue ?? ""].join(" ").toLowerCase().includes(needle);
    });
  }, [products, query, showInactive]);

  async function setActive(product: Product, isActive: boolean) {
    setBusyId(product.id);
    try {
      await apiJson(`/api/products/${product.id}`, { method: "PATCH", body: JSON.stringify({ isActive }) });
      setProducts((rows) => rows.map((row) => (row.id === product.id ? { ...row, isActive } : row)));
      show(`${product.name} ${isActive ? "activated" : "made inactive"}`, "success");
    } catch (error) { show(error instanceof Error ? error.message : "Could not update product.", "error"); }
    finally { setBusyId(null); }
  }

  async function addProduct(event: FormEvent) {
    event.preventDefault();
    if (!draft.name.trim()) return;
    setSaving(true);
    try {
      await apiJson("/api/products", { method: "POST", body: JSON.stringify({ barcodeValue: draft.barcodeValue.trim() || null, name: draft.name.trim(), manufacturer: draft.manufacturer.trim() || null, description: draft.description.trim() || null, packageSize: draft.packageSize.trim() || null, imageUrl: draft.imageUrl.trim() || null, categoryId: draft.categoryId || null, isActive: true }) });
      show(`${draft.name.trim()} added`, "success"); setDraft(emptyProduct); setAdding(false); await load();
    } catch (error) { show(error instanceof Error ? error.message : "Could not add product.", "error"); }
    finally { setSaving(false); }
  }

  function downloadCsv(csv: string, filename: string) {
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url; link.download = filename; link.click();
    URL.revokeObjectURL(url);
  }

  function downloadTemplate() {
    downloadCsv("upc,name,manufacturer,description,package_size,category,is_active\r\n", "product-import-template.csv");
  }

  async function reviewCsv() {
    if (!csvFile) { show("Choose a CSV file before reviewing it.", "error"); return; }
    if (reviewingCsv || importingCsv) return;
    setCsvPreview(null);
    setReviewingCsv(true);
    try {
      const form = new FormData(); form.append("file", csvFile);
      const response = await apiFetch("/api/products/import/preview", { method: "POST", body: form });
      const payload = await response.json();
      if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : "Could not review CSV.");
      setCsvPreview(payload); show(`Review complete: ${payload.totals.rows} rows.`, "success");
    } catch (error) { show(error instanceof Error ? error.message : "Could not review CSV.", "error"); }
    finally { setReviewingCsv(false); }
  }

  async function importCsv() {
    if (!csvPreview || csvPreview.totals.errors > 0 || csvPreview.totals.rows === 0 || reviewingCsv || importingCsv) return;
    if (!window.confirm(`Import ${csvPreview.totals.rows} product${csvPreview.totals.rows === 1 ? "" : "s"}? This cannot be undone from this screen.`)) return;
    setImportingCsv(true);
    try {
      const result = await apiJson<{ imported: number }>("/api/products/import/commit", { method: "POST", body: JSON.stringify({ previewId: csvPreview.previewId, organizationId: csvPreview.organizationId }) });
      show(`Imported ${result.imported} products.`, "success"); setCsvPreview(null); setCsvFile(null); await load();
    } catch (error) { show(error instanceof Error ? error.message : "Could not import CSV.", "error"); }
    finally { setImportingCsv(false); }
  }

  async function loadStockState(siteId: string, cursor?: string) {
    if (!siteId) return;
    const requestId = ++stockRequestId.current;
    setStockLoading(true); setStockError(null);
    try {
      const query = new URLSearchParams({ limit: "50" });
      if (cursor) query.set("cursor", cursor);
      const next = await apiJson<InventoryStockState>(`/api/inventory-truth/sites/${siteId}/stock-state?${query}`);
      if (requestId !== stockRequestId.current) return;
      setStockState((current) => cursor && current
        ? { rows: [...current.rows, ...next.rows], nextCursor: next.nextCursor }
        : next);
    } catch (error) {
      if (requestId !== stockRequestId.current) return;
      setStockError(error instanceof Error ? error.message : "Could not load current stock.");
      if (!cursor) setStockState(null);
    } finally { if (requestId === stockRequestId.current) setStockLoading(false); }
  }

  if (loading || !user) return null;
  return (
    <main className="container" style={{ maxWidth: 760, paddingBottom: 44 }}>
      <header style={{ display: "flex", alignItems: "end", justifyContent: "space-between", gap: 12, marginBottom: 16 }}>
        <div><BrandLockup compact /><h1 style={{ margin: "8px 0 0" }}>Products</h1></div>
        <button type="button" onClick={() => setAdding((value) => !value)}>{adding ? "Close" : "Add product"}</button>
      </header>
      <p><a href="/inventory-history">Inventory history</a></p>
      {adding && <form onSubmit={addProduct} className="card" style={{ padding: 16, marginBottom: 16, display: "grid", gap: 10 }}>
        <strong>Manual product entry</strong>
        <input inputMode="numeric" placeholder="UPC (optional)" value={draft.barcodeValue} onChange={(event) => setDraft({ ...draft, barcodeValue: event.target.value })} />
        <input placeholder="Product name *" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        <input placeholder="Manufacturer / Brand" value={draft.manufacturer} onChange={(event) => setDraft({ ...draft, manufacturer: event.target.value })} />
        <textarea rows={2} placeholder="Description" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
        <input placeholder="Size / Pack" value={draft.packageSize} onChange={(event) => setDraft({ ...draft, packageSize: event.target.value })} />
        <input placeholder="Product image URL (optional)" value={draft.imageUrl} onChange={(event) => setDraft({ ...draft, imageUrl: event.target.value })} />
        <select value={draft.categoryId} onChange={(event) => setDraft({ ...draft, categoryId: event.target.value })}><option value="">Category (optional)</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select>
        <button type="submit" disabled={saving || !draft.name.trim()}>{saving ? "Saving…" : "Save product"}</button>
      </form>}
      <section className="card" style={{ padding: 16, marginBottom: 16, display: "grid", gap: 10 }} aria-label="Product CSV import">
        <strong>Import products from CSV</strong>
        <span style={{ fontSize: 13, opacity: 0.72 }}>Use the template, then review every row before anything is imported. Maximum 5 MiB and 10,000 rows. Inventory quantities are never imported here. Leave category blank; tenant-scoped category imports are not yet supported.</span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}><button type="button" className="secondary" onClick={downloadTemplate}>Download Template</button><label className="secondary" style={{ cursor: "pointer" }}>Choose CSV<input aria-label="Choose CSV" type="file" accept="text/csv,.csv" disabled={reviewingCsv || importingCsv} style={{ display: "none" }} onChange={(event) => { setCsvFile(event.target.files?.[0] ?? null); setCsvPreview(null); }} /></label><button type="button" onClick={() => void reviewCsv()} disabled={!csvFile || reviewingCsv || importingCsv}>{reviewingCsv ? "Reviewing…" : "Review"}</button></div>
        {csvFile && <span style={{ fontSize: 13 }}>Selected: {csvFile.name}. Review it before importing.</span>}
        {csvPreview && <div style={{ display: "grid", gap: 7 }}>
          <strong>{csvPreview.totals.rows} rows reviewed: {csvPreview.totals.valid} valid, {csvPreview.totals.warnings} warnings, {csvPreview.totals.errors} errors.</strong>
          {csvPreview.totals.warnings > 0 && <>
            <span>Same-name products are allowed. Review these warnings before importing (first 20 rows shown).</span>
            <ul>{csvPreview.rows.filter((row) => row.status === "warning").slice(0, 20).map((row) => <li key={row.row}>Row {row.row}: {row.warnings.join(" ")}</li>)}</ul>
          </>}
          {csvPreview.totals.errors > 0 && <>
            <span role="alert">Fix the errors shown below, then choose the corrected CSV and review it again. Showing the first 20 errors; download the error report for all rows.</span>
            <button type="button" className="secondary" onClick={() => document.querySelector<HTMLInputElement>('input[aria-label="Choose CSV"]')?.click()}>Fix Errors</button>
            <button type="button" className="secondary" onClick={() => downloadCsv(csvPreview.errorCsv, "product-import-errors.csv")}>Download Errors</button>
            <ul>{csvPreview.rows.filter((row) => row.status === "error").slice(0, 20).map((row) => <li key={row.row}>Row {row.row}: {row.errors.join(" ")}</li>)}</ul>
          </>}
          <button type="button" disabled={csvPreview.totals.errors > 0 || csvPreview.totals.rows === 0 || importingCsv || reviewingCsv} onClick={() => void importCsv()}>{importingCsv ? "Importing…" : "Import"}</button>
        </div>}
        {!csvPreview && <button type="button" disabled>Fix Errors</button>}
        {!csvPreview && <button type="button" disabled>Import</button>}
      </section>
      <section className="card" style={{ padding: 16, marginBottom: 16, display: "grid", gap: 10 }} aria-label="Current stock state">
        <strong>Current stock state</strong>
        <label style={{ display: "grid", gap: 5, maxWidth: 360 }}>Site
          <select aria-label="Stock site" value={stockSiteId} onChange={(event) => {
            const siteId = event.target.value;
            stockRequestId.current += 1;
            setStockSiteId(siteId); setStockState(null); setStockError(null); setStockLoading(false);
            if (siteId) void loadStockState(siteId);
          }}>
            <option value="">Select a site</option>
            {stockSites.map((site) => <option key={site.id} value={site.id}>{site.code} — {site.name}</option>)}
          </select>
        </label>
        {!stockSiteId && <span style={{ fontSize: 13, opacity: 0.72 }}>Select a site to see current stock.</span>}
        {stockSitesLoading && <span>Loading sites…</span>}
        {stockSitesError && <span role="alert">{stockSitesError}</span>}
        {!stockSitesLoading && !stockSitesError && stockSites.length === 0 && <span style={{ fontSize: 13, opacity: 0.72 }}>No active sites are available to your account.</span>}
        <span style={{ fontSize: 13, opacity: 0.72 }}>{frozenCountExpectationNotice()}</span>
        {stockError && <span role="alert">{stockError}</span>}
        {stockSiteId && stockLoading && !stockState && <span>Loading current stock…</span>}
        {stockState && <div style={{ display: "grid", gap: 8 }}>
          {stockState.rows.map((row) => <article key={row.product.id} style={{ borderTop: "1px solid var(--border, #ddd)", paddingTop: 8 }}>
            <strong>{row.product.name}</strong>
            <div style={{ fontSize: 13, marginTop: 4 }}>On hand: {row.onHand}</div>
            <div style={{ fontSize: 13 }}>Committed — not tracked</div>
            <div style={{ fontSize: 13 }}>Incoming — not tracked</div>
            <div style={{ fontSize: 12, opacity: 0.66, marginTop: 3 }}>Ledger creation cutoff: {new Date(row.asOf).toLocaleString()}</div>
          </article>)}
          {stockState.rows.length === 0 && <span style={{ opacity: 0.72 }}>No active products at this site.</span>}
          {stockState.nextCursor && <button type="button" className="secondary" disabled={stockLoading} onClick={() => void loadStockState(stockSiteId, stockState.nextCursor!)}>{stockLoading ? "Loading…" : "Show more"}</button>}
        </div>}
      </section>
      {catalogError && <p role="alert">Product catalog: {catalogError}</p>}
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, brand, description or UPC" style={{ width: "100%", marginBottom: 10 }} />
      <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, fontSize: 14 }}><input type="checkbox" checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} style={{ width: 18, height: 18 }} />Show inactive products</label>
      <div style={{ display: "grid", gap: 9 }}>
        {visible.map((product) => <article key={product.id} className="card" style={{ padding: 14, display: "grid", gridTemplateColumns: product.imageUrl ? "72px 1fr auto" : "1fr auto", gap: 12, alignItems: "center", opacity: product.isActive ? 1 : 0.58 }}>
          {product.imageUrl && <img src={product.imageUrl} alt="" style={{ width: 72, height: 72, objectFit: "contain", background: "white", borderRadius: 10 }} />}
          <div style={{ minWidth: 0 }}><strong>{product.name}</strong><div style={{ fontSize: 13, opacity: 0.7, marginTop: 3 }}>{[product.manufacturer, product.packageSize, product.category?.name].filter(Boolean).join(" · ") || "No additional details"}</div><div style={{ fontSize: 12, opacity: 0.58, marginTop: 3 }}>{product.barcodeValue ? `UPC ${product.barcodeValue}` : "No UPC"} · {product.isActive ? "Active" : "Inactive"}</div></div>
          <button type="button" className="secondary" disabled={busyId === product.id} onClick={() => void setActive(product, !product.isActive)}>{product.isActive ? "Inactive" : "Activate"}</button>
        </article>)}
        {!catalogError && visible.length === 0 && <p style={{ opacity: 0.7 }}>No products match this view.</p>}
      </div>
    </main>
  );
}
