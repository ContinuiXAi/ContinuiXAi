import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  organizationMembershipFindMany: vi.fn(),
  siteFindMany: vi.fn(),
  siteMembershipUpdateMany: vi.fn(),
  siteMembershipUpsert: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    organizationMembership: { findMany: mocks.organizationMembershipFindMany },
    site: { findMany: mocks.siteFindMany },
    siteMembership: { updateMany: mocks.siteMembershipUpdateMany, upsert: mocks.siteMembershipUpsert },
    $transaction: mocks.transaction,
  },
}));

import { siteMembershipRoutes } from "./siteMemberships.js";

async function testApp() {
  const app = Fastify();
  app.decorate("authenticate", async (request) => { Object.assign(request, { user: { sub: "admin", role: "ADMIN", tv: 0 } }); });
  app.decorate("requireAdmin", async () => undefined);
  await app.register(siteMembershipRoutes, { prefix: "/api/site-memberships" });
  return app;
}

describe("administrator site membership routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userFindUnique.mockResolvedValue({ id: "employee" });
    mocks.organizationMembershipFindMany.mockResolvedValue([{ organizationId: "org-a" }]);
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({
      siteMembership: { updateMany: mocks.siteMembershipUpdateMany, upsert: mocks.siteMembershipUpsert },
    }));
  });

  it("lists only active sites in the target user's organizations", async () => {
    mocks.siteFindMany.mockResolvedValue([{ id: "site-a", name: "Main", code: "MAIN", memberships: [{ isActive: true }] }]);
    const app = await testApp();
    const response = await app.inject({ method: "GET", url: "/api/site-memberships/users/employee" });
    expect(response.statusCode).toBe(200);
    expect(mocks.siteFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { isActive: true, organizationId: { in: ["org-a"] } },
    }));
    expect(response.json()).toEqual([{ id: "site-a", name: "Main", code: "MAIN", assigned: true }]);
    await app.close();
  });

  it("rejects a site outside the target user's organizations", async () => {
    mocks.siteFindMany.mockResolvedValue([{ id: "site-a" }]);
    const app = await testApp();
    const response = await app.inject({
      method: "PUT",
      url: "/api/site-memberships/users/employee",
      payload: { siteIds: ["site-a", "foreign-site"] },
    });
    expect(response.statusCode).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled();
    await app.close();
  });

  it("replaces assignments idempotently within scope", async () => {
    mocks.siteFindMany.mockResolvedValue([{ id: "site-a" }, { id: "site-b" }]);
    const app = await testApp();
    const response = await app.inject({
      method: "PUT",
      url: "/api/site-memberships/users/employee",
      payload: { siteIds: ["site-a", "site-b", "site-a"] },
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.siteMembershipUpdateMany).toHaveBeenCalledWith({
      where: { userId: "employee", siteId: { in: ["site-a", "site-b"] } },
      data: { isActive: false },
    });
    expect(mocks.siteMembershipUpsert).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("rejects an empty assignment set", async () => {
    const app = await testApp();
    const response = await app.inject({ method: "PUT", url: "/api/site-memberships/users/employee", payload: { siteIds: [] } });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
