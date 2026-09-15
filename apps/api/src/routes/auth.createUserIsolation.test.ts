import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userCreate: vi.fn(),
  membershipFindFirst: vi.fn(),
  membershipFindMany: vi.fn(),
  membershipCreate: vi.fn(),
  siteMembershipCreate: vi.fn(),
  transactionQueryRaw: vi.fn(),
}));

vi.mock("@prisma/client", () => ({ Prisma: { DbNull: null } }));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    user: {
      count: vi.fn(),
      findUnique: mocks.userFindUnique,
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    organizationMembership: {
      findFirst: mocks.membershipFindFirst,
      findMany: mocks.membershipFindMany,
      create: mocks.membershipCreate,
      updateMany: vi.fn(),
    },
    siteMembership: { create: mocks.siteMembershipCreate },
    securityAuditEvent: { create: vi.fn() },
    $transaction: vi.fn(async (work: (tx: unknown) => unknown) => work({
      $queryRaw: mocks.transactionQueryRaw,
      user: { create: mocks.userCreate },
      organizationMembership: { create: mocks.membershipCreate },
      siteMembership: { create: mocks.siteMembershipCreate },
    })),
  },
}));

vi.mock("../lib/tokenVersion.js", () => ({
  bumpTokenVersion: vi.fn(),
  invalidateTokenVersionCache: vi.fn(),
}));

vi.mock("../lib/sessionService.js", () => ({
  revokeAllUserSessions: vi.fn(),
  revokeSession: vi.fn(),
}));

import { authRoutes } from "./auth.js";

async function testApp() {
  const app = Fastify();
  app.decorate("authenticate", async (request) => {
    Object.assign(request, { user: { sub: "admin-a", role: "ADMIN", tv: 0 } });
  });
  app.decorate("requireAdmin", async () => undefined);
  await app.register(authRoutes, { prefix: "/api/auth" });
  return app;
}

const employee = {
  name: "Employee A",
  email: "employee-a@example.com",
  password: "SecurePass1!",
  role: "GENERAL" as const,
  organizationId: "org-a",
};

describe("administrator employee-creation tenant isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.membershipFindFirst.mockReset();
    mocks.membershipFindMany.mockReset();
    mocks.transactionQueryRaw.mockReset();
    mocks.userFindUnique.mockResolvedValue(null);
    mocks.userCreate.mockResolvedValue({ id: "employee-a", ...employee, isActive: true });
  });

  it("creates membership and site access only in the selected managed organization", async () => {
    mocks.transactionQueryRaw
      .mockResolvedValueOnce([{ organizationId: "org-a" }])
      .mockResolvedValueOnce([{ id: "site-a" }]);
    const app = await testApp();

    const response = await app.inject({ method: "POST", url: "/api/auth/users", payload: employee });

    expect(response.statusCode).toBe(201);
    expect(mocks.membershipFindMany).not.toHaveBeenCalled();
    expect(mocks.membershipCreate).toHaveBeenCalledTimes(1);
    expect(mocks.membershipCreate).toHaveBeenCalledWith({
      data: { organizationId: "org-a", userId: "employee-a", role: "VIEWER" },
    });
    expect(mocks.siteMembershipCreate).toHaveBeenCalledTimes(1);
    expect(mocks.siteMembershipCreate).toHaveBeenCalledWith({ data: { siteId: "site-a", userId: "employee-a" } });
    expect(mocks.siteMembershipCreate).not.toHaveBeenCalledWith({ data: { siteId: "site-b", userId: "employee-a" } });
    await app.close();
  });

  it("rejects an organization the administrator does not actively manage before creating the user", async () => {
    mocks.transactionQueryRaw.mockResolvedValueOnce([]);
    const app = await testApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/users",
      payload: { ...employee, organizationId: "org-c" },
    });

    expect(response.statusCode).toBe(404);
    expect(mocks.userCreate).not.toHaveBeenCalled();
    expect(mocks.membershipCreate).not.toHaveBeenCalled();
    expect(mocks.siteMembershipCreate).not.toHaveBeenCalled();
    await app.close();
  });

  it("revalidates organization authority inside the write transaction", async () => {
    mocks.membershipFindFirst.mockResolvedValue({ organization: { sites: [{ id: "site-a" }] } });
    mocks.transactionQueryRaw.mockResolvedValue([]);
    const app = await testApp();

    const response = await app.inject({ method: "POST", url: "/api/auth/users", payload: employee });

    expect(response.statusCode).toBe(404);
    expect(mocks.userCreate).not.toHaveBeenCalled();
    expect(mocks.membershipCreate).not.toHaveBeenCalled();
    expect(mocks.siteMembershipCreate).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not grant access to a site that left the selected organization before the transaction", async () => {
    mocks.membershipFindFirst.mockResolvedValue({ organization: { sites: [{ id: "site-a" }] } });
    mocks.transactionQueryRaw
      .mockResolvedValueOnce([{ organizationId: "org-a" }])
      .mockResolvedValueOnce([]);
    const app = await testApp();

    const response = await app.inject({ method: "POST", url: "/api/auth/users", payload: employee });

    expect(response.statusCode).toBe(201);
    expect(mocks.membershipCreate).toHaveBeenCalledTimes(1);
    expect(mocks.siteMembershipCreate).not.toHaveBeenCalled();
    await app.close();
  });

  it("requires an explicit organization selection", async () => {
    const app = await testApp();

    const { organizationId: _organizationId, ...unscopedEmployee } = employee;
    const response = await app.inject({ method: "POST", url: "/api/auth/users", payload: unscopedEmployee });

    expect(response.statusCode).toBe(400);
    expect(mocks.membershipFindFirst).not.toHaveBeenCalled();
    expect(mocks.userCreate).not.toHaveBeenCalled();
    await app.close();
  });

  it("lists only active organizations the administrator can manage", async () => {
    mocks.membershipFindMany.mockResolvedValue([
      { organization: { id: "org-a", name: "Org A" } },
      { organization: { id: "org-b", name: "Org B" } },
    ]);
    const app = await testApp();

    const response = await app.inject({ method: "GET", url: "/api/auth/user-organizations" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { id: "org-a", name: "Org A" },
      { id: "org-b", name: "Org B" },
    ]);
    expect(mocks.membershipFindMany).toHaveBeenCalledWith({
      where: {
        userId: "admin-a",
        isActive: true,
        role: { in: ["OWNER", "ADMIN"] },
        organization: { isActive: true },
      },
      select: { organization: { select: { id: true, name: true } } },
      orderBy: { organization: { name: "asc" } },
    });
    await app.close();
  });
});
