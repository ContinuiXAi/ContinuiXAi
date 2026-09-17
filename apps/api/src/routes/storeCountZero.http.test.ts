import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sessionFindFirst: vi.fn(),
  siteFindUnique: vi.fn(),
  locationFindUnique: vi.fn(),
  productFindFirst: vi.fn(),
  scanLogFindUnique: vi.fn(),
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  entryFindUnique: vi.fn(),
  entryFindUniqueOrThrow: vi.fn(),
  transactionScanLogFindUnique: vi.fn(),
  transactionScanLogCreate: vi.fn(),
  entryFindFirst: vi.fn(),
  entryUpdate: vi.fn(),
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    site: { findMany: vi.fn(), findUnique: mocks.siteFindUnique },
    storeCountSession: { findFirst: mocks.sessionFindFirst },
    storeLocation: { findUnique: mocks.locationFindUnique },
    product: { findFirst: mocks.productFindFirst },
    productIdentifier: { findFirst: async () => null },
    storeCountScanLog: { findUnique: mocks.scanLogFindUnique },
    $transaction: mocks.transaction,
  },
}));

vi.mock("../lib/barcodeLookup/index.js", () => ({ resolveProduct: vi.fn() }));

import { storeCountRoutes } from "./storeCount.js";

async function testApp() {
  const app = Fastify();
  app.decorate("authenticate", async (request) => {
    Object.assign(request, { user: { sub: "employee-a", role: "GENERAL", tv: 0 } });
  });
  await app.register(storeCountRoutes, { prefix: "/api/store-count" });
  return app;
}

describe("Store Count confirmed-zero scan entry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const product = { id: "product-absent", organizationId: "org-a", barcodeValue: "000000000009", name: "Absent vitamin", packageSize: "39 tablets" };
    const location = { id: "location-a", siteId: "site-a", code: "A1", isActive: true };
    const entry = { id: "entry-zero", sessionId: "session-a", productId: product.id, barcodeValue: product.barcodeValue, locationId: location.id, quantity: 0, product, location, countedBy: { id: "employee-a", name: "Alex" } };
    let savedLog: Record<string, unknown> | null = null;
    mocks.sessionFindFirst.mockResolvedValue({ id: "session-a", siteId: "site-a", status: "ACTIVE", startedById: "employee-a" });
    mocks.siteFindUnique.mockResolvedValue({ organizationId: "org-a" });
    mocks.locationFindUnique.mockResolvedValue(location);
    mocks.productFindFirst.mockResolvedValue(product);
    mocks.scanLogFindUnique.mockImplementation(async () => savedLog ? { ...savedLog, entry } : null);
    mocks.transactionScanLogFindUnique.mockImplementation(async () => savedLog);
    mocks.transactionScanLogCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      savedLog = data;
      return data;
    });
    mocks.entryFindUnique.mockResolvedValue(null);
    mocks.entryFindUniqueOrThrow.mockResolvedValue(entry);
    mocks.queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join(" ");
      if (sql.includes('FROM "StoreCountSession"')) return [{ status: "ACTIVE", siteId: "site-a", organizationId: "org-a", assignedToId: "employee-a", startedById: "employee-a" }];
      if (sql.includes('FROM "StoreLocation"') || sql.includes('FROM "Product"')) return [{ id: "valid" }];
      if (sql.includes('FROM "StoreCountDiscrepancy"')) return [];
      if (sql.includes("INSERT INTO \"StoreCountEntry\"")) {
        expect(values[5]).toBe(0);
        return [{ id: entry.id }];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    mocks.transaction.mockImplementation(async (work: (tx: unknown) => unknown) => work({
      $queryRaw: mocks.queryRaw,
      productComposition: { findFirst: async () => null },
      storeCountEntry: { findUnique: mocks.entryFindUnique, findUniqueOrThrow: mocks.entryFindUniqueOrThrow, findFirst: mocks.entryFindFirst, update: mocks.entryUpdate },
      storeCountScanLog: { findUnique: mocks.transactionScanLogFindUnique, create: mocks.transactionScanLogCreate },
    }));
  });

  it("accepts zero, stores one zero entry, and returns it idempotently for the same clientScanId", async () => {
    const app = await testApp();
    const payload = { barcodeValue: "000000000009", locationId: "location-a", quantityDelta: 0, clientScanId: "stable-zero-id" };

    const first = await app.inject({ method: "POST", url: "/api/store-count/sessions/session-a/scan", payload });
    const retry = await app.inject({ method: "POST", url: "/api/store-count/sessions/session-a/scan", payload });

    expect(first.statusCode).toBe(200);
    expect(retry.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ productId: "product-absent", quantity: 0 });
    expect(retry.json()).toMatchObject({ productId: "product-absent", quantity: 0 });
    expect(mocks.queryRaw.mock.calls.filter(([strings]) => (strings as TemplateStringsArray).join(" ").includes("INSERT INTO \"StoreCountEntry\""))).toHaveLength(1);
    expect(mocks.transactionScanLogCreate).toHaveBeenCalledWith({
      data: { idempotencyKey: "stable-zero-id", entryId: "entry-zero", sessionId: "session-a", userId: "employee-a", quantityDelta: 0 },
    });
    await app.close();
  });

  it("still rejects a negative count delta", async () => {
    const app = await testApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/store-count/sessions/session-a/scan",
      payload: { barcodeValue: "000000000009", locationId: "location-a", quantityDelta: -1, clientScanId: "negative-id" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it.each(["remapped", "unresolved", "new"])("protects the existing approved entry when UPC is %s", async (mode) => {
    const entry = { id: "original", productId: "approved-product", quantity: 13 };
    mocks.entryFindUnique.mockResolvedValue(mode === "new" ? null : entry);
    mocks.productFindFirst.mockResolvedValue(mode === "unresolved" ? null : { id: "replacement" });
    mocks.entryFindUniqueOrThrow.mockImplementation(async () => entry);
    mocks.queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join(" ");
      if (sql.includes('FROM "StoreCountDiscrepancy"')) return values[1] === "approved-product" ? [{ status: "APPROVED" }] : [];
      if (sql.includes('FROM "StoreCountSession"')) return [{ status: "ACTIVE", siteId: "site-a", organizationId: "org-a", startedById: "employee-a", assignedToId: "employee-a" }];
      if (sql.includes('FROM "StoreLocation"') || sql.includes('FROM "Product"')) return [{ id: "valid" }];
      if (sql.includes('INSERT INTO "StoreCountEntry"')) { entry.productId = String(values[2] ?? entry.productId); entry.quantity += Number(values[5]); return [{ id: entry.id }]; }
      throw new Error(sql);
    });
    const app = await testApp();
    const response = await app.inject({ method: "POST", url: "/api/store-count/sessions/session-a/scan", payload: { barcodeValue: "000000000009", locationId: "location-a", quantityDelta: 1, clientScanId: "fresh" } });
    expect(response.statusCode).toBe(mode === "new" ? 200 : 409);
    expect(entry).toEqual({ id: "original", productId: mode === "new" ? "replacement" : "approved-product", quantity: mode === "new" ? 14 : 13 });
    if (mode !== "new") {
      mocks.transactionScanLogFindUnique.mockResolvedValue({ sessionId: "session-a", entryId: entry.id });
      const retry = await app.inject({ method: "POST", url: "/api/store-count/sessions/session-a/scan", payload: { barcodeValue: "000000000009", locationId: "location-a", quantityDelta: 13, clientScanId: "old" } });
      expect(retry.statusCode).toBe(200); expect(retry.json()).toMatchObject({ productId: "approved-product", quantity: 13 });
    }
    await app.close();
  });

  it.each(["scan", "edit"])("blocks %s from changing product evidence after manager approval", async (operation) => {
    const original = mocks.queryRaw.getMockImplementation()!;
    mocks.queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join(" ").includes('FROM "StoreCountDiscrepancy"')) {
        expect(values).toEqual(["session-a", "product-absent"]);
        return [{ status: "APPROVED" }];
      }
      return original(strings, ...values);
    });
    mocks.entryFindFirst.mockResolvedValue({ id: "entry-zero", sessionId: "session-a", productId: "product-absent", quantity: 0 });
    mocks.entryUpdate.mockResolvedValue({ id: "entry-zero", quantity: 7 });
    const app = await testApp();
    const response = await app.inject(operation === "scan" ? {
      method: "POST", url: "/api/store-count/sessions/session-a/scan",
      payload: { barcodeValue: "000000000009", locationId: "location-a", quantityDelta: 0, clientScanId: "new-zero-id" },
    } : { method: "PATCH", url: "/api/store-count/sessions/session-a/entries/entry-zero", payload: { quantity: 7, expectedQuantity: 0 } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/approved/i);
    expect(mocks.entryUpdate).not.toHaveBeenCalled();
    expect(mocks.transactionScanLogCreate).not.toHaveBeenCalled();
    await app.close();
  });
});
