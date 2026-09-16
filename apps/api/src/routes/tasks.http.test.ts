import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensurePilotSiteForUser: vi.fn(),
  membershipFindUnique: vi.fn(),
  membershipFindMany: vi.fn(),
  assignmentFindFirst: vi.fn(),
  assignmentFindUnique: vi.fn(),
  assignmentCreate: vi.fn(),
  assignmentUpdateMany: vi.fn(),
  assignmentFindUniqueOrThrow: vi.fn(),
  assignmentFindMany: vi.fn(),
  countSessionFindMany: vi.fn(),
  eventCreate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("../lib/pilotSite.js", () => ({
  ensurePilotSiteForUser: mocks.ensurePilotSiteForUser,
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    organizationMembership: { findUnique: mocks.membershipFindUnique, findMany: mocks.membershipFindMany },
    taskAssignment: {
      findFirst: mocks.assignmentFindFirst,
      findUnique: mocks.assignmentFindUnique,
      create: mocks.assignmentCreate,
      updateMany: mocks.assignmentUpdateMany,
      findUniqueOrThrow: mocks.assignmentFindUniqueOrThrow,
      findMany: mocks.assignmentFindMany,
    },
    storeCountSession: { findMany: mocks.countSessionFindMany },
    taskAssignmentEvent: { create: mocks.eventCreate },
    $transaction: mocks.transaction,
  },
}));

import { taskRoutes } from "./tasks.js";

async function testApp() {
  const app = Fastify();
  app.decorate("authenticate", async (request) => {
    Object.assign(request, { user: { sub: "user-a", role: "GENERAL", tv: 0 } });
  });
  await app.register(taskRoutes, { prefix: "/api/tasks" });
  return app;
}

describe("task route tenant and concurrency guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensurePilotSiteForUser.mockResolvedValue({
      id: "site-a",
      organizationId: "org-a",
      timeZone: "America/New_York",
      name: "Site A",
      code: "A",
    });
    mocks.membershipFindUnique.mockResolvedValue({ role: "MEMBER", isActive: true });
    mocks.membershipFindMany.mockResolvedValue([]);
    mocks.assignmentFindMany.mockResolvedValue([]);
    mocks.countSessionFindMany.mockResolvedValue([]);
    mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({
      taskAssignment: {
        create: mocks.assignmentCreate,
        updateMany: mocks.assignmentUpdateMany,
        findUniqueOrThrow: mocks.assignmentFindUniqueOrThrow,
      },
      taskAssignmentEvent: { create: mocks.eventCreate },
    }));
  });

  it("scopes employee task lookup to the authenticated employee, organization, and site", async () => {
    mocks.assignmentFindFirst.mockResolvedValue(null);
    const app = await testApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/tasks/task-from-org-b",
      payload: { status: "COMPLETED" },
    });
    expect(response.statusCode).toBe(404);
    expect(mocks.assignmentFindFirst).toHaveBeenCalledWith({
      where: {
        id: "task-from-org-b",
        assignedToId: "user-a",
        organizationId: "org-a",
        siteId: "site-a",
      },
    });
    expect(mocks.assignmentUpdateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a stale employee write instead of overwriting a concurrent manager change", async () => {
    const updatedAt = new Date("2026-08-28T12:00:00Z");
    mocks.assignmentFindFirst.mockResolvedValue({
      id: "task-a",
      assignedToId: "user-a",
      organizationId: "org-a",
      siteId: "site-a",
      status: "OPEN",
      updatedAt,
    });
    mocks.assignmentUpdateMany.mockResolvedValue({ count: 0 });
    const app = await testApp();
    const response = await app.inject({ method: "PATCH", url: "/api/tasks/task-a", payload: { status: "COMPLETED" } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("changed while you were editing");
    expect(mocks.assignmentUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "task-a", updatedAt }),
    }));
    expect(mocks.eventCreate).not.toHaveBeenCalled();
    await app.close();
  });

  it("scopes manager assignment lookup to the manager's organization and site", async () => {
    mocks.membershipFindUnique.mockResolvedValue({ role: "MANAGER", isActive: true });
    mocks.assignmentFindFirst.mockResolvedValue(null);
    const app = await testApp();
    const response = await app.inject({ method: "PATCH", url: "/api/tasks/assignments/task-from-org-b", payload: { status: "OPEN" } });
    expect(response.statusCode).toBe(404);
    expect(mocks.assignmentFindFirst).toHaveBeenCalledWith({
      where: { id: "task-from-org-b", organizationId: "org-a", siteId: "site-a" },
    });
    await app.close();
  });

  it("deduplicates a retried one-time assignment by idempotency key", async () => {
    const created = {
      id: "task-once",
      idempotencyKey: "retry-key-1234567890",
      templateId: null,
      organizationId: "org-a",
      siteId: "site-a",
      assignedToId: "employee-1",
      jobTitle: "STOCK_COUNT_ASSOCIATE",
      recurrence: "ONCE",
      rolloverPolicy: "REMAIN_OVERDUE",
      title: "Check endcap",
      instructions: null,
      scheduledDate: new Date("2026-08-28T00:00:00.000Z"),
      dueAt: null,
      status: "OPEN",
      priority: "NORMAL",
    };
    const managerMembership = { role: "MANAGER", isActive: true };
    const employeeMembership = {
      isActive: true,
      user: { id: "employee-1", isActive: true, jobTitle: "STOCK_COUNT_ASSOCIATE", siteMemberships: [{ id: "sm-1" }] },
    };
    mocks.assignmentCreate.mockResolvedValue(created);
    mocks.assignmentFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(created);
    mocks.membershipFindUnique
      .mockResolvedValueOnce(managerMembership)
      .mockResolvedValueOnce(employeeMembership)
      .mockResolvedValueOnce(managerMembership)
      .mockResolvedValueOnce(employeeMembership);

    const app = await testApp();
    const payload = {
      idempotencyKey: "retry-key-1234567890",
      assignedToId: "employee-1",
      title: "Check endcap",
      scheduledDate: "2026-08-28",
      priority: "NORMAL",
      rolloverPolicy: "REMAIN_OVERDUE",
    };
    const first = await app.inject({ method: "POST", url: "/api/tasks/assignments", payload });
    const retry = await app.inject({ method: "POST", url: "/api/tasks/assignments", payload });

    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(mocks.assignmentCreate).toHaveBeenCalledTimes(1);
    expect(mocks.eventCreate).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("filters manager employee listings to active members of the current site", async () => {
    mocks.membershipFindUnique.mockResolvedValue({ role: "MANAGER", isActive: true });
    mocks.membershipFindMany.mockResolvedValue([]);
    const app = await testApp();
    const response = await app.inject({ method: "GET", url: "/api/tasks/employees" });
    expect(response.statusCode).toBe(200);
    expect(mocks.membershipFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        organizationId: "org-a",
        user: expect.objectContaining({
          siteMemberships: { some: { siteId: "site-a", isActive: true } },
        }),
      }),
    }));
    await app.close();
  });

  it("returns active count ownership and assignment history with manager team work", async () => {
    mocks.membershipFindUnique.mockResolvedValue({ role: "MANAGER", isActive: true });
    mocks.countSessionFindMany.mockResolvedValue([{
      id: "count-a",
      name: "Evening count",
      assignedToId: "employee-a",
      assignedTo: { id: "employee-a", name: "Alex", employeeNumber: "E-1" },
      assignmentEvents: [{
        id: "event-a",
        fromUser: null,
        toUser: { id: "employee-a", name: "Alex" },
        assignedBy: { id: "manager", name: "Morgan" },
        reason: null,
        occurredAt: new Date("2026-09-16T12:00:00Z"),
      }],
    }]);
    const app = await testApp();

    const response = await app.inject({ method: "GET", url: "/api/tasks/team?start=2026-09-16&end=2026-09-16" });

    expect(response.statusCode).toBe(200);
    expect(mocks.countSessionFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { siteId: "site-a", status: "ACTIVE" },
      select: expect.objectContaining({ assignedTo: expect.any(Object), assignmentEvents: expect.any(Object) }),
    }));
    expect(response.json().activeCounts).toMatchObject([{
      id: "count-a",
      assignedToId: "employee-a",
      assignmentEvents: [{ toUser: { id: "employee-a", name: "Alex" } }],
    }]);
    await app.close();
  });

});
