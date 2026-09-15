"use client";

import Link from "next/link";
import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { API_URL } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";
import { BRAND_NAME } from "../../lib/brand";
import { BrandLockup } from "../../components/BrandLockup";

type Stage = "password" | "setup" | "verify" | "backup";

const pageStyle: CSSProperties = { minHeight: "100vh", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "42px 18px 28px" };
const cardStyle: CSSProperties = { width: "100%", maxWidth: 470, background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 18, padding: "28px 28px 24px", boxShadow: "0 10px 30px rgba(0,0,0,0.08)" };
const brandStyle: CSSProperties = { fontSize: 25, lineHeight: 1.15, fontWeight: 750, margin: 0, letterSpacing: "-0.02em" };
const taglineStyle: CSSProperties = { fontSize: 14, lineHeight: 1.45, color: "var(--color-text-muted)", margin: "7px 0 24px" };
const titleStyle: CSSProperties = { fontSize: 20, lineHeight: 1.25, margin: "0 0 6px" };
const helperStyle: CSSProperties = { fontSize: 14, lineHeight: 1.45, color: "var(--color-text-secondary)", margin: "0 0 16px" };
const fieldStyle: CSSProperties = { fontSize: 16, minHeight: 46, padding: "10px 12px" };
const showStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--color-text-secondary)", width: "fit-content" };

function AuthShell({ children }: { children: React.ReactNode }) {
  return <main style={pageStyle}><section style={cardStyle}><div style={{ marginBottom: 24 }}><BrandLockup /></div>{children}</section></main>;
}

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [name, setName] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkingBootstrap, setCheckingBootstrap] = useState(true);
  const [needsBootstrap, setNeedsBootstrap] = useState(false);
  const [stage, setStage] = useState<Stage>("password");
  const [challengeToken, setChallengeToken] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [manualSecret, setManualSecret] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [pendingToken, setPendingToken] = useState("");

  useEffect(() => {
    fetch(`${API_URL}/api/auth/bootstrap/status`)
      .then((res) => (res.ok ? res.json() : { needsBootstrap: false }))
      .then((data: { needsBootstrap: boolean }) => setNeedsBootstrap(data.needsBootstrap))
      .catch(() => setNeedsBootstrap(false))
      .finally(() => setCheckingBootstrap(false));
  }, []);

  async function beginMfa(data: { challengeToken: string; enrollmentRequired: boolean }) {
    setChallengeToken(data.challengeToken); setError(null);
    if (data.enrollmentRequired) {
      const setupRes = await fetch(`${API_URL}/api/auth/mfa/setup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ challengeToken: data.challengeToken }) });
      const setup = await setupRes.json();
      if (!setupRes.ok) throw new Error(setup.error || "Unable to start MFA setup.");
      setManualSecret(setup.secret); setStage("setup");
    } else setStage("verify");
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault(); setError(null); setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier, password }) });
      if (!res.ok) { setError("Incorrect email, employee number, or password."); return; }
      await beginMfa(await res.json());
    } catch (err) { setError(err instanceof Error ? err.message : `Unable to connect to ${BRAND_NAME}. Please try again.`); }
    finally { setLoading(false); }
  }

  async function handleBootstrapSubmit(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (password !== confirmPassword) { setError("Passwords do not match."); return; }
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/auth/bootstrap/admin`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, email: identifier, password }) });
      if (!res.ok) {
        if (res.status === 409) { setNeedsBootstrap(false); setError("An administrator account already exists. Please sign in."); return; }
        setError("Unable to create the administrator account."); return;
      }
      setNeedsBootstrap(false);
      const loginRes = await fetch(`${API_URL}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier, password }) });
      if (!loginRes.ok) { setError("Account created, but sign-in failed. Please sign in again."); return; }
      await beginMfa(await loginRes.json());
    } catch (err) { setError(err instanceof Error ? err.message : `Unable to connect to ${BRAND_NAME}. Please try again.`); }
    finally { setLoading(false); }
  }

  async function confirmEnrollment(e: FormEvent) {
    e.preventDefault(); setError(null); setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/auth/mfa/confirm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ challengeToken, code: mfaCode }) });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "That verification code is not correct."); return; }
      setBackupCodes(data.backupCodes || []); setPendingToken(data.token); setStage("backup");
    } catch { setError("Unable to verify MFA. Please try again."); }
    finally { setLoading(false); }
  }

  async function verifyMfa(e: FormEvent) {
    e.preventDefault(); setError(null); setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/auth/mfa/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ challengeToken, code: mfaCode }) });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "That verification code is not correct."); return; }
      await login(data.token); router.push("/");
    } catch { setError("Unable to verify MFA. Please try again."); }
    finally { setLoading(false); }
  }

  async function finishEnrollment() { await login(pendingToken); router.push("/"); }

  if (checkingBootstrap) return <AuthShell><p style={taglineStyle}>Connecting securely...</p></AuthShell>;
  if (stage === "setup") return <AuthShell><h1 style={brandStyle}>Secure Your Account</h1><p style={helperStyle}>Open Google Authenticator, tap <strong>+</strong>, choose <strong>Enter a setup key</strong>, and enter the key below. Then enter the 6-digit code Google Authenticator shows.</p><p style={{ ...helperStyle, marginBottom: 6 }}><strong>Google Authenticator setup key</strong></p><code style={{ wordBreak: "break-all", fontSize: 13 }}>{manualSecret}</code><form onSubmit={confirmEnrollment} className="form" style={{ marginTop: 18 }}><input style={fieldStyle} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={6} placeholder="6-digit verification code" value={mfaCode} onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, "").slice(0, 6))} required /><button type="submit" disabled={loading || mfaCode.length !== 6}>{loading ? "Verifying..." : "Verify and Enable MFA"}</button>{error && <p className="error-text">{error}</p>}</form></AuthShell>;
  if (stage === "verify") return <AuthShell><h1 style={brandStyle}>Multi-Factor Verification</h1><p style={helperStyle}>Enter the 6-digit code from your authenticator app, or use a backup code.</p><form onSubmit={verifyMfa} className="form"><input style={fieldStyle} autoFocus autoComplete="one-time-code" placeholder="6-digit code or backup code" value={mfaCode} onChange={(e) => setMfaCode(e.target.value.toUpperCase())} required /><button type="submit" disabled={loading}>{loading ? "Verifying..." : "Verify & Sign In"}</button>{error && <p className="error-text">{error}</p>}</form><button type="button" className="secondary" onClick={() => { setStage("password"); setMfaCode(""); setPassword(""); }} style={{ marginTop: 12, width: "100%" }}>Back to Sign In</button></AuthShell>;
  if (stage === "backup") return <AuthShell><h1 style={brandStyle}>MFA Is Enabled</h1><p style={helperStyle}><strong>Save these backup codes now.</strong> Each code can be used once if you lose access to your authenticator app.</p><div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, margin: "18px 0" }}>{backupCodes.map((code) => <code key={code} style={{ fontSize: 14, padding: 8, background: "var(--color-surface-hover)", borderRadius: 8 }}>{code}</code>)}</div><button type="button" onClick={finishEnrollment} style={{ width: "100%" }}>I Saved My Backup Codes — Continue</button></AuthShell>;

  return <AuthShell>{needsBootstrap ? <><h2 style={titleStyle}>Create Administrator</h2><p style={helperStyle}>Create the first administrator account. Multi-factor authentication will be required immediately after setup.</p><form onSubmit={handleBootstrapSubmit} className="form"><input style={fieldStyle} type="text" autoComplete="name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required /><input style={fieldStyle} type="email" inputMode="email" autoComplete="email" placeholder="Email" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required /><input style={fieldStyle} type={showPassword ? "text" : "password"} autoComplete="new-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required /><input style={fieldStyle} type={showPassword ? "text" : "password"} autoComplete="new-password" placeholder="Confirm password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required /><label style={showStyle}><input type="checkbox" checked={showPassword} onChange={(e) => setShowPassword(e.target.checked)} />Show password</label><button type="submit" disabled={loading}>{loading ? "Creating account..." : "Create Administrator"}</button>{error && <p className="error-text">{error}</p>}</form></> : <><h2 style={titleStyle}>Sign In</h2><p style={helperStyle}>Enter your email address or Employee Number. You’ll verify with MFA next.</p><form onSubmit={handleSubmit} className="form"><input style={fieldStyle} type="text" autoCapitalize="none" autoComplete="username" placeholder="Email or Employee Number" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required /><input style={fieldStyle} type={showPassword ? "text" : "password"} autoComplete="current-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required /><label style={showStyle}><input type="checkbox" checked={showPassword} onChange={(e) => setShowPassword(e.target.checked)} />Show password</label><button type="submit" disabled={loading}>{loading ? "Signing in..." : "Sign In"}</button>{error && <p className="error-text" style={{ margin: "2px 0 0" }}>{error}</p>}</form><div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--color-border)", display: "grid", gap: 9, fontSize: 14 }}><Link href="/register"><strong>Create a New Account</strong></Link><Link href="/forgot-user-id">Forgot User ID / Employee Number?</Link><Link href="/forgot-password">Forgot Password?</Link><Link href="/help">Need Help?</Link></div></>}</AuthShell>;
}
