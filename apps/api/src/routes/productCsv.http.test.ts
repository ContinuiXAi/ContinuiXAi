import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  membershipFindFirst: vi.fn(),
  membershipFindMany: vi.fn(),
  productFindMany: vi.fn(),
  categoryFindMany: vi.fn(),
  transaction: vi.fn(),
  transactionQueryRaw: vi.fn(),
  transactionExecuteRaw: vi.fn(),
  transactionProductFindMany: vi.fn(),
  transactionProductCreateMany: vi.fn(),
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    organizationMembership: {
      findFirst: mocks.membershipFindFirst,
      findMany: mocks.membershipFindMany,
    },
    product: { findMany: mocks.productFindMany },
    category: { findMany: mocks.categoryFindMany },
    $transaction: mocks.transaction,
  },
}));

import { productCsvRoutes } from "./productCsv.js";
import { productRoutes } from "./products.js";

async function testApp(userId = "org-a-user") {
  const app = Fastify();
  app.decorate("authenticate", async (request) => {
    Object.assign(request, { user: { sub: userId, role: "GENERAL", tv: 0 } });
  });
  await app.register(multipart);
  await app.register(productRoutes, { prefix: "/api/products" });
  await app.register(productCsvRoutes, { prefix: "/api/products" });
  return app;
}

async function preview(app: Awaited<ReturnType<typeof testApp>>, csv: string, organizationId = "org-a") {
  return app.inject({
    method: "POST",
    url: `/api/products/import/preview?organizationId=${organizationId}`,
    headers: { "content-type": "text/csv; charset=utf-8" },
    payload: csv,
  });
}

describe("product CSV tenant-safe onboarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.membershipFindFirst.mockImplementation(async ({ where }: { where: { organizationId: string } }) =>
      where.organizationId === "org-a" ? { id: "membership-a", organizationId: "org-a" } : null,
    );
    mocks.membershipFindMany.mockResolvedValue([{ organizationId: "org-a" }]);
    mocks.productFindMany.mockResolvedValue([]);
    mocks.categoryFindMany.mockResolvedValue([]);
    mocks.transaction.mockImplementation(async (work: (tx: unknown) => unknown) => work({
      $queryRaw: mocks.transactionQueryRaw,
      $executeRaw: mocks.transactionExecuteRaw,
      product: { findMany: mocks.transactionProductFindMany, createMany: mocks.transactionProductCreateMany },
      category: { findMany: mocks.categoryFindMany },
    }));
    mocks.transactionQueryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join(" ");
      if (sql.includes('FROM "User"')) return [{ id: "org-a-user", role: "GENERAL", isActive: true }];
      if (sql.includes('FROM "Organization"')) return [{ id: "org-a" }];
      if (sql.includes('FROM "OrganizationMembership"')) return [{ organizationId: "org-a", role: "MANAGER" }];
      throw new Error(`Unexpected authorization SQL: ${sql}`);
    });
    mocks.transactionExecuteRaw.mockResolvedValue(1);
    mocks.transactionProductFindMany.mockResolvedValue([]);
    mocks.transactionProductCreateMany.mockResolvedValue({ count: 1 });
  });

  afterEach(() => vi.restoreAllMocks());

  it("returns a deterministic all-error preview when UPCs duplicate within the selected organization", async () => {
    const app = await testApp();
    const response = await preview(app, "upc,name\n001234,Milk\n001234,Cream\n");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      totals: { rows: 2, valid: 0, errors: 2 },
      rows: [
        { row: 2, status: "error", upc: "001234", name: "Milk" },
        { row: 3, status: "error", upc: "001234", name: "Cream" },
      ],
    });
    await app.close();
  });

  it("does not disclose or preview an organization outside the active manager membership", async () => {
    const app = await testApp();
    const response = await preview(app, "upc,name\n001234,Milk\n", "org-b");

    expect(response.statusCode).toBe(404);
    expect(mocks.productFindMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects inventory-bearing headers instead of mutating quantities", async () => {
    const app = await testApp();
    const response = await preview(app, "upc,name,quantity\n001234,Milk,7\n");

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/inventory-bearing/i);
    await app.close();
  });

  it("keeps UPCs as text and bounds the preview to 10,000 product rows", async () => {
    const app = await testApp();
    const leadingZero = await preview(app, "upc,name\n000123456789,Milk\n");
    expect(leadingZero.statusCode).toBe(200);
    expect(leadingZero.json().rows[0].upc).toBe("000123456789");

    const maximumRows = `upc,name\n${Array.from({ length: 10_000 }, (_, index) => `${index},Product ${index}`).join("\n")}`;
    const maximum = await preview(app, maximumRows);
    expect(maximum.statusCode).toBe(200);
    expect(maximum.json().totals).toMatchObject({ rows: 10_000, valid: 10_000, errors: 0 });

    const tooManyRows = `upc,name\n${Array.from({ length: 10_001 }, (_, index) => `${index},Product ${index}`).join("\n")}`;
    const response = await preview(app, tooManyRows);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/10,000 rows/i);
    await app.close();
  });

  it("rejects malformed UTF-8 before it can be interpreted as CSV", async () => {
    const app = await testApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/products/import/preview?organizationId=org-a",
      headers: { "content-type": "text/csv" },
      payload: Buffer.from([0x75, 0x70, 0x63, 0x2c, 0x6e, 0x61, 0x6d, 0x65, 0x0a, 0xc3, 0x28]),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/invalid UTF-8/i);
    await app.close();
  });

  it("commits only the intact, owned preview after rechecking manager authorization in a transaction", async () => {
    const app = await testApp();
    const first = await preview(app, "upc,name,is_active\n001234,Milk,true\n");
    const { previewId } = first.json();

    const response = await app.inject({
      method: "POST",
      url: "/api/products/import/commit",
      payload: { previewId, organizationId: "org-a" },
    });

    if (response.statusCode !== 201) throw new Error(response.body);
    expect(response.statusCode).toBe(201);
    const authorizationOrder = mocks.transactionQueryRaw.mock.calls.map(([strings]) => {
      const sql = (strings as TemplateStringsArray).join(" ");
      if (sql.includes('FROM "User"')) return "user";
      if (sql.includes('FROM "Organization"')) return "organization";
      if (sql.includes('FROM "OrganizationMembership"')) return "organization-membership";
      return "other";
    });
    expect(authorizationOrder.slice(0, 3)).toEqual(["organization", "user", "organization-membership"]);
    expect(mocks.transactionProductCreateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: [expect.objectContaining({ organizationId: "org-a", barcodeValue: "001234", name: "Milk" })],
    }));
    const replay = await app.inject({ method: "POST", url: "/api/products/import/commit", payload: { previewId, organizationId: "org-a" } });
    expect(replay.statusCode).toBe(404);
    expect(mocks.transactionProductCreateMany).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it.each([
    ["inactive actor", 'FROM "User"'],
    ["inactive organization", 'FROM "Organization"'],
    ["inactive manager membership", 'FROM "OrganizationMembership"'],
  ])("rejects %s at the transactional write boundary", async (_label, missingSql) => {
    mocks.transactionQueryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join(" ");
      if (sql.includes(missingSql)) return [];
      if (sql.includes('FROM "User"')) return [{ id: "org-a-user", role: "GENERAL", isActive: true }];
      if (sql.includes('FROM "Organization"')) return [{ id: "org-a" }];
      if (sql.includes('FROM "OrganizationMembership"')) return [{ organizationId: "org-a", role: "MANAGER" }];
      throw new Error(`Unexpected authorization SQL: ${sql}`);
    });
    const app = await testApp();
    const reviewed = await preview(app, "upc,name\n001234,Milk\n");
    const response = await app.inject({
      method: "POST",
      url: "/api/products/import/commit",
      payload: { previewId: reviewed.json().previewId, organizationId: "org-a" },
    });

    expect(response.statusCode).toBe(403);
    expect(mocks.transactionProductCreateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it.each(["quantity", "on_hand", "committed", "incoming", "unknown_column"])("rejects unsupported header %s", async (header) => {
    const app = await testApp();
    const response = await preview(app, `upc,name,${header}\n001234,Milk,1\n`);
    expect(response.statusCode).toBe(400);
    expect(mocks.productFindMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("warns about duplicate names but blocks only existing tenant UPCs", async () => {
    mocks.productFindMany.mockResolvedValue([{ barcodeValue: "009999", name: "Cream" }]);
    const app = await testApp();
    const response = await preview(app, "upc,name\n001234,Milk\n009999, milk \n000001,CREAM\n");
    expect(response.json().totals).toEqual({ rows: 3, valid: 0, warnings: 2, errors: 1 });
    expect(response.json().rows[0].warnings).toContain('Duplicate name "milk" in this CSV.');
    expect(response.json().rows[1].errors).toContain('UPC "009999" already exists in this organization.');
    expect(response.json().rows[2].warnings).toContain('Name "CREAM" already exists in this organization.');
    await app.close();
  });

  it("bounds the preview cache and evicts the oldest preview safely", async () => {
    const app = await testApp();
    const oldest = await preview(app, "upc,name\n001234,Milk\n");
    let newest = oldest;
    for (let i = 0; i < 100; i++) newest = await preview(app, `upc,name\n${i},Product ${i}\n`);
    expect((await app.inject({ method: "POST", url: "/api/products/import/commit", payload: { previewId: oldest.json().previewId, organizationId: "org-a" } })).statusCode).toBe(404);
    expect(mocks.transactionProductCreateMany).not.toHaveBeenCalled();
    expect((await app.inject({ method: "POST", url: "/api/products/import/commit", payload: { previewId: newest.json().previewId, organizationId: "org-a" } })).statusCode).toBe(201);
    await app.close();
  });

  it("rejects every nonblank legacy category without looking it up or writing any rows", async () => {
    mocks.categoryFindMany.mockResolvedValue([{ id: "category-a", name: "Dairy" }]);
    const app = await testApp();
    const first = await preview(app, "upc,name,category\n001234,Milk,Dairy\n009999,Cream,\n");
    const { previewId } = first.json();
    expect(first.json().totals).toEqual({ rows: 2, valid: 1, warnings: 0, errors: 1 });
    expect(first.json().rows[0]).toMatchObject({ categoryId: null, errors: [expect.stringMatching(/category.*not supported.*tenant/i)] });

    const response = await app.inject({
      method: "POST",
      url: "/api/products/import/commit",
      payload: { previewId, organizationId: "org-a" },
    });

    expect(response.statusCode).toBe(409);
    expect(mocks.categoryFindMany).not.toHaveBeenCalled();
    expect(mocks.transactionProductCreateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("accepts a blank compatibility category without assigning one", async () => {
    const app = await testApp();
    const first = await preview(app, "upc,name,category\n001234,Milk,\n");
    const response = await app.inject({ method: "POST", url: "/api/products/import/commit", payload: { previewId: first.json().previewId, organizationId: "org-a" } });
    expect(response.statusCode).toBe(201);
    expect(mocks.categoryFindMany).not.toHaveBeenCalled();
    expect(mocks.transactionProductCreateMany.mock.calls[0][0].data[0]).not.toHaveProperty("categoryId");
    await app.close();
  });

  it("allows UTF-8 uploads above 1 MiB but rejects uploads above 5 MiB", async () => {
    const app = await testApp();
    const allowed = `upc,name,description\n${Array.from({ length: 600 }, (_, i) => `${i},Product ${i},${"x".repeat(1800)}`).join("\n")}`;
    expect((await preview(app, allowed)).statusCode).toBe(200);
    expect((await preview(app, "x".repeat(5 * 1024 * 1024 + 1))).statusCode).toBe(413);
    await app.close();
  });

  it("rejects another actor, tenant, expired preview and client-supplied rows", async () => {
    const app = await testApp();
    const other = await testApp("other-user");
    const first = await preview(app, "upc,name\n001234,Milk\n");
    const payload = { previewId: first.json().previewId, organizationId: "org-a" };
    expect((await other.inject({ method: "POST", url: "/api/products/import/commit", payload })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/products/import/commit", payload: { ...payload, organizationId: "org-b" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/products/import/commit", payload: { ...payload, rows: [] } })).statusCode).toBe(400);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60 * 1000);
    expect((await app.inject({ method: "POST", url: "/api/products/import/commit", payload })).statusCode).toBe(404);
    expect(mocks.transactionProductCreateMany).not.toHaveBeenCalled();
    await app.close();
    await other.close();
  });

  it("requires active manager membership and rechecks revoked access at commit", async () => {
    const app = await testApp();
    const first = await preview(app, "upc,name\n001234,Milk\n");
    expect(mocks.membershipFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: "org-a-user", organizationId: "org-a", isActive: true, role: { in: ["OWNER", "ADMIN", "MANAGER"] }, user: { isActive: true }, organization: { isActive: true } }) }));
    mocks.transactionQueryRaw.mockResolvedValue([]);
    const response = await app.inject({ method: "POST", url: "/api/products/import/commit", payload: { previewId: first.json().previewId, organizationId: "org-a" } });
    expect(response.statusCode).toBe(403);
    expect(mocks.transactionProductCreateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects ambiguous organizations and cross-tenant exports without product reads", async () => {
    mocks.membershipFindMany.mockResolvedValue([{ organizationId: "org-a" }, { organizationId: "org-b" }]);
    const app = await testApp();
    expect((await app.inject({ method: "POST", url: "/api/products/import/preview", headers: { "content-type": "text/csv" }, payload: "upc,name\n001234,Milk\n" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/products/export.csv?organizationId=org-b" })).statusCode).toBe(404);
    expect(mocks.productFindMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns formula-escaped error CSV and scopes duplicate reads to the selected organization", async () => {
    const app = await testApp();
    const response = await preview(app, 'upc,name,category\n000123,=SUM(1),Dairy\n');
    expect(response.statusCode).toBe(200);
    expect(response.json().errorCsv).toContain("000123,'=SUM(1)");
    expect(response.json().errorCsv).toContain("Category imports are not supported");
    expect(mocks.productFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ organizationId: "org-a" }) }));
    await app.close();
  });

  it("accepts multipart uploads used by the UI and rejects oversized files", async () => {
    const app = await testApp();
    const upload = (csv: string) => app.inject({ method: "POST", url: "/api/products/import/preview", headers: { "content-type": "multipart/form-data; boundary=csv-boundary" }, payload: `--csv-boundary\r\nContent-Disposition: form-data; name="file"; filename="products.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--csv-boundary--\r\n` });
    const response = await upload("upc,name\n001234,Milk\n");
    expect(response.statusCode).toBe(200);
    expect(response.json().rows[0].upc).toBe("001234");
    const oversized = await upload("x".repeat(5 * 1024 * 1024 + 1));
    expect(oversized.statusCode).toBe(400);
    expect(mocks.transactionProductCreateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects an expired preview after waiting for transaction authorization", async () => {
    const app = await testApp();
    const first = await preview(app, "upc,name\n001234,Milk\n");
    const later = Date.now() + 16 * 60 * 1000;
    mocks.transactionQueryRaw.mockImplementationOnce(async () => {
      vi.spyOn(Date, "now").mockReturnValue(later);
      return [{ organizationId: "org-a" }];
    });
    const response = await app.inject({ method: "POST", url: "/api/products/import/commit", payload: { previewId: first.json().previewId, organizationId: "org-a" } });
    expect(response.statusCode).toBe(409);
    expect(mocks.transactionProductCreateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not write any rows if a product became a duplicate after review", async () => {
    mocks.transactionProductFindMany.mockResolvedValue([{ barcodeValue: "001234", name: "Milk" }]);
    const app = await testApp();
    const first = await preview(app, "upc,name\n001234,Milk\n");
    const { previewId } = first.json();

    const response = await app.inject({
      method: "POST",
      url: "/api/products/import/commit",
      payload: { previewId, organizationId: "org-a" },
    });

    expect(response.statusCode).toBe(409);
    expect(mocks.transactionProductCreateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("exports only the selected managed organization and formula-escapes fields", async () => {
    mocks.productFindMany.mockResolvedValueOnce([{
      barcodeValue: "001234",
      name: "=HYPERLINK(\"https://example.test\")",
      manufacturer: null,
      description: null,
      packageSize: null,
      category: { name: "Global legacy secret" },
      isActive: true,
    }]);
    const app = await testApp();

    const response = await app.inject({ method: "GET", url: "/api/products/export.csv?organizationId=org-a" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.body).toContain("'=HYPERLINK");
    expect(response.body).not.toContain("Global legacy secret");
    expect(response.body).toContain(",,,,true\r\n");
    expect(mocks.productFindMany).toHaveBeenCalledWith({ where: { organizationId: "org-a" }, orderBy: { name: "asc" } });
    expect(mocks.categoryFindMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("imports name-warning rows and checks only UPC conflicts at commit", async () => {
    const app = await testApp();
    mocks.productFindMany.mockResolvedValue([{ barcodeValue: "009999", name: "Milk" }]);
    const first = await preview(app, "upc,name\n001234,Milk\n001235,Milk\n");
    expect(first.json().totals).toEqual({ rows: 2, valid: 0, warnings: 2, errors: 0 });
    const response = await app.inject({ method: "POST", url: "/api/products/import/commit", payload: { previewId: first.json().previewId, organizationId: "org-a" } });
    expect(response.statusCode).toBe(201);
    expect(mocks.transactionProductFindMany).toHaveBeenCalledWith({ where: { organizationId: "org-a", barcodeValue: { in: ["001234", "001235"] } }, select: { barcodeValue: true } });
    expect(response.json()).toEqual({ imported: 2 });
    await app.close();
  });

  it("propagates a UPC race out of the transaction and returns stale 409 for the entire batch", async () => {
    const app = await testApp();
    const first = await preview(app, "upc,name\n001234,Milk\n001235,Cream\n");
    mocks.transactionProductCreateMany.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test", meta: { target: ["organizationId", "barcodeValue"] } }));
    const response = await app.inject({ method: "POST", url: "/api/products/import/commit", payload: { previewId: first.json().previewId, organizationId: "org-a" } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/stale.*review/i);
    expect(mocks.transactionProductCreateMany).toHaveBeenCalledTimes(1);
    expect(mocks.transactionProductCreateMany.mock.calls[0][0]).toMatchObject({ data: [{ barcodeValue: "001234" }, { barcodeValue: "001235" }] });
    expect(mocks.transactionProductCreateMany.mock.calls[0][0]).not.toHaveProperty("skipDuplicates");
    await expect(mocks.transaction.mock.results[0].value).rejects.toMatchObject({ code: "P2002" });
    await app.close();
  });

  it("claims a preview before awaiting commit so concurrent blank-UPC imports cannot replay it", async () => {
    const app = await testApp();
    const first = await preview(app, "upc,name\n,Milk\n");
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    mocks.transactionQueryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      await waiting;
      const sql = strings.join(" ");
      if (sql.includes('FROM "User"')) return [{ id: "org-a-user", role: "GENERAL", isActive: true }];
      if (sql.includes('FROM "Organization"')) return [{ id: "org-a" }];
      if (sql.includes('FROM "OrganizationMembership"')) return [{ organizationId: "org-a", role: "MANAGER" }];
      throw new Error(`Unexpected authorization SQL: ${sql}`);
    });
    const request = { method: "POST" as const, url: "/api/products/import/commit", payload: { previewId: first.json().previewId, organizationId: "org-a" } };
    const firstCommit = app.inject(request);
    const secondCommit = app.inject(request);
    const results = Promise.all([firstCommit, secondCommit]);
    await vi.waitFor(() => expect(mocks.transactionQueryRaw).toHaveBeenCalled());
    release();
    expect((await results).map((response) => response.statusCode).sort()).toEqual([201, 404]);
    expect(mocks.transactionProductCreateMany).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
