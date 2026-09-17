import Fastify from "fastify";
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { inventoryHistoryRoutes } from "./inventoryHistory.js";

const mocks = vi.hoisted(() => ({ site: vi.fn(), products: vi.fn(), group: vi.fn() }));
vi.mock("../lib/prisma.js", () => ({ prisma: { site: { findFirst: mocks.site }, product: { findMany: mocks.products }, inventoryTransaction: { groupBy: mocks.group } } }));

async function appFor(sub = "manager", role = "GENERAL") {
  const app = Fastify();
  app.decorate("authenticate", async (request) => { Object.assign(request, { user: { sub, role } }); });
  await app.register(inventoryHistoryRoutes, { prefix: "/api/inventory-history" });
  return app;
}
const cutoff = "2026-09-17T12:00:00.000Z";
const url = `/api/inventory-history/sites/site-a/as-of?asOfExclusive=${cutoff}`;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.site.mockResolvedValue({ id: "site-a", organizationId: "org-a" });
  mocks.products.mockResolvedValue([{ id: "product-a", name: "Archived product", barcodeValue: "0123", isActive: false }]);
  mocks.group.mockResolvedValue([{ productId: "product-a", unitOfMeasure: "EACH", _sum: { quantity: new Prisma.Decimal("-1.2500") }, _count: { _all: 3 }, _min: { occurredAt: new Date("2026-09-01Z") }, _max: { occurredAt: new Date("2026-09-16Z"), createdAt: new Date("2026-09-18Z") } }]);
});

describe("point-in-time inventory quantities", () => {
  it("returns signed exact decimal quantities and provenance, never monetary valuation", async () => {
    const app = await appFor(); const res = await app.inject(url);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ valuationStatus: "unavailable", asOfExclusive: cutoff, recordedBefore: null, nextCursor: null, rows: [{ product: { id: "product-a", isActive: false }, quantity: "-1.2500", unitOfMeasure: "EACH", provenance: { source: "inventoryLedger", eventCount: 3, lastRecordedAt: "2026-09-18T00:00:00.000Z" } }] });
    expect(res.body).not.toMatch(/price|cost|amount/i); await app.close();
  });
  it("uses exclusive effective and optional recorded cutoffs, including later-recorded backdated events by default", async () => {
    const app = await appFor(); await app.inject(url);
    expect(mocks.group.mock.calls[0][0].where).toEqual({ organizationId: "org-a", siteId: "site-a", productId: { in: ["product-a"] }, occurredAt: { lt: new Date(cutoff) } });
    await app.inject(`${url}&recordedBefore=2026-09-16T12:00:00Z`);
    expect(mocks.group.mock.calls[1][0].where.createdAt).toEqual({ lt: new Date("2026-09-16T12:00:00Z") }); await app.close();
  });
  it.each([
    ["site", ["isActive"]], ["site membership", ["memberships", "some", "isActive"]],
    ["user", ["memberships", "some", "user", "isActive"]], ["organization", ["organization", "isActive"]],
    ["organization membership", ["organization", "memberships", "some", "isActive"]],
  ])("requires active %s, including global ADMIN", async (_name, path) => {
    mocks.site.mockImplementation(async ({ where }) => { expect(path.reduce((v, k) => v[k], where)).toBe(true); return null; });
    const app = await appFor("manager", "ADMIN"); expect((await app.inject(url)).statusCode).toBe(404);
    expect(mocks.site).toHaveBeenCalledOnce();
    expect(mocks.products).not.toHaveBeenCalled(); expect(mocks.group).not.toHaveBeenCalled(); await app.close();
  });
  it("scopes site and both memberships to the authenticated identity", async () => {
    const app = await appFor(); await app.inject(url);
    expect(mocks.site.mock.calls[0][0].where).toMatchObject({ id: "site-a", memberships: { some: { userId: "manager" } }, organization: { memberships: { some: { userId: "manager" } } } });
    expect(mocks.products.mock.calls[0][0].where).toEqual({ organizationId: "org-a" }); await app.close();
  });
  it("bounds product pagination by immutable id including archived products and excludes lookahead from aggregation", async () => {
    mocks.products.mockResolvedValue([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const app = await appFor(); const first = (await app.inject(`${url}&limit=2`)).json();
    expect(first.nextCursor).toBe("b"); expect(mocks.products.mock.calls[0][0]).toMatchObject({ take: 3, orderBy: { id: "asc" } });
    expect(mocks.group.mock.calls[0][0].where.productId).toEqual({ in: ["a", "b"] });
    await app.inject(`${url}&limit=2&cursor=b`);
    expect(mocks.products.mock.calls[1][0].where).toEqual({ organizationId: "org-a", id: { gt: "b" } }); await app.close();
  });
  it("does not combine incompatible units or erase zero and negative ledger history", async () => {
    mocks.group.mockResolvedValue(["EACH", "KG"].map((unitOfMeasure, i) => ({ productId: "product-a", unitOfMeasure, _sum: { quantity: new Prisma.Decimal(i ? "-0.0001" : "0") }, _count: { _all: 2 }, _min: { occurredAt: null }, _max: { occurredAt: null, createdAt: null } })));
    const app = await appFor(); const rows = (await app.inject(url)).json().rows;
    expect(rows.map((r: { quantity: string }) => r.quantity)).toEqual(["0.0000", "-0.0001"]);
    expect(mocks.group.mock.calls[0][0].by).toEqual(["productId", "unitOfMeasure"]); await app.close();
  });
  it("reports no history separately from known zero and avoids empty ledger queries", async () => {
    mocks.group.mockResolvedValue([]); const app = await appFor();
    expect((await app.inject(url)).json().rows[0]).toMatchObject({ quantity: "0.0000", unitOfMeasure: null, provenance: { eventCount: 0 } });
    mocks.products.mockResolvedValue([]); mocks.group.mockClear();
    expect((await app.inject(url)).json().rows).toEqual([]); expect(mocks.group).not.toHaveBeenCalled(); await app.close();
  });
  it.each(["asOfExclusive=2026-09-17", "asOfExclusive=2026-02-30T00:00:00Z", "asOfExclusive=2026-09-17T00:00:00.0001Z", "asOfExclusive=2026-09-17T00:00:00", `asOfExclusive=${cutoff}&recordedBefore=bad`, `asOfExclusive=${cutoff}&limit=101`, `asOfExclusive=${cutoff}&limit=0`, `asOfExclusive=${cutoff}&cursor=`, `asOfExclusive=${cutoff}&extra=true`, ""])("rejects invalid/beyond-storage-precision inputs: %s", async (query) => {
    const app = await appFor(); expect((await app.inject(`/api/inventory-history/sites/site-a/as-of?${query}`)).statusCode).toBe(400); expect(mocks.site).not.toHaveBeenCalled(); await app.close();
  });
  it("rejects an absent authenticated subject", async () => { const app = await appFor(""); expect((await app.inject(url)).statusCode).toBe(401); expect(mocks.site).not.toHaveBeenCalled(); await app.close(); });
  it.each(["2026-09-17T00:00:00+24:00", "2026-09-17T00:00:00+00:99"])("rejects impossible UTC offsets before database access: %s", async (value) => {
    const app = await appFor();
    expect((await app.inject(`/api/inventory-history/sites/site-a/as-of?asOfExclusive=${encodeURIComponent(value)}`)).statusCode).toBe(400);
    expect(mocks.site).not.toHaveBeenCalled(); await app.close();
  });
});
