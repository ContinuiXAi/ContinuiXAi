import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userFindFirst: vi.fn(),
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  membershipFindFirst: vi.fn(),
  membershipUpdateMany: vi.fn(),
  auditCreate: vi.fn(),
  bumpTokenVersion: vi.fn(),
  revokeAllUserSessions: vi.fn(),
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    user: {
      count: vi.fn(),
      findUnique: mocks.userFindUnique,
      findFirst: mocks.userFindFirst,
      create: vi.fn(),
      update: mocks.userUpdate,
    },
    organizationMembership: {
      findFirst: mocks.membershipFindFirst,
      findMany: vi.fn(),
      updateMany: mocks.membershipUpdateMany,
    },
    securityAuditEvent: { create: mocks.auditCreate },
  },
}));

vi.mock("../lib/tokenVersion.js", () => ({
  bumpTokenVersion: mocks.bumpTokenVersion,
  invalidateTokenVersionCache: vi.fn(),
}));

vi.mock("../lib/sessionService.js", () => ({
  revokeAllUserSessions: mocks.revokeAllUserSessions,
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

describe("administrator user-action tenant isolation", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["POST", "/api/auth/users/user-b/reset-password"],
    ["DELETE", "/api/auth/users/user-b"],
    ["POST", "/api/auth/users/user-b/reset-mfa"],
  ])("rejects %s %s unless the admin manages every active target organization", async (method, url) => {
    mocks.userFindFirst.mockResolvedValue(null);
    mocks.userFindUnique.mockResolvedValue({ id: "user-b", email: "user-b@example.com", name: "User B" });
    mocks.membershipFindFirst.mockResolvedValue({ id: "shared-membership" });
    const app = await testApp();

    const response = await app.inject({ method, url });

    expect(response.statusCode).toBe(404);
    expect(mocks.userFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "user-b",
        organizationMemberships: {
          some: {
            isActive: true,
            organization: {
              isActive: true,
              memberships: {
                some: { userId: "admin-a", isActive: true, role: { in: ["OWNER", "ADMIN"] } },
              },
            },
          },
          none: {
            isActive: true,
            organization: {
              isActive: true,
              memberships: {
                none: { userId: "admin-a", isActive: true, role: { in: ["OWNER", "ADMIN"] } },
              },
            },
          },
        },
      },
    }));
    expect(mocks.userUpdate).not.toHaveBeenCalled();
    expect(mocks.membershipUpdateMany).not.toHaveBeenCalled();
    expect(mocks.bumpTokenVersion).not.toHaveBeenCalled();
    expect(mocks.revokeAllUserSessions).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ["POST", "/api/auth/users/user-b/reset-password", 200],
    ["DELETE", "/api/auth/users/user-b", 204],
    ["POST", "/api/auth/users/user-b/reset-mfa", 200],
  ])("allows %s %s for a fully organization-scoped target", async (method, url, status) => {
    mocks.userFindFirst.mockResolvedValue({ id: "user-b", email: "user-b@example.com", name: "User B" });
    mocks.userUpdate.mockResolvedValue({ id: "user-b" });
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    const app = await testApp();

    const response = await app.inject({ method, url });

    expect(response.statusCode).toBe(status);
    expect(mocks.userUpdate).toHaveBeenCalled();
    expect(mocks.bumpTokenVersion).toHaveBeenCalledWith("user-b");
    expect(mocks.revokeAllUserSessions).toHaveBeenCalledWith("user-b");
    await app.close();
  });
});
