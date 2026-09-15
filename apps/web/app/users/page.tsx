"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiJson } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";
import { useToast } from "../../lib/toast-context";
import { useLocale } from "../../lib/i18n/locale-context";
import type { User } from "../../lib/types";
import { OneTimeSecrets, type OneTimeSecret } from "../../components/OneTimeSecrets";
import { selectedSiteIds, toggleSiteSelection, type SiteAssignment } from "../../lib/siteAssignments";

type OrganizationOption = { id: string; name: string };

export default function UsersPage() {
  const router = useRouter();
  const { user, loading, isAdmin } = useAuth();
  const { show } = useToast();
  const { t } = useLocale();
  const [users, setUsers] = useState<User[]>([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"ADMIN" | "GENERAL">("GENERAL");
  const [organizations, setOrganizations] = useState<OrganizationOption[]>([]);
  const [organizationId, setOrganizationId] = useState("");
  const [organizationLoadError, setOrganizationLoadError] = useState(false);
  const [issuedSecrets, setIssuedSecrets] = useState<OneTimeSecret[] | null>(null);
  const [siteUserId, setSiteUserId] = useState<string | null>(null);
  const [sites, setSites] = useState<SiteAssignment[]>([]);
  const [siteIds, setSiteIds] = useState<string[]>([]);

  useEffect(() => {
    if (!loading && !user) router.push("/login");
    else if (!loading && user && !isAdmin) router.push("/");
  }, [loading, user, isAdmin, router]);

  async function refresh() {
    setUsers(await apiJson<User[]>("/api/auth/users"));
  }

  async function refreshOrganizations() {
    try {
      const available = await apiJson<OrganizationOption[]>("/api/auth/user-organizations");
      setOrganizations(available);
      setOrganizationLoadError(false);
      setOrganizationId((current) => {
        if (available.some(({ id }) => id === current)) return current;
        return available.length === 1 ? available[0].id : "";
      });
    } catch {
      setOrganizations([]);
      setOrganizationId("");
      setOrganizationLoadError(true);
    }
  }

  useEffect(() => {
    if (isAdmin) void Promise.all([refresh(), refreshOrganizations()]);
  }, [isAdmin]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    try {
      await apiJson("/api/auth/users", {
        method: "POST",
        body: JSON.stringify({ name, email, password, role, organizationId }),
      });
      setName("");
      setEmail("");
      setPassword("");
      setRole("GENERAL");
      await refresh();
      show(t("accountCreatedToast"), "success");
    } catch (err: any) {
      show(err.message, "error");
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(t("confirmDeleteAccount"))) return;
    try {
      await apiJson(`/api/auth/users/${id}`, { method: "DELETE" });
      await refresh();
    } catch (err: any) {
      show(err.message, "error");
    }
  }

  async function handleResetPassword(u: User) {
    if (!confirm(t("confirmResetPassword", { name: u.name }))) return;
    try {
      const res = await apiJson<{ email: string; temporaryPassword: string }>(
        `/api/auth/users/${u.id}/reset-password`,
        { method: "POST" },
      );
      setIssuedSecrets([{ label: res.email, value: res.temporaryPassword }]);
    } catch (err: any) {
      show(err.message, "error");
    }
  }

  async function handleResetMfa(u: User) {
    if (!confirm(`Reset ${u.name}'s authenticator? This signs them out everywhere and requires new enrollment.`)) return;
    try {
      await apiJson(`/api/auth/users/${u.id}/reset-mfa`, { method: "POST" });
      await refresh();
      show("Authenticator reset. The user must enroll again at next sign-in.", "success");
    } catch (err: any) {
      show(err.message, "error");
    }
  }

  async function openSiteAssignments(u: User) {
    try {
      const available = await apiJson<SiteAssignment[]>(`/api/site-memberships/users/${u.id}`);
      setSiteUserId(u.id);
      setSites(available);
      setSiteIds(selectedSiteIds(available));
    } catch (err: any) {
      show(err.message, "error");
    }
  }

  async function saveSiteAssignments() {
    if (!siteUserId) return;
    try {
      await apiJson(`/api/site-memberships/users/${siteUserId}`, {
        method: "PUT",
        body: JSON.stringify({ siteIds }),
      });
      show("Site access saved.", "success");
      setSiteUserId(null);
    } catch (err: any) {
      show(err.message, "error");
    }
  }

  if (loading || !user || !isAdmin) return null;

  return (
    <main className="container">
      <h1>{t("usersTitle")}</h1>
      <form onSubmit={handleSubmit} className="form" style={{ marginBottom: 16 }}>
        <input placeholder={t("namePlaceholder")} value={name} onChange={(e) => setName(e.target.value)} required />
        <input type="email" placeholder={t("emailPlaceholder")} value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input
          type="password"
          placeholder={t("passwordMinPlaceholder")}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <label>
          {t("organizationLabel")}
          <select
            name="organizationId"
            value={organizationId}
            onChange={(e) => setOrganizationId(e.target.value)}
            required
          >
            <option value="">{t("selectOrganization")}</option>
            {organizations.map((organization) => (
              <option key={organization.id} value={organization.id}>{organization.name}</option>
            ))}
          </select>
        </label>
        {organizationLoadError && <p role="alert">{t("organizationLoadFailed")}</p>}
        <select value={role} onChange={(e) => setRole(e.target.value as "ADMIN" | "GENERAL")}>
          <option value="GENERAL">{t("roleGeneral")}</option>
          <option value="ADMIN">{t("roleAdmin")}</option>
        </select>
        <button type="submit" disabled={!organizationId || organizationLoadError}>{t("createAccountButton")}</button>
      </form>

      {users.map((u) => (
        <div key={u.id} className="tree-row">
          <div>
            {u.name} ({u.email}) <span className="badge badge-muted">{u.role === "ADMIN" ? t("roleAdmin") : t("roleGeneral")}</span>
          </div>
          {u.id !== user.id && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="secondary" onClick={() => void handleResetPassword(u)}>
                {t("resetPasswordButton")}
              </button>
              <button type="button" className="secondary" onClick={() => void openSiteAssignments(u)}>
                Manage sites
              </button>
              <button type="button" className="secondary" onClick={() => void handleResetMfa(u)} disabled={!u.mfaEnabled}>
                Reset authenticator
              </button>
              <button type="button" className="secondary" onClick={() => void handleDelete(u.id)}>
                {t("delete")}
              </button>
            </div>
          )}
          {siteUserId === u.id && (
            <div style={{ width: "100%", marginTop: 10, padding: 12, border: "1px solid var(--color-border)", borderRadius: 8 }}>
              <strong>Authorized sites</strong>
              {sites.map((site) => (
                <label key={site.id} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                  <input
                    type="checkbox"
                    checked={siteIds.includes(site.id)}
                    onChange={(event) => setSiteIds(toggleSiteSelection(siteIds, site.id, event.target.checked))}
                  />
                  {site.code} — {site.name}
                </label>
              ))}
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button type="button" onClick={() => void saveSiteAssignments()} disabled={siteIds.length === 0}>Save site access</button>
                <button type="button" className="secondary" onClick={() => setSiteUserId(null)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      ))}

      {issuedSecrets && (
        <OneTimeSecrets
          title={t("resetPasswordTitle")}
          hint={t("resetPasswordHint")}
          secrets={issuedSecrets}
          downloadFilename={`continuixai-ops-reset-password_${issuedSecrets[0]?.label ?? "user"}.txt`}
          onClose={() => setIssuedSecrets(null)}
        />
      )}
    </main>
  );
}
