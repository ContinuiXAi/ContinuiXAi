import { describe, expect, it, vi } from "vitest";
import { lockActorOrganizationAccess, lockSiteAndMembership } from "./accessLocking.js";

function sql(strings: TemplateStringsArray) {
  return strings.join(" ").replace(/\s+/g, " ").trim();
}

describe("authorization lock ordering", () => {
  it("locks organization, actor, organization membership, site, then site membership", async () => {
    const order: string[] = [];
    const tx = {
      site: { findFirst: vi.fn().mockResolvedValue({ id: "site-a", organizationId: "org-a" }) },
      $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
        const text = sql(strings);
        if (text.includes('FROM "User"')) { order.push("user"); return [{ id: "user-a", role: "GENERAL", isActive: true }]; }
        if (text.includes('FROM "Organization"')) { order.push("organization"); return [{ id: "org-a" }]; }
        if (text.includes('FROM "OrganizationMembership"')) { order.push("organization-membership"); return [{ organizationId: "org-a", role: "INVENTORY" }]; }
        if (text.includes('FROM "Site"')) { order.push("site"); return [{ id: "site-a", organizationId: "org-a" }]; }
        if (text.includes('FROM "SiteMembership"')) { order.push("site-membership"); return [{ siteId: "site-a" }]; }
        throw new Error(`unexpected SQL: ${text}`);
      }),
    };

    const result = await lockSiteAndMembership(tx as never, "user-a", "site-a", "update");

    expect(result).toMatchObject({ id: "site-a", organizationId: "org-a", organizationRole: "INVENTORY" });
    expect(order).toEqual(["organization", "user", "organization-membership", "site", "site-membership"]);
  });

  it("rejects a site moved after candidate discovery", async () => {
    const tx = {
      site: { findFirst: vi.fn().mockResolvedValue({ id: "site-a", organizationId: "org-a" }) },
      $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
        const text = sql(strings);
        if (text.includes('FROM "User"')) return [{ id: "user-a", role: "GENERAL", isActive: true }];
        if (text.includes('FROM "Organization"')) return [{ id: "org-a" }];
        if (text.includes('FROM "OrganizationMembership"')) return [{ organizationId: "org-a", role: "INVENTORY" }];
        if (text.includes('FROM "Site"')) return [{ id: "site-a", organizationId: "org-b" }];
        throw new Error(`unexpected SQL: ${text}`);
      }),
    };

    await expect(lockSiteAndMembership(tx as never, "user-a", "site-a", "update")).resolves.toBeNull();
  });

  it("locks CSV authorization in organization then actor then membership order", async () => {
    const order: string[] = [];
    const tx = {
      $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
        const text = sql(strings);
        if (text.includes('FROM "User"')) { order.push("user"); return [{ id: "manager-a", role: "ADMIN", isActive: true }]; }
        if (text.includes('FROM "Organization"')) { order.push("organization"); return [{ id: "org-a" }]; }
        if (text.includes('FROM "OrganizationMembership"')) { order.push("organization-membership"); return [{ organizationId: "org-a", role: "MANAGER" }]; }
        throw new Error(`unexpected SQL: ${text}`);
      }),
    };

    const result = await lockActorOrganizationAccess(tx as never, "manager-a", "org-a", "update");

    expect(result?.organizationRole).toBe("MANAGER");
    expect(order).toEqual(["organization", "user", "organization-membership"]);
  });

  it("keeps SHARE locks active-scoped and bound to the requested tenant, actor, and site", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const tx = {
      site: { findFirst: vi.fn().mockResolvedValue({ id: "site-a", organizationId: "org-a" }) },
      $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = sql(strings);
        calls.push({ text, values });
        if (text.includes('FROM "OrganizationMembership"')) return [{ organizationId: "org-a", role: "INVENTORY" }];
        if (text.includes('FROM "Organization"')) return [{ id: "org-a" }];
        if (text.includes('FROM "User"')) return [{ id: "user-a", role: "GENERAL", isActive: true }];
        if (text.includes('FROM "SiteMembership"')) return [{ siteId: "site-a" }];
        if (text.includes('FROM "Site"')) return [{ id: "site-a", organizationId: "org-a" }];
        throw new Error(`unexpected SQL: ${text}`);
      }),
    };

    await expect(lockSiteAndMembership(tx as never, "user-a", "site-a", "share")).resolves.not.toBeNull();

    expect(calls.map((call) => call.values)).toEqual([
      ["org-a"],
      ["user-a"],
      ["org-a", "user-a"],
      ["site-a"],
      ["site-a", "user-a"],
    ]);
    for (const call of calls) {
      expect(call.text).toContain('"isActive" = TRUE');
      expect(call.text).toContain("FOR SHARE");
    }
  });
});
