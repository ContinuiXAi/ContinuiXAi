import Fastify from "fastify";
import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  siteFindFirst: vi.fn(),
  siteFindMany: vi.fn(),
  productFindMany: vi.fn(),
  inventoryTransactionGroupBy: vi.fn(),
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    site: { findFirst: mocks.siteFindFirst, findMany: mocks.siteFindMany },
    product: { findMany: mocks.productFindMany },
    inventoryTransaction: { groupBy: mocks.inventoryTransactionGroupBy },
  },
}));

import { inventoryTruthRoutes } from "./inventoryTruth.js";

async function testApp(role = "GENERAL", sub = "manager-a") {
  const app = Fastify();
  app.decorate("authenticate", async (request) => {
    Object.assign(request, { user: { sub, role, tv: 0 } });
  });
  await app.register(inventoryTruthRoutes, { prefix: "/api/inventory-truth" });
  return app;
}

describe("site stock-state", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a", organizationId: "org-a" });
    mocks.productFindMany.mockResolvedValue([
      { id: "product-a", barcodeValue: "012345678905", name: "Negative stock", manufacturer: null, packageSize: "12 oz" },
    ]);
    mocks.inventoryTransactionGroupBy.mockResolvedValue([
      { productId: "product-a", _sum: { quantity: "-1.5000" } },
    ]);
  });

  afterEach(() => vi.useRealTimers());

  it("uses a single pre-read creation cutoff, not the later response time or business event time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-17T12:00:00.000Z"));
    mocks.inventoryTransactionGroupBy.mockImplementation(async () => {
      vi.setSystemTime(new Date("2026-09-17T12:00:02.000Z"));
      return [{ productId: "product-a", _sum: { quantity: new Prisma.Decimal("-1.5000") } }];
    });
    const app = await testApp();
    const response = await app.inject("/api/inventory-truth/sites/site-a/stock-state");
    expect(response.statusCode).toBe(200);
    expect(response.json().rows[0].asOf).toBe("2026-09-17T12:00:00.000Z");
    expect(mocks.inventoryTransactionGroupBy).toHaveBeenCalledWith({
      by: ["productId"],
      where: { organizationId: "org-a", siteId: "site-a", productId: { in: ["product-a"] }, createdAt: { lte: new Date("2026-09-17T12:00:00.000Z") } },
      _sum: { quantity: true },
    });
    await app.close();
  });

  it.each([
    ["inactive site", ["isActive"]],
    ["inactive site membership", ["memberships", "some", "isActive"]],
    ["inactive user", ["memberships", "some", "user", "isActive"]],
    ["inactive organization", ["organization", "isActive"]],
    ["inactive organization membership", ["organization", "memberships", "some", "isActive"]],
  ])("requires the %s predicate and performs no data read on denial", async (_reason, path) => {
    mocks.siteFindFirst.mockImplementation(async ({ where }) => {
      // Assert the actual database-bound predicate, not a fake authorization result alone.
      let value = where;
      for (const key of path) value = value[key];
      expect(value).toBe(true);
      expect(where.id).toBe("site-a");
      expect(where.memberships.some.userId).toBe("manager-a");
      expect(where.organization.memberships.some.userId).toBe("manager-a");
      expect(where.organization.memberships.some.user.isActive).toBe(true);
      return null;
    });
    const app = await testApp();
    const response = await app.inject("/api/inventory-truth/sites/site-a/stock-state");
    expect(response.statusCode).toBe(404);
    expect(mocks.productFindMany).not.toHaveBeenCalled();
    expect(mocks.inventoryTransactionGroupBy).not.toHaveBeenCalled();
    await app.close();
  });

  it("lists only actively accessible sites even for a global administrator", async () => {
    mocks.siteFindMany.mockResolvedValue([]);
    const app = await testApp("ADMIN");
    const response = await app.inject("/api/inventory-truth/sites");
    expect(response.json()).toEqual([]);
    expect(mocks.siteFindMany).toHaveBeenCalledWith({
      where: {
        isActive: true,
        memberships: { some: { userId: "manager-a", isActive: true, user: { isActive: true } } },
        organization: { isActive: true, memberships: { some: { userId: "manager-a", isActive: true, user: { isActive: true } } } },
      },
      select: { id: true, code: true, name: true }, orderBy: [{ code: "asc" }, { id: "asc" }],
    });
    await app.close();
  });

  it("keeps Decimal precision, defaults missing balances to zero, and excludes inactive/foreign products in the query", async () => {
    mocks.productFindMany.mockResolvedValue(["a", "b", "c"].map((id) => ({ id, name: id, barcodeValue: null, manufacturer: null, packageSize: null })));
    mocks.inventoryTransactionGroupBy.mockResolvedValue([
      { productId: "a", _sum: { quantity: new Prisma.Decimal("99999999999999.1234") } },
      { productId: "b", _sum: { quantity: new Prisma.Decimal("-0.0001") } },
    ]);
    const app = await testApp();
    const response = await app.inject("/api/inventory-truth/sites/site-a/stock-state");
    expect(response.json().rows.map((row: { onHand: string }) => row.onHand)).toEqual(["99999999999999.1234", "-0.0001", "0.0000"]);
    expect(new Set(response.json().rows.map((row: { asOf: string }) => row.asOf)).size).toBe(1);
    expect(mocks.productFindMany).toHaveBeenCalledWith({
      where: { organizationId: "org-a", isActive: true },
      select: { id: true, barcodeValue: true, name: true, manufacturer: true, packageSize: true },
      orderBy: [{ name: "asc" }, { id: "asc" }], take: 51,
    });
    expect(mocks.inventoryTransactionGroupBy.mock.calls[0][0].where.productId).toEqual({ in: ["a", "b", "c"] });
    await app.close();
  });

  it("paginates deterministically by name and id without aggregating the lookahead product", async () => {
    const products = ["a", "b", "c"].map((id) => ({ id, name: "Same name", barcodeValue: null, manufacturer: null, packageSize: null }));
    mocks.productFindMany.mockResolvedValueOnce(products).mockResolvedValueOnce([products[2]]);
    const app = await testApp();
    const first = (await app.inject("/api/inventory-truth/sites/site-a/stock-state?limit=2")).json();
    expect(first.rows.map((row: { product: { id: string } }) => row.product.id)).toEqual(["a", "b"]);
    expect(JSON.parse(Buffer.from(first.nextCursor, "base64url").toString())).toEqual({ name: "Same name", id: "b" });
    expect(mocks.inventoryTransactionGroupBy.mock.calls[0][0].where.productId).toEqual({ in: ["a", "b"] });
    const second = (await app.inject(`/api/inventory-truth/sites/site-a/stock-state?limit=2&cursor=${first.nextCursor}`)).json();
    expect(second.rows.map((row: { product: { id: string } }) => row.product.id)).toEqual(["c"]);
    expect(second.nextCursor).toBeNull();
    expect(mocks.productFindMany.mock.calls[1][0]).toMatchObject({
      where: { organizationId: "org-a", isActive: true, OR: [{ name: { gt: "Same name" } }, { name: "Same name", id: { gt: "b" } }] },
      orderBy: [{ name: "asc" }, { id: "asc" }], take: 3,
    });
    await app.close();
  });

  it("returns an empty final page without issuing a ledger query", async () => {
    mocks.productFindMany.mockResolvedValue([]);
    const app = await testApp();
    expect((await app.inject("/api/inventory-truth/sites/site-a/stock-state")).json()).toEqual({ rows: [], nextCursor: null });
    expect(mocks.inventoryTransactionGroupBy).not.toHaveBeenCalled();
    await app.close();
  });

  it.each(["limit=0", "limit=101", "limit=-1", "limit=1.5", "limit=nope", "cursor=", "cursor=garbage", "cursor=e30", "unexpected=true"])("rejects invalid query %s before querying data", async (query) => {
    const app = await testApp();
    expect((await app.inject(`/api/inventory-truth/sites/site-a/stock-state?${query}`)).statusCode).toBe(400);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.productFindMany).not.toHaveBeenCalled();
    expect(mocks.inventoryTransactionGroupBy).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a missing authenticated subject without querying data", async () => {
    const app = await testApp("ADMIN", "");
    expect((await app.inject("/api/inventory-truth/sites/site-a/stock-state")).statusCode).toBe(401);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.productFindMany).not.toHaveBeenCalled();
    expect(mocks.inventoryTransactionGroupBy).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns signed ledger balances and explicit unsupported stock promises", async () => {
    const app = await testApp();
    const response = await app.inject({ method: "GET", url: "/api/inventory-truth/sites/site-a/stock-state?limit=10" });

    expect(response.statusCode).toBe(200);
    const [row] = response.json().rows;
    expect(row).toMatchObject({
      onHand: "-1.5000",
      committed: { status: "notTracked" },
      incoming: { status: "notTracked" },
    });
    expect(row.asOf).toEqual(expect.any(String));
    expect(mocks.inventoryTransactionGroupBy).toHaveBeenCalledWith(expect.objectContaining({
      by: ["productId"],
      where: expect.objectContaining({ organizationId: "org-a", siteId: "site-a" }),
    }));
    await app.close();
  });

  it("does not let a global administrator cross tenant or site boundaries", async () => {
    mocks.siteFindFirst.mockResolvedValue(null);
    const app = await testApp("ADMIN");
    const crossTenant = await app.inject({ method: "GET", url: "/api/inventory-truth/sites/site-b/stock-state" });

    expect(crossTenant.statusCode).toBe(404);
    expect(mocks.productFindMany).not.toHaveBeenCalled();
    expect(mocks.inventoryTransactionGroupBy).not.toHaveBeenCalled();
    await app.close();
  });
});
