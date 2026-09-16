"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiJson } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";
import { useToast } from "../../lib/toast-context";
import { ThemeToggle } from "../../components/ThemeToggle";
import { LanguageToggle } from "../../components/LanguageToggle";
import { CurrencyToggle } from "../../components/CurrencyToggle";
import { BrandLockup } from "../../components/BrandLockup";

export default function SettingsPage() {
  const router = useRouter();
  const { user, loading, logout, logoutAll } = useAuth();
  const { show } = useToast();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);

  useEffect(() => { if (!loading && !user) router.push("/login"); }, [loading, user, router]);

  async function handleChangePassword(event: FormEvent) {
    event.preventDefault();
    if (newPassword !== confirmNewPassword) { show("New passwords do not match.", "error"); return; }
    setChangingPassword(true);
    try {
      await apiJson("/api/auth/profile", { method: "PATCH", body: JSON.stringify({ currentPassword, newPassword }) });
      setCurrentPassword(""); setNewPassword(""); setConfirmNewPassword("");
      show("Password changed. Please sign in again.", "success");
      await logout();
    } catch (error) {
      show(error instanceof Error ? error.message : "Could not change password.", "error");
    } finally { setChangingPassword(false); }
  }

  if (loading || !user) return null;
  return (
    <main className="container work-container">
      <header className="work-hero compact"><BrandLockup compact /><h1>Settings</h1><p>{user.name} · {user.email}</p></header>
      <section className="card"><h2>Preferences</h2><ThemeToggle /><LanguageToggle /><CurrencyToggle /></section>
      <section className="card"><h2>Security</h2><form onSubmit={handleChangePassword} className="form-stack"><label>Current password<input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required /></label><label>New password<input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required minLength={12} /></label><label>Confirm new password<input type="password" value={confirmNewPassword} onChange={(e) => setConfirmNewPassword(e.target.value)} required minLength={12} /></label><button type="submit" disabled={changingPassword}>{changingPassword ? "Changing…" : "Change password"}</button></form></section>
      <section className="card"><h2>Session</h2><div className="work-footer-actions"><button type="button" className="secondary" onClick={() => void logout()}>Sign out on this device</button><button type="button" className="secondary" onClick={() => void logoutAll()}>Sign out on all devices</button></div></section>
    </main>
  );
}
