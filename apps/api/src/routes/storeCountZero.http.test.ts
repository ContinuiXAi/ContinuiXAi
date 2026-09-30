import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sessionFindFirst: vi.fn(),
  siteFindUnique: vi.fn(),
  locationFindUnique: vi.fn(),
  productFindFirst: vi.fn(),
  productFindMany: vi.fn(),
  scanLogFindUnique: vi.fn(),
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  entryFindUnique: vi.fn(),
  entryFindUniqueOrThrow: vi.fn(),
  transactionScanLogFindUnique: vi.fn(),
  transactionScanLogCreate: vi.fn(),
  entryFindFirst: vi.fn(),
  entryFindMany: vi.fn(),
  entryUpdate: vi.fn(),
  categoryFindMany: vi.fn(),
  productCreate: vi.fn(),
  executeRaw: vi.fn(),
  resolveProduct: vi.fn(),
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    site: { findMany: vi.fn(), findUnique: mocks.siteFindUnique },
    storeCountSession: { findFirst: mocks.sessionFindFirst },
    storeLocation: { findUnique: mocks.locationFindUnique },
    product: { findFirst: mocks.productFindFirst, findMany: mocks.productFindMany },
    productIdentifier: { findFirst: async () => null },
    category: { findMany: mocks.categoryFindMany },
    storeCountScanLog: { findUnique: mocks.scanLogFindUnique },
    $transaction: mocks.transaction,
  },
}));

vi.mock("../lib/barcodeLookup/index.js", () => ({ resolveProduct: mocks.resolveProduct }));

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
    vi.resetAllMocks();
    const product = { id: "product-absent", organizationId: "org-a", barcodeValue: "000000000009", name: "Absent vitamin", packageSize: "39 tablets" };
    const location = { id: "location-a", siteId: "site-a", code: "A1", isActive: true };
    const entry = { id: "entry-zero", sessionId: "session-a", productId: product.id, barcodeValue: product.barcodeValue, locationId: location.id, quantity: 0, product, location, countedBy: { id: "employee-a", name: "Alex" } };
    let savedLog: Record<string, unknown> | null = null;
    mocks.sessionFindFirst.mockResolvedValue({ id: "session-a", siteId: "site-a", status: "ACTIVE", startedById: "employee-a" });
    mocks.siteFindUnique.mockResolvedValue({ organizationId: "org-a" });
    mocks.locationFindUnique.mockResolvedValue(location);
    mocks.productFindFirst.mockResolvedValue(product);
    mocks.productFindMany.mockResolvedValue([product]);
    mocks.scanLogFindUnique.mockImplementation(async () => savedLog ? { ...savedLog, entry } : null);
    mocks.transactionScanLogFindUnique.mockImplementation(async () => savedLog);
    mocks.transactionScanLogCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      savedLog = data;
      return data;
    });
    mocks.entryFindUnique.mockResolvedValue(null);
    mocks.entryFindMany.mockResolvedValue([]);
    mocks.entryFindUniqueOrThrow.mockResolvedValue(entry);
    mocks.categoryFindMany.mockResolvedValue([]);
    mocks.executeRaw.mockResolvedValue(1);
    mocks.queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join(" ");
      if (sql.includes('FROM "StoreCountSession"')) return [{ status: "ACTIVE", siteId: "site-a", organizationId: "org-a", assignedToId: "employee-a", startedById: "employee-a" }];
      if (sql.includes('FROM "User"')) return [{ id: "employee-a", role: "GENERAL", isActive: true }];
      if (sql.includes('FROM "OrganizationMembership"')) return [{ organizationId: "org-a", role: "INVENTORY" }];
      if (sql.includes('FROM "Organization"')) return [{ id: "org-a" }];
      if (sql.includes('FROM "SiteMembership"')) return [{ siteId: "site-a" }];
      if (sql.includes('FROM "Site"')) return [{ id: "site-a", organizationId: "org-a" }];
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
      product: { findMany: mocks.productFindMany },
      productComposition: { findFirst: async () => null },
      storeCountEntry: { findUnique: mocks.entryFindUnique, findUniqueOrThrow: mocks.entryFindUniqueOrThrow, findFirst: mocks.entryFindFirst, findMany: mocks.entryFindMany, update: mocks.entryUpdate },
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

  it("does not auto-create an unknown product after count access is revoked", async () => {
    const enriched = {
      id: "new-product",
      organizationId: "org-a",
      barcodeValue: "042000001007",
      name: "Resolved cosmetic",
      identifiers: [{ value: "04210007", type: "UPC" }],
    };
    mocks.productFindMany.mockResolvedValue([]);
    mocks.resolveProduct.mockResolvedValue({ found: true, name: enriched.name });
    mocks.productCreate.mockResolvedValue(enriched);
    mocks.queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join(" ");
      if (sql.includes('FROM "StoreCountSession"')) {
        return [{
          id: "session-a",
          status: "ACTIVE",
          siteId: "site-a",
          organizationId: "org-a",
          assignedToId: "employee-a",
          startedById: "employee-a",
        }];
      }
      if (sql.includes('FROM "User"')) return [];
      if (sql.includes('FROM "Organization"')) return [{ id: "org-a" }];
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    mocks.transaction.mockImplementation(async (work: (tx: unknown) => unknown) => work({
      $queryRaw: mocks.queryRaw,
      $executeRaw: mocks.executeRaw,
      product: { findMany: mocks.productFindMany, create: mocks.productCreate },
      productComposition: { findFirst: async () => null },
      storeCountEntry: {
        findUnique: mocks.entryFindUnique,
        findUniqueOrThrow: mocks.entryFindUniqueOrThrow,
        findFirst: mocks.entryFindFirst,
        findMany: mocks.entryFindMany,
        update: mocks.entryUpdate,
      },
      storeCountScanLog: {
        findUnique: mocks.transactionScanLogFindUnique,
        create: mocks.transactionScanLogCreate,
      },
    }));

    const app = await testApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/store-count/sessions/session-a/scan",
      payload: {
        barcodeValue: "042000001007",
        locationId: "location-a",
        quantityDelta: 1,
        clientScanId: "revoked-enrichment",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(mocks.productCreate).not.toHaveBeenCalled();
    await app.close();
  });

  it("counts camera UPC-A and handheld UPC-E reads as one product and one entry", async () => {
    const legacyProduct = {
      id: "legacy-cosmetic",
      organizationId: "org-a",
      barcodeValue: "04210007",
      name: "Compact cosmetic",
      packageSize: "1 each",
    };
    const savedEntries = new Map<string, Record<string, unknown>>();
    const savedScanLogs = new Map<string, Record<string, unknown>>();
    const baseQuery = mocks.queryRaw.getMockImplementation()!;

    mocks.productFindFirst.mockImplementation(async ({ where }: { where: { barcodeValue: string } }) => (
      where.barcodeValue === legacyProduct.barcodeValue ? legacyProduct : null
    ));
    mocks.productFindMany.mockResolvedValue([legacyProduct]);
    mocks.entryFindUnique.mockImplementation(async ({ where }: { where: { sessionId_locationId_barcodeValue: { barcodeValue: string } } }) => (
      savedEntries.get(where.sessionId_locationId_barcodeValue.barcodeValue) ?? null
    ));
    mocks.entryFindFirst.mockImplementation(async ({ where }: { where: { barcodeValue?: { in?: string[] } } }) => (
      [...savedEntries.values()].find((entry) => where.barcodeValue?.in?.includes(String(entry.barcodeValue))) ?? null
    ));
    mocks.entryFindUniqueOrThrow.mockImplementation(async ({ where }: { where: { id: string } }) => (
      [...savedEntries.values()].find((entry) => entry.id === where.id)
    ));
    mocks.transactionScanLogFindUnique.mockImplementation(async ({ where }: { where: { idempotencyKey: string } }) => (
      savedScanLogs.get(where.idempotencyKey) ?? null
    ));
    mocks.transactionScanLogCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      savedScanLogs.set(String(data.idempotencyKey), data);
      return data;
    });
    mocks.scanLogFindUnique.mockImplementation(async ({ where }: { where: { idempotencyKey: string } }) => {
      const log = savedScanLogs.get(where.idempotencyKey);
      if (!log) return null;
      return { ...log, entry: [...savedEntries.values()].find((entry) => entry.id === log.entryId) };
    });
    mocks.queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join(" ");
      if (!sql.includes('INSERT INTO "StoreCountEntry"')) return baseQuery(strings, ...values);

      const barcodeValue = String(values[3]);
      const prior = savedEntries.get(barcodeValue);
      const quantity = Number(prior?.quantity ?? 0) + Number(values[5]);
      const next = {
        id: String(prior?.id ?? values[0]),
        sessionId: String(values[1]),
        productId: values[2] === null ? null : String(values[2]),
        barcodeValue,
        locationId: String(values[4]),
        quantity,
        product: values[2] === null ? null : legacyProduct,
        location: { id: "location-a", code: "A1" },
        countedBy: { id: "employee-a", name: "Alex" },
      };
      savedEntries.set(barcodeValue, next);
      return [{ id: next.id }];
    });

    const app = await testApp();
    const camera = await app.inject({
      method: "POST",
      url: "/api/store-count/sessions/session-a/scan",
      payload: { barcodeValue: "042000001007", locationId: "location-a", quantityDelta: 1, clientScanId: "camera-read" },
    });
    const handheld = await app.inject({
      method: "POST",
      url: "/api/store-count/sessions/session-a/scan",
      payload: { barcodeValue: "04210007", locationId: "location-a", quantityDelta: 1, clientScanId: "handheld-read" },
    });

    expect(camera.statusCode).toBe(200);
    expect(camera.json()).toMatchObject({ productId: "legacy-cosmetic", quantity: 1 });
    expect(handheld.statusCode).toBe(200);
    expect(handheld.json()).toMatchObject({ productId: "legacy-cosmetic", quantity: 2 });
    expect(savedEntries).toHaveLength(1);
    await app.close();
  });

  it("does not mutate a count when equivalent UPC forms already belong to different products", async () => {
    mocks.productFindFirst.mockResolvedValue({ id: "compressed-product", organizationId: "org-a", barcodeValue: "04210007" });
    mocks.productFindMany.mockResolvedValue([
      { id: "compressed-product", organizationId: "org-a", barcodeValue: "04210007" },
      { id: "expanded-product", organizationId: "org-a", barcodeValue: "042000001007" },
    ]);
    const app = await testApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/store-count/sessions/session-a/scan",
      payload: { barcodeValue: "04210007", locationId: "location-a", quantityDelta: 1, clientScanId: "ambiguous-read" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/more than one product/i);
    expect(mocks.queryRaw.mock.calls.some(([strings]) => (strings as TemplateStringsArray).join(" ").includes('INSERT INTO "StoreCountEntry"'))).toBe(false);
    await app.close();
  });

  it("preserves an exact packaging identifier instead of collapsing it into the product's primary UPC", async () => {
    const productWithCaseIdentifier = {
      id: "case-product",
      organizationId: "org-a",
      barcodeValue: "012345678905",
      name: "Case-packed cosmetic",
      packageSize: "24 each",
    };
    mocks.productFindMany.mockResolvedValue([productWithCaseIdentifier]);
    let insertedBarcode: unknown;
    const baseQuery = mocks.queryRaw.getMockImplementation()!;
    mocks.queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join(" ").includes('INSERT INTO "StoreCountEntry"')) {
        insertedBarcode = values[3];
        return [{ id: "entry-zero" }];
      }
      return baseQuery(strings, ...values);
    });

    const app = await testApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/store-count/sessions/session-a/scan",
      payload: { barcodeValue: "CASE-SKU-24", locationId: "location-a", quantityDelta: 0, clientScanId: "case-read" },
    });

    expect(response.statusCode).toBe(200);
    expect(insertedBarcode).toBe("CASE-SKU-24");
    await app.close();
  });

  it("preserves a valid numeric supplier packaging UPC instead of treating it as a generated alias", async () => {
    const scannedCaseUpc = "036000291452";
    const productWithCaseIdentifier = {
      id: "case-product",
      organizationId: "org-a",
      barcodeValue: "012345678905",
      name: "Case-packed cosmetic",
      packageSize: "24 each",
      identifiers: [{
        value: scannedCaseUpc,
        type: "UPC",
        source: "SUPPLIER",
        packagingId: "case-packaging",
      }],
    };
    mocks.productFindMany.mockImplementation(async ({ where }: { where: { barcodeValue?: string } }) => (
      where.barcodeValue === scannedCaseUpc ? [] : [productWithCaseIdentifier]
    ));
    let insertedBarcode: unknown;
    const baseQuery = mocks.queryRaw.getMockImplementation()!;
    mocks.queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join(" ").includes('INSERT INTO "StoreCountEntry"')) {
        insertedBarcode = values[3];
        return [{ id: "entry-zero" }];
      }
      return baseQuery(strings, ...values);
    });

    const app = await testApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/store-count/sessions/session-a/scan",
      payload: { barcodeValue: scannedCaseUpc, locationId: "location-a", quantityDelta: 0, clientScanId: "numeric-case-read" },
    });

    expect(response.statusCode).toBe(200);
    expect(insertedBarcode).toBe(scannedCaseUpc);
    await app.close();
  });

  it("does not reuse the primary item's historical UPC-E row for an unrelated packaging UPC", async () => {
    const scannedCaseUpc = "036000291452";
    const productWithCaseIdentifier = {
      id: "case-product",
      organizationId: "org-a",
      barcodeValue: "012345000058",
      name: "Case-packed cosmetic",
      packageSize: "24 each",
      identifiers: [
        { value: "01234558", type: "UPC", source: "CONTINUIXAI_BARCODE_ALIAS", packagingId: null },
        { value: scannedCaseUpc, type: "UPC", source: "SUPPLIER", packagingId: "case-packaging" },
      ],
    };
    const historicalEachEntry = {
      id: "historical-each-entry",
      sessionId: "session-a",
      productId: productWithCaseIdentifier.id,
      barcodeValue: "01234558",
      locationId: "location-a",
      quantity: 4,
      countedByUserId: "employee-a",
      countedBy: { id: "employee-a", name: "Alex" },
    };
    mocks.productFindMany.mockImplementation(async ({ where }: { where: { barcodeValue?: string } }) => (
      where.barcodeValue === scannedCaseUpc ? [] : [productWithCaseIdentifier]
    ));
    mocks.entryFindFirst.mockResolvedValue(historicalEachEntry);
    let insertedBarcode: unknown;
    const baseQuery = mocks.queryRaw.getMockImplementation()!;
    mocks.queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join(" ").includes('INSERT INTO "StoreCountEntry"')) {
        insertedBarcode = values[3];
        return [{ id: "case-entry" }];
      }
      return baseQuery(strings, ...values);
    });
    mocks.entryFindUniqueOrThrow.mockResolvedValue({
      id: "case-entry",
      productId: productWithCaseIdentifier.id,
      barcodeValue: scannedCaseUpc,
      locationId: "location-a",
      quantity: 1,
      product: productWithCaseIdentifier,
      location: { id: "location-a", code: "A1" },
      countedBy: { id: "employee-a", name: "Alex" },
    });
    const app = await testApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/store-count/sessions/session-a/scan",
      payload: { barcodeValue: scannedCaseUpc, locationId: "location-a", quantityDelta: 1, clientScanId: "case-after-historical-each" },
    });

    expect(response.statusCode).toBe(200);
    expect(insertedBarcode).toBe(scannedCaseUpc);
    expect(mocks.entryFindFirst).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not guess when a raw 8-digit scan can be either UPC-E or EAN-8", async () => {
    mocks.productFindMany.mockResolvedValue([]);
    const app = await testApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/store-count/sessions/session-a/scan",
      payload: { barcodeValue: "01234558", locationId: "location-a", quantityDelta: 1, clientScanId: "dual-valid-read" },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toMatch(/UPC-E.*EAN-8|EAN-8.*UPC-E/i);
    expect(mocks.transaction).not.toHaveBeenCalled();
    await app.close();
  });

  it("counts an exact EAN-8 match even when a distinct UPC-A alternate also exists", async () => {
    const ean8 = { id: "ean-8-product", organizationId: "org-a", barcodeValue: "01234558", name: "EAN-8 item" };
    const upcA = { id: "upc-a-product", organizationId: "org-a", barcodeValue: "012345000058", name: "UPC-A item" };
    mocks.productFindMany.mockImplementation(async ({ where }: { where: unknown }) => (
      JSON.stringify(where) === JSON.stringify({ organizationId: "org-a", barcodeValue: "01234558" })
        ? [ean8]
        : [ean8, upcA]
    ));
    mocks.entryFindUniqueOrThrow.mockResolvedValue({
      id: "entry-ean-8",
      productId: ean8.id,
      barcodeValue: ean8.barcodeValue,
      locationId: "location-a",
      quantity: 0,
      product: ean8,
      location: { id: "location-a", code: "A1" },
      countedBy: { id: "employee-a", name: "Alex" },
    });
    const app = await testApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/store-count/sessions/session-a/scan",
      payload: { barcodeValue: "01234558", locationId: "location-a", quantityDelta: 0, clientScanId: "ean-8-exact" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ productId: "ean-8-product" });
    await app.close();
  });

  it("uses a typed UPC-E alias to store a handheld read under the camera's UPC-A identity", async () => {
    const upcProduct = {
      id: "upc-product",
      organizationId: "org-a",
      barcodeValue: "012345000058",
      name: "UPC item",
      identifiers: [{ value: "01234558", type: "UPC", source: "CONTINUIXAI_BARCODE_ALIAS", packagingId: null }],
    };
    mocks.productFindMany.mockImplementation(async ({ where }: { where: { barcodeValue?: string } }) => (
      where.barcodeValue === "01234558" ? [] : [upcProduct]
    ));
    let insertedBarcode: unknown;
    const baseQuery = mocks.queryRaw.getMockImplementation()!;
    mocks.queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join(" ").includes('INSERT INTO "StoreCountEntry"')) {
        insertedBarcode = values[3];
        return [{ id: "entry-upc" }];
      }
      return baseQuery(strings, ...values);
    });
    mocks.entryFindUniqueOrThrow.mockResolvedValue({
      id: "entry-upc",
      productId: upcProduct.id,
      barcodeValue: upcProduct.barcodeValue,
      locationId: "location-a",
      quantity: 1,
      product: upcProduct,
      location: { id: "location-a", code: "A1" },
      countedBy: { id: "employee-a", name: "Alex" },
    });
    const app = await testApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/store-count/sessions/session-a/scan",
      payload: { barcodeValue: "01234558", locationId: "location-a", quantityDelta: 1, clientScanId: "typed-upc-e" },
    });

    expect(response.statusCode).toBe(200);
    expect(insertedBarcode).toBe("012345000058");
    expect(response.json()).toMatchObject({ productId: "upc-product", barcodeValue: "012345000058" });
    await app.close();
  });

  it("reuses a historical managed UPC-E row when the camera sends its UPC-A product", async () => {
    const upcProduct = {
      id: "upc-product",
      organizationId: "org-a",
      barcodeValue: "012345000058",
      name: "UPC item",
      identifiers: [{ value: "01234558", type: "UPC", source: "CONTINUIXAI_BARCODE_ALIAS", packagingId: null }],
    };
    const historical = {
      id: "historical-upc-e-entry",
      sessionId: "session-a",
      productId: upcProduct.id,
      barcodeValue: "01234558",
      locationId: "location-a",
      quantity: 4,
      countedByUserId: "employee-a",
      countedBy: { id: "employee-a", name: "Alex" },
    };
    mocks.productFindMany.mockResolvedValue([upcProduct]);
    mocks.entryFindUnique.mockResolvedValue(null);
    mocks.entryFindMany.mockImplementation(async ({ where }: { where: { barcodeValue?: { in?: string[] } } }) => (
      where.barcodeValue?.in?.includes("01234558") ? [historical] : []
    ));
    mocks.entryFindFirst.mockResolvedValue(historical);
    mocks.transactionScanLogFindUnique.mockResolvedValue(null);
    mocks.transactionScanLogCreate.mockResolvedValue({});
    const insertedBarcodes: unknown[] = [];
    const baseQuery = mocks.queryRaw.getMockImplementation()!;
    mocks.queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join(" ").includes('INSERT INTO "StoreCountEntry"')) {
        insertedBarcodes.push(values[3]);
        return [{ id: historical.id }];
      }
      return baseQuery(strings, ...values);
    });
    mocks.entryFindUniqueOrThrow.mockResolvedValue({ ...historical, quantity: 5, product: upcProduct, location: { id: "location-a", code: "A1" } });
    const app = await testApp();

    const handheld = await app.inject({
      method: "POST",
      url: "/api/store-count/sessions/session-a/scan",
      payload: { barcodeValue: "01234558", locationId: "location-a", quantityDelta: 1, clientScanId: "handheld-on-historical-upc-e" },
    });
    const camera = await app.inject({
      method: "POST",
      url: "/api/store-count/sessions/session-a/scan",
      payload: { barcodeValue: "012345000058", locationId: "location-a", quantityDelta: 1, clientScanId: "camera-after-historical-upc-e" },
    });

    expect(handheld.statusCode).toBe(200);
    expect(camera.statusCode).toBe(200);
    expect(insertedBarcodes).toEqual(["01234558", "01234558"]);
    expect(mocks.entryFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        productId: upcProduct.id,
        barcodeValue: "01234558",
      }),
    }));
    await app.close();
  });

  it("does not merge a distinct EAN-8 product row into a camera UPC-A count", async () => {
    const upcProduct = {
      id: "upc-product",
      organizationId: "org-a",
      barcodeValue: "012345000058",
      name: "UPC item",
      identifiers: [{ value: "01234558", type: "UPC", source: "CONTINUIXAI_BARCODE_ALIAS", packagingId: null }],
    };
    mocks.productFindMany.mockResolvedValue([upcProduct]);
    mocks.entryFindUnique.mockResolvedValue(null);
    mocks.entryFindMany.mockResolvedValue([]);
    mocks.entryFindFirst.mockImplementation(async ({ where }: { where: { productId?: string } }) => (
      where.productId === "ean-8-product"
        ? { id: "ean-entry", productId: "ean-8-product", barcodeValue: "01234558" }
        : null
    ));
    let insertedBarcode: unknown;
    const baseQuery = mocks.queryRaw.getMockImplementation()!;
    mocks.queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join(" ").includes('INSERT INTO "StoreCountEntry"')) {
        insertedBarcode = values[3];
        return [{ id: "upc-entry" }];
      }
      return baseQuery(strings, ...values);
    });
    mocks.entryFindUniqueOrThrow.mockResolvedValue({
      id: "upc-entry",
      productId: upcProduct.id,
      barcodeValue: upcProduct.barcodeValue,
      quantity: 1,
      product: upcProduct,
      location: { id: "location-a", code: "A1" },
      countedBy: { id: "employee-a", name: "Alex" },
    });
    const app = await testApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/store-count/sessions/session-a/scan",
      payload: { barcodeValue: "012345000058", locationId: "location-a", quantityDelta: 1, clientScanId: "camera-with-distinct-ean" },
    });

    expect(response.statusCode).toBe(200);
    expect(insertedBarcode).toBe("012345000058");
    expect(mocks.entryFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ productId: upcProduct.id }),
    }));
    await app.close();
  });

  it("fails closed when a historical count already has two equivalent barcode rows", async () => {
    const legacyProduct = { id: "legacy-cosmetic", organizationId: "org-a", barcodeValue: "04210007", name: "Compact cosmetic" };
    mocks.productFindMany.mockResolvedValue([legacyProduct]);
    mocks.entryFindUnique.mockResolvedValue({
      id: "canonical-entry",
      productId: legacyProduct.id,
      barcodeValue: "042000001007",
      countedByUserId: "employee-a",
      countedBy: { id: "employee-a", name: "Alex" },
    });
    mocks.entryFindMany.mockResolvedValue([{
      id: "legacy-entry",
      productId: legacyProduct.id,
      barcodeValue: "04210007",
      countedByUserId: "employee-a",
      countedBy: { id: "employee-a", name: "Alex" },
    }]);
    const app = await testApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/store-count/sessions/session-a/scan",
      payload: { barcodeValue: "042000001007", locationId: "location-a", quantityDelta: 1, clientScanId: "duplicate-entry-read" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/more than one count row/i);
    expect(mocks.queryRaw.mock.calls.some(([strings]) => (strings as TemplateStringsArray).join(" ").includes('INSERT INTO "StoreCountEntry"'))).toBe(false);
    await app.close();
  });

  it("fails closed when two historical alternate rows exist without a canonical row", async () => {
    const product = { id: "upc-product", organizationId: "org-a", barcodeValue: "042000001007", name: "Compact cosmetic" };
    mocks.productFindMany.mockResolvedValue([product]);
    mocks.entryFindUnique.mockResolvedValue(null);
    mocks.entryFindMany.mockResolvedValue([
      { id: "compressed-entry", productId: product.id, barcodeValue: "04210007", countedBy: { id: "employee-a", name: "Alex" } },
      { id: "ean-wrapper-entry", productId: product.id, barcodeValue: "0042000001007", countedBy: { id: "employee-a", name: "Alex" } },
    ]);
    const app = await testApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/store-count/sessions/session-a/scan",
      payload: { barcodeValue: "042000001007", locationId: "location-a", quantityDelta: 1, clientScanId: "two-alternate-rows" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/more than one count row/i);
    expect(mocks.queryRaw.mock.calls.some(([strings]) => (strings as TemplateStringsArray).join(" ").includes('INSERT INTO "StoreCountEntry"'))).toBe(false);
    await app.close();
  });

  it("rejects a scan when the catalog identity changes after preflight authorization", async () => {
    const product = { id: "product-before", organizationId: "org-a", barcodeValue: "000000000009", name: "Before" };
    mocks.productFindMany
      .mockResolvedValueOnce([product])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const app = await testApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/store-count/sessions/session-a/scan",
      payload: { barcodeValue: "000000000009", locationId: "location-a", quantityDelta: 1, clientScanId: "catalog-changed" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/product changed|reload/i);
    expect(mocks.queryRaw.mock.calls.some(([strings]) => (strings as TemplateStringsArray).join(" ").includes('INSERT INTO "StoreCountEntry"'))).toBe(false);
    await app.close();
  });

  it.each(["remapped", "unresolved", "new"])("protects the existing approved entry when UPC is %s", async (mode) => {
    const entry = { id: "original", productId: "approved-product", quantity: 13 };
    mocks.entryFindUnique.mockResolvedValue(mode === "new" ? null : entry);
    mocks.productFindFirst.mockResolvedValue(mode === "unresolved" ? null : { id: "replacement" });
    mocks.productFindMany.mockResolvedValue(mode === "unresolved" ? [] : [{ id: "replacement", barcodeValue: "000000000009" }]);
    mocks.entryFindUniqueOrThrow.mockImplementation(async () => entry);
    mocks.queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join(" ");
      if (sql.includes('FROM "StoreCountDiscrepancy"')) return values[1] === "approved-product" ? [{ status: "APPROVED" }] : [];
      if (sql.includes('FROM "StoreCountSession"')) return [{ status: "ACTIVE", siteId: "site-a", organizationId: "org-a", startedById: "employee-a", assignedToId: "employee-a" }];
      if (sql.includes('FROM "User"')) return [{ id: "employee-a", role: "GENERAL", isActive: true }];
      if (sql.includes('FROM "OrganizationMembership"')) return [{ organizationId: "org-a", role: "INVENTORY" }];
      if (sql.includes('FROM "Organization"')) return [{ id: "org-a" }];
      if (sql.includes('FROM "SiteMembership"')) return [{ siteId: "site-a" }];
      if (sql.includes('FROM "Site"')) return [{ id: "site-a", organizationId: "org-a" }];
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
