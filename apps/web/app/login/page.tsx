"use client";

import Link from "next/link";
import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { API_URL } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";
import { BRAND_NAME } from "../../lib/brand";
import { BrandLockup } from "../../components/BrandLockup";

type Stage = "password" | "setup" | "verify" | "backup";
type BackupCodeDocument = {
  accountHolderName: string;
  loginEmail: string;
  employeeNumber: string | null;
  organizations: Array<{ id: string; name: string }>;
  generatedAt: string;
};

const pageStyle: CSSProperties = { minHeight: "100vh", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "42px 18px 28px" };
const cardStyle: CSSProperties = { width: "100%", maxWidth: 470, background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 18, padding: "28px 28px 24px", boxShadow: "0 10px 30px rgba(0,0,0,0.08)" };
const brandStyle: CSSProperties = { fontSize: 25, lineHeight: 1.15, fontWeight: 750, margin: 0, letterSpacing: "-0.02em" };
const taglineStyle: CSSProperties = { fontSize: 14, lineHeight: 1.45, color: "var(--color-text-muted)", margin: "7px 0 24px" };
const titleStyle: CSSProperties = { fontSize: 20, lineHeight: 1.25, margin: "0 0 6px" };
const helperStyle: CSSProperties = { fontSize: 14, lineHeight: 1.45, color: "var(--color-text-secondary)", margin: "0 0 16px" };
const fieldStyle: CSSProperties = { fontSize: 16, minHeight: 46, padding: "10px 12px" };
const showStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--color-text-secondary)", width: "fit-content" };
const backupIdentityStyle: CSSProperties = { display: "grid", gridTemplateColumns: "max-content minmax(0, 1fr)", gap: "8px 14px", margin: "18px 0", padding: 14, border: "1px solid var(--color-border)", borderRadius: 10, fontSize: 14 };

function displayGeneratedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

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
  const [backupCodeDocument, setBackupCodeDocument] = useState<BackupCodeDocument | null>(null);
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
      setBackupCodes(data.backupCodes || []);
      setBackupCodeDocument(data.backupCodeDocument ?? {
        accountHolderName: data.user?.name || "Unknown",
        loginEmail: data.user?.email || identifier,
        employeeNumber: data.user?.employeeNumber ?? null,
        organizations: [],
        generatedAt: new Date().toISOString(),
      });
      setPendingToken(data.token); setStage("backup");
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
  if (stage === "setup") return <AuthShell><h1 style={brandStyle}>Secure Your Account</h1><p style={helperStyle}>Open Google Authenticator, tap <strong>+</strong>, choose <strong>Enter a setup key</strong>, and enter the key below. Then enter the 6-digit code Google Authenticator shows.</p><p style={{ ...helperStyle, marginBottom: 6 }}><strong>Google Authenticator setup key</strong></p><code style={{ wordBreak: "break-all", fontSize: 13 }}>{manualSecret}</code><form onSubmit={confirmEnrollment} className="form" style={{ marginTop: 18 }}><input style={fieldStyle} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={6} placeholder="6-digit verification code" aria-label="6-digit verification code" value={mfaCode} onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, "").slice(0, 6))} required /><button type="submit" disabled={loading || mfaCode.length !== 6}>{loading ? "Verifying..." : "Verify and Enable MFA"}</button>{error && <p className="error-text" role="alert">{error}</p>}</form></AuthShell>;
  if (stage === "verify") return <AuthShell><h1 style={brandStyle}>Multi-Factor Verification</h1><p style={helperStyle}>Enter the 6-digit code from your authenticator app, or use a backup code.</p><form onSubmit={verifyMfa} className="form"><input style={fieldStyle} autoFocus autoComplete="one-time-code" placeholder="6-digit code or backup code" aria-label="6-digit code or backup code" value={mfaCode} onChange={(e) => setMfaCode(e.target.value.toUpperCase())} required /><button type="submit" disabled={loading}>{loading ? "Verifying..." : "Verify & Sign In"}</button>{error && <p className="error-text" role="alert">{error}</p>}</form><button type="button" className="secondary" onClick={() => { setStage("password"); setMfaCode(""); setPassword(""); }} style={{ marginTop: 12, width: "100%" }}>Back to Sign In</button></AuthShell>;
  if (stage === "backup") {
    const organizationNames = backupCodeDocument?.organizations.map((organization) => organization.name) ?? [];
    return <AuthShell><section className="mfa-backup-document" aria-labelledby="mfa-backup-title"><h1 id="mfa-backup-title" style={brandStyle}>MFA Emergency Backup Codes</h1><p style={{ ...helperStyle, marginTop: 8 }}><strong>MFA is enabled.</strong> Save or print this page and keep it in a secure place.</p><dl style={backupIdentityStyle}><dt><strong>Account holder</strong></dt><dd>{backupCodeDocument?.accountHolderName || "Unknown"}</dd><dt><strong>Login email</strong></dt><dd>{backupCodeDocument?.loginEmail || "Unknown"}</dd>{backupCodeDocument?.employeeNumber && <><dt><strong>Employee number</strong></dt><dd>{backupCodeDocument.employeeNumber}</dd></>}<dt><strong>Company</strong></dt><dd>{organizationNames.length > 0 ? organizationNames.join(", ") : "Not yet assigned"}</dd><dt><strong>Generated</strong></dt><dd><time dateTime={backupCodeDocument?.generatedAt}>{backupCodeDocument ? displayGeneratedAt(backupCodeDocument.generatedAt) : "Unknown"}</time></dd></dl><div className="mfa-backup-codes" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, margin: "18px 0" }}>{backupCodes.map((code) => <code className="mfa-backup-code" key={code} style={{ fontSize: 14, padding: 8, background: "var(--color-surface-hover)", borderRadius: 8 }}>{code}</code>)}</div><p className="mfa-backup-warning" style={{ ...helperStyle, padding: 12, border: "1px solid var(--color-warning-border)", borderRadius: 9, background: "var(--color-warning-bg)", color: "var(--color-warning-text)" }}><strong>Keep these private.</strong> Each backup code works only once. Do not store this page with your password.</p><p style={{ textAlign: "center", color: "var(--color-text-muted)", fontSize: 12 }}>Powered by {BRAND_NAME}</p><div className="mfa-backup-actions" style={{ display: "grid", gap: 9 }}><button type="button" className="secondary" onClick={() => window.print()}>Print Backup Codes</button><button type="button" onClick={finishEnrollment}>I Saved My Backup Codes — Continue</button></div></section></AuthShell>;
  }

  return <AuthShell>{needsBootstrap ? <><h2 style={titleStyle}>Create Administrator</h2><p style={helperStyle}>Create the first administrator account. Multi-factor authentication will be required immediately after setup.</p><form onSubmit={handleBootstrapSubmit} className="form"><input style={fieldStyle} type="text" autoComplete="name" placeholder="Name" aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} required /><input style={fieldStyle} type="email" inputMode="email" autoComplete="email" placeholder="Email" aria-label="Email" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required /><input style={fieldStyle} type={showPassword ? "text" : "password"} autoComplete="new-password" placeholder="Password" aria-label="Password" value={password} onChange={(e) => setPassword(e.target.value)} required /><input style={fieldStyle} type={showPassword ? "text" : "password"} autoComplete="new-password" placeholder="Confirm password" aria-label="Confirm password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required /><label style={showStyle}><input type="checkbox" checked={showPassword} onChange={(e) => setShowPassword(e.target.checked)} />Show password</label><button type="submit" disabled={loading}>{loading ? "Creating account..." : "Create Administrator"}</button>{error && <p className="error-text" role="alert">{error}</p>}</form></> : <><h2 style={titleStyle}>Sign In</h2><p style={helperStyle}>Enter your email address or Employee Number. You’ll verify with MFA next.</p><form onSubmit={handleSubmit} className="form"><input style={fieldStyle} type="text" autoCapitalize="none" autoComplete="username" placeholder="Email or Employee Number" aria-label="Email or Employee Number" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required /><input style={fieldStyle} type={showPassword ? "text" : "password"} autoComplete="current-password" placeholder="Password" aria-label="Password" value={password} onChange={(e) => setPassword(e.target.value)} required /><label style={showStyle}><input type="checkbox" checked={showPassword} onChange={(e) => setShowPassword(e.target.checked)} />Show password</label><button type="submit" disabled={loading}>{loading ? "Signing in..." : "Sign In"}</button>{error && <p className="error-text" role="alert" style={{ margin: "2px 0 0" }}>{error}</p>}</form><div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--color-border)", display: "grid", gap: 9, fontSize: 14 }}><Link href="/register"><strong>Create a New Account</strong></Link><Link href="/forgot-user-id">Forgot User ID / Employee Number?</Link><Link href="/forgot-password">Forgot Password?</Link><Link href="/help">Need Help?</Link></div></>}</AuthShell>;
}
