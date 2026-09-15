"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { API_URL } from "../../lib/api";
import { BRAND_NAME } from "../../lib/brand";
import { BrandLockup } from "../../components/BrandLockup";
import { loadPublicRegistrationStatus } from "../../lib/publicRegistration";

const SPECIALS = "!@#$%^&*";

function passwordError(password: string): string | null {
  if (password.length < 10) return "Password must be at least 10 characters.";
  if (/^\d/.test(password)) return "Password must not start with a number.";
  if (!/[A-Z]/.test(password)) return "Password must include at least one uppercase letter.";
  if (!/[a-z]/.test(password)) return "Password must include at least one lowercase letter.";
  if (!/\d/.test(password)) return "Password must include at least one number.";
  if (!/[!@#$%^&*]/.test(password)) return `Password must include at least one special character: ${SPECIALS.split("").join(" ")}.`;
  return null;
}

function responseError(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error;
  if (!error || typeof error !== "object") return "Unable to create account.";

  const details = error as { formErrors?: unknown; fieldErrors?: Record<string, unknown> };
  const messages = [
    ...(Array.isArray(details.formErrors) ? details.formErrors : []),
    ...Object.values(details.fieldErrors ?? {}).flatMap((value) => Array.isArray(value) ? value : []),
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return messages[0] ?? "Unable to create account.";
}

type CreatedAccount = {
  employeeNumber: string;
  email: string;
};

export default function RegisterPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [recoveryPin, setRecoveryPin] = useState("");
  const [showPasswords, setShowPasswords] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [createdAccount, setCreatedAccount] = useState<CreatedAccount | null>(null);
  const [registrationEnabled, setRegistrationEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    void loadPublicRegistrationStatus(API_URL).then(setRegistrationEnabled);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const ruleError = passwordError(password);
    if (ruleError) return setError(ruleError);
    if (password !== confirmPassword) return setError("Passwords do not match.");
    if (!/^\d{6}$/.test(recoveryPin)) return setError("Recovery PIN must be exactly 6 digits.");
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password, recoveryPin }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(responseError(data.error));
        return;
      }
      setCreatedAccount({ employeeNumber: data.employeeNumber, email: data.email });
    } catch {
      setError(`Unable to connect to ${BRAND_NAME}. Please try again.`);
    } finally {
      setLoading(false);
    }
  }

  if (createdAccount) {
    return (
      <main className="container">
        <section style={{ maxWidth: 560, margin: "32px auto", padding: 24, border: "1px solid var(--color-border)", borderRadius: 16, background: "var(--color-surface)" }}>
          <div style={{ marginBottom: 24 }}><BrandLockup /></div>
          <h1>Account Created</h1>
          <p>Your {BRAND_NAME} account is ready. Save this Employee Number with your Recovery PIN.</p>
          <div style={{ margin: "20px 0", padding: 18, borderRadius: 12, background: "var(--color-surface-hover)", textAlign: "center" }}>
            <p style={{ margin: "0 0 6px", fontSize: 14 }}>Your Employee Number</p>
            <strong style={{ fontSize: 24, letterSpacing: "0.04em" }}>{createdAccount.employeeNumber}</strong>
          </div>
          <p style={{ fontSize: 14 }}>Sign in with <strong>{createdAccount.email}</strong> or your Employee Number. You will secure the account with multi-factor authentication next.</p>
          <Link href="/login" style={{ display: "block", marginTop: 20 }}><button type="button" style={{ width: "100%" }}>Continue to Sign In</button></Link>
        </section>
      </main>
    );
  }

  if (registrationEnabled !== true) {
    return (
      <main className="container">
        <section style={{ maxWidth: 560, margin: "32px auto", padding: 24, border: "1px solid var(--color-border)", borderRadius: 16, background: "var(--color-surface)" }}>
          <div style={{ marginBottom: 24 }}><BrandLockup /></div>
          <h1>{registrationEnabled === null ? "Checking account access…" : "Administrator Approval Required"}</h1>
          {registrationEnabled === false && (
            <>
              <p>Public account creation is disabled to protect store inventory.</p>
              <p>Ask your ContinuiXAi administrator to create your employee account.</p>
              <Link href="/login"><button type="button">Return to Sign In</button></Link>
            </>
          )}
        </section>
      </main>
    );
  }

  return (
    <main className="container">
      <div style={{ margin: "24px 0" }}><BrandLockup /></div>
      <h1>Create a New Account</h1>
      <p>{BRAND_NAME} will automatically assign you a unique Employee Number.</p>
      <form onSubmit={submit} className="form">
        <input type="text" autoComplete="name" placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} required />
        <input type="email" inputMode="email" autoComplete="email" placeholder="Email address" value={email} onChange={(e) => setEmail(e.target.value)} required />

        <div style={{ padding: "12px 14px", border: "1px solid #555", borderRadius: 8 }}>
          <strong>Password requirements</strong>
          <ul style={{ margin: "8px 0 0", paddingLeft: 22, lineHeight: 1.6 }}>
            <li>At least 10 characters</li>
            <li>Must not start with a number</li>
            <li>At least one uppercase letter (A-Z)</li>
            <li>At least one lowercase letter (a-z)</li>
            <li>At least one number (0-9)</li>
            <li>At least one special character: ! @ # $ % ^ &amp; *</li>
          </ul>
        </div>

        <input type={showPasswords ? "text" : "password"} autoComplete="new-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={10} required />
        <input type={showPasswords ? "text" : "password"} autoComplete="new-password" placeholder="Confirm password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} minLength={10} required />
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input type="checkbox" checked={showPasswords} onChange={(e) => setShowPasswords(e.target.checked)} />
          Show password
        </label>

        <input type="password" inputMode="numeric" autoComplete="off" placeholder="6-digit Recovery PIN" value={recoveryPin} onChange={(e) => setRecoveryPin(e.target.value.replace(/\D/g, "").slice(0, 6))} pattern="\d{6}" required />
        <p style={{ fontSize: 14 }}>Your Recovery PIN verifies you if you forget your Employee Number or password. Do not share it.</p>
        <button type="submit" disabled={loading}>{loading ? "Creating account..." : "Create Account"}</button>
        {error && <p className="error-text" role="alert" aria-live="polite">{error}</p>}
      </form>
      <p style={{ marginTop: 18 }}><Link href="/login">Already have an account? Sign in now</Link></p>
    </main>
  );
}
