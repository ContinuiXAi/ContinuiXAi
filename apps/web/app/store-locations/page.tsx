"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiJson } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";
import { useToast } from "../../lib/toast-context";
import { BrandLockup } from "../../components/BrandLockup";

type StoreLocation = { id: string; code: string; name: string | null; isActive: boolean; sortOrder: number; _count?: { entries: number } };

export default function StoreLocationsPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const { show } = useToast();
  const [locations, setLocations] = useState<StoreLocation[]>([]);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (!loading && !user) router.push("/login"); }, [loading, user, router]);
  async function load() { setLocations(await apiJson<StoreLocation[]>("/api/store-locations?includeInactive=true")); }
  useEffect(() => { if (user) void load(); }, [user]); // eslint-disable-line react-hooks/exhaustive-deps
  const visible = useMemo(() => locations.filter((location) => showInactive || location.isActive), [locations, showInactive]);

  async function addLocation(event: FormEvent) {
    event.preventDefault();
    const trimmedCode = code.trim();
    if (!trimmedCode) return;
    setSaving(true);
    try {
      await apiJson("/api/store-locations", { method: "POST", body: JSON.stringify({ code: trimmedCode, name: name.trim() || null }) });
      setCode(""); setName(""); await load(); show(`${trimmedCode.toUpperCase()} added`, "success");
    } catch (error) { show(error instanceof Error ? error.message : "Could not add location.", "error"); }
    finally { setSaving(false); }
  }

  async function setActive(location: StoreLocation, isActive: boolean) {
    setBusyId(location.id);
    try {
      await apiJson(`/api/store-locations/${location.id}`, { method: "PATCH", body: JSON.stringify({ isActive }) });
      setLocations((rows) => rows.map((row) => (row.id === location.id ? { ...row, isActive } : row)));
      show(`${location.code} ${isActive ? "activated" : "made inactive"}`, "success");
    } catch (error) { show(error instanceof Error ? error.message : "Could not update location.", "error"); }
    finally { setBusyId(null); }
  }

  if (loading || !user) return null;
  return (
    <main className="container" style={{ maxWidth: 680, paddingBottom: 44 }}>
      <header style={{ marginBottom: 18 }}>
        <BrandLockup compact />
        <h1 style={{ margin: "8px 0 6px" }}>Locations</h1>
        <p style={{ margin: 0, opacity: 0.72 }}>Configure the aisles, sections, bins or departments users can select while counting. No free-typed locations during a count.</p>
      </header>
      <form onSubmit={addLocation} style={{ display: "grid", gap: 8, marginBottom: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}><input value={code} onChange={(event) => setCode(event.target.value)} placeholder="Code (A1, Z99, BIN-4)" /><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Description (optional)" /></div>
        <button type="submit" disabled={saving || !code.trim()} style={{ minHeight: 48 }}>{saving ? "Saving…" : "Add location"}</button>
      </form>
      <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, fontSize: 14 }}><input type="checkbox" checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} style={{ width: 18, height: 18 }} />Show inactive locations</label>
      <div style={{ display: "grid", gap: 8 }}>
        {visible.map((location) => <div key={location.id} className="card" style={{ padding: 14, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}><div><strong>{location.code}</strong>{location.name && <span style={{ opacity: 0.7 }}> — {location.name}</span>}<div style={{ fontSize: 12, opacity: 0.65, marginTop: 3 }}>{location._count?.entries ?? 0} count entries · {location.isActive ? "Active" : "Inactive"}</div></div><button type="button" className="secondary" disabled={busyId === location.id} onClick={() => void setActive(location, !location.isActive)}>{location.isActive ? "Make inactive" : "Activate"}</button></div>)}
        {visible.length === 0 && <p style={{ opacity: 0.7 }}>No locations yet. Add the first location above.</p>}
      </div>
    </main>
  );
}
