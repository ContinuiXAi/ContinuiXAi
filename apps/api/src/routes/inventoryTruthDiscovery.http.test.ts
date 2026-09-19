import Fastify from "fastify";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("../lib/prisma.js", () => ({ prisma: { storeCountSession: { findMany: mocks.findMany } } }));
import { inventoryTruthReviewRoutes } from "./inventoryTruthReview.js";

beforeEach(() => { mocks.findMany.mockReset(); });
it("discovers pending and reviewed counts only through active actor/site/organization membership", async () => {
  const captured: unknown[] = [];
  mocks.findMany.mockImplementation(async (query) => { captured.push(query); return [{ id: query.where.discrepancies.some?.status === "OPEN" ? "pending-completed" : "reviewed-completed" }]; });
  const app = Fastify();
  app.addHook("preHandler", async (req) => { Object.assign(req, { user: { sub: "manager", role: "GENERAL" } }); });
  await app.register(inventoryTruthReviewRoutes);
  const result = await app.inject({ method: "GET", url: "/counts/reviews" });
  expect(result.statusCode).toBe(200);
  expect(result.json()).toEqual({ pending: [{ id: "pending-completed" }], completed: [{ id: "reviewed-completed" }] });
  for (const query of captured) expect(query).toMatchObject({ where: { site: { isActive: true, memberships: { some: { userId: "manager", isActive: true, user: { isActive: true } } }, organization: { isActive: true, memberships: { some: { userId: "manager", isActive: true } } } } } });
  expect(captured[0]).toMatchObject({ where: { status: { in: ["ACTIVE", "COMPLETED"] }, discrepancies: { some: { status: "OPEN" } } }, take: 100 });
  expect(captured[1]).toMatchObject({ where: { status: "COMPLETED", discrepancies: { some: {}, none: { status: "OPEN" } } }, take: 20 });
  await app.close();
});
