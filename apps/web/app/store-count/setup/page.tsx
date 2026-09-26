"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";
import { BrandLockup } from "../../../components/BrandLockup";
import { apiJson } from "../../../lib/api";
import { useAuth } from "../../../lib/auth-context";
import { useToast } from "../../../lib/toast-context";

type StoreLocation = { id: string; code: string; name: string | null; isActive: boolean };
type Product = { id: string; name: string; barcodeValue: string; packageSize: string | null };
type CreatedSession = { id: string };

function StoreCountSetup() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading } = useAuth();
  const { show } = useToast();
  const sessionId = searchParams.get("sessionId")?.trim() ?? "";
  const siteId = searchParams.get("siteId")?.trim() ?? "";
  const canManage = user?.role === "ADMIN" || user?.taskManager === true;
  const [locations, setLocations] = useState<StoreLocation[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [locationId, setLocationId] = useState("");
  const [productId, setProductId] = useState("");
  const [loadingOptions, setLoadingOptions] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    if (loading || !user || !canManage || !sessionId || !siteId) {
      setLoadingOptions(false);
      return;
    }
    let cancelled = false;
    void Promise.all([
      apiJson<StoreLocation[]>("/api/store-locations"),
      apiJson<Product[]>("/api/products"),
    ]).then(([nextLocations, nextProducts]) => {
      if (cancelled) return;
      const activeLocations = nextLocations.filter((location) => location.isActive !== false);
      setLocations(activeLocations);
      setProducts(nextProducts);
      setLocationId(activeLocations[0]?.id ?? "");
      setProductId(nextProducts[0]?.id ?? "");
      setLoadingOptions(false);
    }).catch((error: unknown) => {
      if (cancelled) return;
      setLoadError(error instanceof Error ? error.message : "Unable to load count setup.");
      setLoadingOptions(false);
    });
    return () => { cancelled = true; };
  }, [canManage, loading, sessionId, siteId, user]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!productId || !locationId || !siteId || !sessionId || saving) return;
    setSaving(true);
    try {
      await apiJson(`/api/inventory-truth/products/${encodeURIComponent(productId)}/location-hints`, {
        method: "POST",
        body: JSON.stringify({ siteId, locationId, evidence: "ASSIGNED", isRequired: true }),
      });
      await apiJson(`/api/store-count/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: "POST" });
      const session = await apiJson<CreatedSession>("/api/store-count/sessions", {
        method: "POST",
        body: JSON.stringify({ siteId }),
      });
      show("Count location assigned. Your fresh count is ready.", "success");
      router.push(`/store-count?sessionId=${encodeURIComponent(session.id)}`);
    } catch (error: unknown) {
      show(error instanceof Error ? error.message : "Unable to start the count.", "error");
      setSaving(false);
    }
  }

  if (loading || !user) return null;

  if (!canManage) {
    return <main className="container">
      <BrandLockup />
      <h1>Count setup</h1>
      <section className="card" style={{ padding: 16 }}>
        <h2>Manager access is required</h2>
        <p>Ask your supervisor to assign the count locations.</p>
        <Link href="/my-work">Return to My Work</Link>
      </section>
    </main>;
  }

  if (!sessionId || !siteId) {
    return <main className="container">
      <BrandLockup />
      <h1>Count setup</h1>
      <p role="alert">This setup link is incomplete. Return to Count and try again.</p>
      <Link href="/store-count">Return to Count</Link>
    </main>;
  }

  return <main className="container">
    <BrandLockup />
    <h1>Set up your first count location</h1>
    <p>Choose one product and where employees should count it. You can add more assignments later.</p>
    {loadingOptions && <p role="status">Loading products and locations…</p>}
    {loadError && <p role="alert">{loadError}</p>}
    {!loadingOptions && !loadError && <form className="form" onSubmit={submit}>
      <label htmlFor="count-setup-product">Product</label>
      <select id="count-setup-product" value={productId} onChange={(event) => setProductId(event.target.value)}>
        {products.length === 0 && <option value="">No active products available</option>}
        {products.map((product) => <option key={product.id} value={product.id}>
          {product.name}{product.packageSize ? ` — ${product.packageSize}` : ""} · UPC {product.barcodeValue}
        </option>)}
      </select>
      <label htmlFor="count-setup-location">Count location</label>
      <select id="count-setup-location" value={locationId} onChange={(event) => setLocationId(event.target.value)}>
        {locations.length === 0 && <option value="">No active store locations available</option>}
        {locations.map((location) => <option key={location.id} value={location.id}>
          {location.code}{location.name ? ` — ${location.name}` : ""}
        </option>)}
      </select>
      <button type="submit" disabled={saving || !productId || !locationId}>
        {saving ? "Starting count…" : "Assign and start count"}
      </button>
      <Link href={`/store-count?sessionId=${encodeURIComponent(sessionId)}`}>Cancel</Link>
    </form>}
  </main>;
}

export default function StoreCountSetupPage() {
  return <Suspense fallback={<main className="container"><p role="status">Loading count setup…</p></main>}>
    <StoreCountSetup />
  </Suspense>;
}
