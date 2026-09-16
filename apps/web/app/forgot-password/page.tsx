"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { API_URL } from "../../lib/api";
import { BRAND_NAME } from "../../lib/brand";
import { BrandLockup } from "../../components/BrandLockup";

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

export default function ForgotPasswordPage() {
  const [identifier, setIdentifier] = useState("");
  const [pin, setPin] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPasswords, setShowPasswords] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    const ruleError = passwordError(password);
    if (ruleError) return setError(ruleError);
    if (password !== confirmPassword) return setError("Passwords do not match.");
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/auth/recover/password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, recoveryPin: pin, newPassword: password }),
      });
      if (!res.ok) { setError("We could not verify that account. Check your information, or use Need Help."); return; }
      setMessage("Password changed successfully. You can sign in now with your new password.");
      setPassword("");
      setConfirmPassword("");
    } catch {
      setError(`Unable to connect to ${BRAND_NAME}. Please try again.`);
    } finally { setLoading(false); }
  }

  return (
    <main className="container">
      <div style={{ margin: "24px 0" }}><BrandLockup /></div>
      <h1>Forgot Password?</h1>
      <p>Verify your identity with your email or Employee Number and your 6-digit Recovery PIN.</p>
      <form onSubmit={submit} className="form">
        <input type="text" autoCapitalize="none" autoComplete="username" placeholder="Email or Employee Number" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required />
        <input type="password" inputMode="numeric" autoComplete="off" placeholder="6-digit Recovery PIN" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))} pattern="\d{6}" required />
        <div style={{ padding: "12px 14px", border: "1px solid #555", borderRadius: 8 }}>
          <strong>New password requirements</strong>
          <ul style={{ margin: "8px 0 0", paddingLeft: 22, lineHeight: 1.6 }}>
            <li>At least 10 characters</li><li>Must not start with a number</li><li>At least one uppercase letter (A-Z)</li><li>At least one lowercase letter (a-z)</li><li>At least one number (0-9)</li><li>At least one special character: ! @ # $ % ^ &amp; *</li>
          </ul>
        </div>
        <input type={showPasswords ? "text" : "password"} autoComplete="new-password" placeholder="New password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={10} required />
        <input type={showPasswords ? "text" : "password"} autoComplete="new-password" placeholder="Confirm new password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} minLength={10} required />
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}><input type="checkbox" checked={showPasswords} onChange={(e) => setShowPasswords(e.target.checked)} />Show password</label>
        <button type="submit" disabled={loading}>{loading ? "Changing password..." : "Verify & Change Password"}</button>
      </form>
      {message && <p><strong>{message}</strong></p>}
      {error && <p className="error-text">{error}</p>}
      <p><Link href="/login">Back to Sign In</Link> · <Link href="/help">Need Help?</Link></p>
    </main>
  );
}
