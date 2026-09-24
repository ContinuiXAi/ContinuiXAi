import { describe, expect, it, vi } from "vitest";
import { lockCountScope } from "./storeCountWriteAccess.js";

function sqlText(strings: TemplateStringsArray) {
  return strings.join(" ").replace(/\s+/g, " ").trim();
}

describe("lockCountScope", () => {
  it("locks the session and authorization relations in one deterministic order", async () => {
    const order: string[] = [];
    const tx = {
      site: {
        findFirst: vi.fn(async () => ({ id: "site-a", organizationId: "org-a" })),
      },
      $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
        const sql = sqlText(strings);
        if (sql.includes('FROM "StoreCountSession"')) {
          order.push("session");
          return [{
            id: "session-a",
            siteId: "site-a",
            organizationId: "org-a",
            status: "ACTIVE",
            startedAt: new Date(0),
            startedById: "user-a",
            assignedToId: "user-a",
          }];
        }
        if (sql.includes('FROM "User"')) { order.push("user"); return [{ id: "user-a", role: "GENERAL", isActive: true }]; }
        if (sql.includes('FROM "OrganizationMembership"')) { order.push("organization-membership"); return [{ organizationId: "org-a", role: "INVENTORY" }]; }
        if (sql.includes('FROM "Organization"')) { order.push("organization"); return [{ id: "org-a" }]; }
        if (sql.includes('FROM "SiteMembership"')) { order.push("site-membership"); return [{ siteId: "site-a" }]; }
        if (sql.includes('FROM "Site"')) { order.push("site"); return [{ id: "site-a", organizationId: "org-a" }]; }
        order.push("compound");
        return [];
      }),
    };

    const scope = await lockCountScope(tx as never, "session-a", "user-a");

    expect(scope).toMatchObject({
      id: "session-a",
      siteId: "site-a",
      organizationId: "org-a",
      organizationRole: "INVENTORY",
    });
    expect(order).toEqual([
      "session",
      "organization",
      "user",
      "organization-membership",
      "site",
      "site-membership",
    ]);
  });
});
