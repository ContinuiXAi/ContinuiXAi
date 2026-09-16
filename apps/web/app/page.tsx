"use client";

import Link from "next/link";
import { BrandLockup } from "../components/BrandLockup";
import { useAuth } from "../lib/auth-context";

const launchers = [
  { href: "/store-count", title: "Count", description: "Start or resume inventory counting" },
  { href: "/my-work", title: "My Work", description: "See today's assigned work" },
  { href: "/store-products", title: "Products", description: "Find and manage products" },
  { href: "/store-locations", title: "Locations", description: "View store locations and zones" },
] as const;

function daypart(hour: number) {
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

export default function HomePage() {
  const { user, loading, logout } = useAuth();

  if (loading) {
    return (
      <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
        <section style={{ textAlign: "center" }}>
          <BrandLockup />
          <p style={{ color: "var(--color-text-muted)", marginTop: 18 }}>Connecting securely...</p>
        </section>
      </main>
    );
  }

  if (!user) {
    return (
      <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
        <section style={{ width: "100%", maxWidth: 470, textAlign: "center", background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 22, padding: "36px 26px", boxShadow: "0 10px 30px rgba(0,0,0,0.08)" }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 26 }}><BrandLockup /></div>
          <h1 style={{ fontSize: 30, lineHeight: 1.15, margin: "0 0 12px" }}>Welcome to ContinuiXai</h1>
          <p style={{ color: "var(--color-text-secondary)", fontSize: 16, lineHeight: 1.5, margin: "0 0 26px" }}>Smarter store operations, inventory, and teamwork.</p>
          <Link href="/login" className="button" style={{ minHeight: 50, display: "grid", placeItems: "center", textDecoration: "none", fontSize: 17 }}>Sign In</Link>
        </section>
      </main>
    );
  }

  const firstName = user.name.trim().split(/\s+/)[0] || "there";
  const greeting = `Good ${daypart(new Date().getHours())}, ${firstName} — ready to start working?`;

  return (
    <main style={{ maxWidth: 820, margin: "0 auto", padding: "32px 18px 110px" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 34 }}>
        <BrandLockup />
        <button type="button" className="secondary" onClick={() => void logout()} style={{ width: "auto", minHeight: 42, padding: "8px 14px" }}>Sign Out</button>
      </header>
      <section style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: "clamp(26px, 5vw, 38px)", lineHeight: 1.15, letterSpacing: "-0.025em", margin: "0 0 10px" }}>{greeting}</h1>
        <p style={{ color: "var(--color-text-secondary)", fontSize: 16, margin: 0 }}>Choose where you want to work.</p>
      </section>
      <section aria-label="ContinuiXai applications" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
        {launchers.map((launcher) => (
          <Link key={launcher.href} href={launcher.href} style={{ minHeight: 150, display: "flex", flexDirection: "column", justifyContent: "center", padding: 24, border: "1px solid var(--color-border)", borderRadius: 20, background: "var(--color-surface)", boxShadow: "0 8px 24px rgba(0,0,0,0.06)", textDecoration: "none" }}>
            <strong style={{ fontSize: 25, lineHeight: 1.2, color: "var(--color-text)" }}>{launcher.title}</strong>
            <span style={{ marginTop: 9, fontSize: 15, lineHeight: 1.4, color: "var(--color-text-secondary)" }}>{launcher.description}</span>
          </Link>
        ))}
      </section>
    </main>
  );
}
