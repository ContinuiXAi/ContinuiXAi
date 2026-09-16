"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiJson } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";
import type { DailySummaryResponse } from "../../lib/types";
import { BrandLockup } from "../../components/BrandLockup";

export default function DailySummaryPage() {
  const router = useRouter();
  const { user, loading, logout } = useAuth();
  const [summary, setSummary] = useState<DailySummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => { if (!loading && !user) router.replace("/login"); }, [loading, user, router]);
  useEffect(() => {
    if (!user) return;
    apiJson<DailySummaryResponse>("/api/tasks/me/summary")
      .then((value) => { setSummary(value); setError(null); })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load today’s summary."));
  }, [user]);

  async function signOut() {
    setSigningOut(true);
    try { await logout(); } finally { setSigningOut(false); }
  }

  if (loading || !user) return null;
  const firstName = user.name.trim().split(/\s+/)[0] || user.name;

  return (
    <main className="container work-container">
      <header className="work-hero compact">
        <BrandLockup compact />
        <h1>Here&apos;s what you accomplished today. Great job, {firstName}!</h1>
        {summary && <p>{summary.site.name || summary.site.code} · {summary.date}</p>}
      </header>

      {error && <section className="card"><p className="error-text">{error}</p></section>}
      {!summary && !error && <section className="card"><p>Building your daily summary…</p></section>}

      {summary && (
        <>
          <section className="summary-grid" aria-label="Daily accomplishments">
            <div className="summary-stat"><strong>{summary.tasks.completed.length}</strong><span>Tasks completed</span></div>
            <div className="summary-stat"><strong>{summary.counts.sessionsCompleted}</strong><span>Count sessions</span></div>
            <div className="summary-stat"><strong>{summary.counts.locationsCounted}</strong><span>Locations counted</span></div>
            <div className="summary-stat"><strong>{summary.counts.uniqueProducts}</strong><span>Products counted</span></div>
            <div className="summary-stat"><strong>{summary.counts.unitsCounted}</strong><span>Units counted</span></div>
            <div className="summary-stat"><strong>{summary.counts.durationMinutes}</strong><span>Count minutes</span></div>
          </section>

          <section className="work-section">
            <div className="work-section-heading"><h2>Completed work</h2><span>{summary.tasks.completed.length}</span></div>
            {summary.tasks.completed.length === 0 ? <p className="work-empty">No tasks were completed today.</p> : summary.tasks.completed.map((task) => <div className="work-summary-row" key={task.id}><strong>{task.title}</strong><span>Completed</span></div>)}
          </section>

          <section className="work-section">
            <div className="work-section-heading"><h2>Skipped today</h2><span>{summary.tasks.skipped.length}</span></div>
            {summary.tasks.skipped.length === 0 ? <p className="work-empty">No work was skipped today.</p> : summary.tasks.skipped.map((task) => <div className="work-summary-row" key={task.id}><strong>{task.title}</strong><span>Skipped</span></div>)}
          </section>

          <section className="work-section">
            <div className="work-section-heading"><h2>Still open</h2><span>{summary.tasks.open.length}</span></div>
            {summary.tasks.open.length === 0 ? <p className="work-empty">No open work.</p> : summary.tasks.open.slice(0, 12).map((task) => <div className="work-summary-row" key={task.id}><strong>{task.title}</strong><span>{task.status === "IN_PROGRESS" ? "In progress" : "Open"}</span></div>)}
            {summary.tasks.overdueCount > 0 && <p className="work-overdue-note">{summary.tasks.overdueCount} overdue task{summary.tasks.overdueCount === 1 ? "" : "s"} remain open. Signing out will not mark them complete.</p>}
          </section>

          {summary.tasks.nextUpcoming && (
            <section className="card"><strong>Next upcoming task</strong><p style={{ marginBottom: 0 }}>{summary.tasks.nextUpcoming.title}</p></section>
          )}

          <div className="work-footer-actions">
            <Link href="/my-work" className="work-link-button secondary-link">Back to My Work</Link>
            <button type="button" disabled={signingOut} onClick={() => void signOut()}>{signingOut ? "Signing out…" : "Sign out"}</button>
          </div>
        </>
      )}
    </main>
  );
}
