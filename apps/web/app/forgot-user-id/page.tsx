"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { API_URL } from "../../lib/api";
import { BRAND_NAME } from "../../lib/brand";
import { BrandLockup } from "../../components/BrandLockup";

export default function ForgotUserIdPage() {
  const [email, setEmail] = useState("");
  const [pin, setPin] = useState("");
  const [employeeNumber, setEmployeeNumber] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setEmployeeNumber(null);
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/auth/recover/user-id`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, recoveryPin: pin }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError("We could not verify that account. Check your email and Recovery PIN, or use Need Help."); return; }
      setEmployeeNumber(data.employeeNumber || "No Employee Number is assigned to this older account.");
    } catch {
      setError(`Unable to connect to ${BRAND_NAME}. Please try again.`);
    } finally { setLoading(false); }
  }

  return (
    <main className="container">
      <div style={{ margin: "24px 0" }}><BrandLockup /></div>
      <h1>Forgot User ID?</h1>
      <p>Verify your identity with your email address and 6-digit Recovery PIN.</p>
      <form onSubmit={submit} className="form">
        <input type="email" inputMode="email" autoComplete="email" placeholder="Email address" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input type="password" inputMode="numeric" autoComplete="off" placeholder="6-digit Recovery PIN" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))} pattern="\d{6}" required />
        <button type="submit" disabled={loading}>{loading ? "Verifying..." : "Recover Employee Number"}</button>
      </form>
      {employeeNumber && <p><strong>Your Employee Number: {employeeNumber}</strong></p>}
      {error && <p className="error-text">{error}</p>}
      <p><Link href="/login">Back to Sign In</Link> · <Link href="/help">Need Help?</Link></p>
    </main>
  );
}
