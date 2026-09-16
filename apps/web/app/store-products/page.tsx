"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiJson } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";
import { useToast } from "../../lib/toast-context";
import { BrandLockup } from "../../components/BrandLockup";

type Category = { id: string; name: string; isActive?: boolean };
type Product = { id: string; barcodeValue: string | null; name: string; manufacturer: string | null; description: string | null; packageSize: string | null; imageUrl: string | null; categoryId: string | null; category?: Category | null; isActive: boolean };
type ProductDraft = { name: string; manufacturer: string; description: string; packageSize: string; imageUrl: string; categoryId: string; barcodeValue: string };
const emptyProduct: ProductDraft = { name: "", manufacturer: "", description: "", packageSize: "", imageUrl: "", categoryId: "", barcodeValue: "" };

export default function StoreProductsPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const { show } = useToast();
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [query, setQuery] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<ProductDraft>(emptyProduct);
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (!loading && !user) router.push("/login"); }, [loading, user, router]);
  async function load() {
    const [productRows, categoryRows] = await Promise.all([
      apiJson<Product[]>("/api/products?includeInactive=true"),
      apiJson<Category[]>("/api/categories").catch(() => []),
    ]);
    setProducts(productRows); setCategories(categoryRows.filter((category) => category.isActive !== false));
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

  if (loading || !user) return null;
  return (
    <main className="container" style={{ maxWidth: 760, paddingBottom: 44 }}>
      <header style={{ display: "flex", alignItems: "end", justifyContent: "space-between", gap: 12, marginBottom: 16 }}>
        <div><BrandLockup compact /><h1 style={{ margin: "8px 0 0" }}>Products</h1></div>
        <button type="button" onClick={() => setAdding((value) => !value)}>{adding ? "Close" : "Add product"}</button>
      </header>
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
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, brand, description or UPC" style={{ width: "100%", marginBottom: 10 }} />
      <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, fontSize: 14 }}><input type="checkbox" checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} style={{ width: 18, height: 18 }} />Show inactive products</label>
      <div style={{ display: "grid", gap: 9 }}>
        {visible.map((product) => <article key={product.id} className="card" style={{ padding: 14, display: "grid", gridTemplateColumns: product.imageUrl ? "72px 1fr auto" : "1fr auto", gap: 12, alignItems: "center", opacity: product.isActive ? 1 : 0.58 }}>
          {product.imageUrl && <img src={product.imageUrl} alt="" style={{ width: 72, height: 72, objectFit: "contain", background: "white", borderRadius: 10 }} />}
          <div style={{ minWidth: 0 }}><strong>{product.name}</strong><div style={{ fontSize: 13, opacity: 0.7, marginTop: 3 }}>{[product.manufacturer, product.packageSize, product.category?.name].filter(Boolean).join(" · ") || "No additional details"}</div><div style={{ fontSize: 12, opacity: 0.58, marginTop: 3 }}>{product.barcodeValue ? `UPC ${product.barcodeValue}` : "No UPC"} · {product.isActive ? "Active" : "Inactive"}</div></div>
          <button type="button" className="secondary" disabled={busyId === product.id} onClick={() => void setActive(product, !product.isActive)}>{product.isActive ? "Inactive" : "Activate"}</button>
        </article>)}
        {visible.length === 0 && <p style={{ opacity: 0.7 }}>No products match this view.</p>}
      </div>
    </main>
  );
}
