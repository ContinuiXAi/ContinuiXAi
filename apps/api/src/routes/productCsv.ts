import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Prisma } from "@prisma/client";
import { productCsvCommitSchema, type ProductCsvNormalizedRow } from "@continuixai/shared";
import { decodeUtf8Csv, encodeCsvRow, parseCsv, stripCsvFormulaGuard } from "../lib/csv.js";
import { prisma } from "../lib/prisma.js";
import { isUniqueConstraintError } from "../lib/prismaErrors.js";

const MAX_CSV_BYTES = 5 * 1024 * 1024;
const MAX_CSV_ROWS = 10_000;
const PREVIEW_TTL_MS = 15 * 60 * 1000;
const MAX_PREVIEWS = 100;
const REQUIRED_HEADERS = ["upc", "name"] as const;
const OPTIONAL_HEADERS = ["manufacturer", "description", "package_size", "category", "is_active"] as const;
const INVENTORY_HEADERS = new Set(["quantity", "on_hand", "committed", "incoming"]);
const ALLOWED_HEADERS = new Set<string>([...REQUIRED_HEADERS, ...OPTIONAL_HEADERS]);

type Preview = {
  previewId: string;
  actorUserId: string;
  organizationId: string;
  expiresAt: Date;
  rows: ProductCsvNormalizedRow[];
  rowHashes: string[];
  digest: string;
};

// A capped, short-lived cache keeps uploads out of inventory tables.  A process
// restart safely invalidates an uncommitted preview rather than risking a stale import.
// Pilot only: horizontal scaling requires durable, shared preview storage.
const previews = new Map<string, Preview>();

function digestRows(rows: ProductCsvNormalizedRow[]) {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function cleanPreviews(now = Date.now()) {
  for (const [id, preview] of previews) if (preview.expiresAt.getTime() <= now) previews.delete(id);
  while (previews.size >= MAX_PREVIEWS) {
    const oldest = previews.keys().next().value as string | undefined;
    if (!oldest) break;
    previews.delete(oldest);
  }
}

function nullable(value: string | undefined) {
  const text = value === undefined ? "" : stripCsvFormulaGuard(value).trim();
  return text || null;
}

function normalizedHeader(value: string) {
  return value.trim().toLowerCase();
}

function normalizedKey(value: string) {
  return value.trim().toLowerCase();
}

function rowDigest(row: ProductCsvNormalizedRow) {
  return createHash("sha256").update(JSON.stringify(row)).digest("hex");
}

async function managedOrganization(request: FastifyRequest, requestedOrganizationId?: string) {
  const explicit = requestedOrganizationId?.trim();
  const where: Prisma.OrganizationMembershipWhereInput = {
    userId: request.user.sub,
    isActive: true,
    role: { in: ["OWNER", "ADMIN", "MANAGER"] },
    user: { isActive: true },
    organization: { isActive: true },
  };
  if (explicit) {
    const membership = await prisma.organizationMembership.findFirst({
      where: { ...where, organizationId: explicit },
      select: { organizationId: true },
    });
    return membership?.organizationId ?? null;
  }
  const memberships = await prisma.organizationMembership.findMany({
    where,
    take: 2,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { organizationId: true },
  });
  return memberships.length === 1 ? memberships[0].organizationId : null;
}

async function uploadBody(request: FastifyRequest): Promise<Buffer> {
  const multipartRequest = request as FastifyRequest & { isMultipart?: () => boolean; file?: (options?: { limits?: { fileSize?: number } }) => Promise<{ toBuffer: () => Promise<Buffer> } | undefined> };
  if (multipartRequest.isMultipart?.()) {
    const file = await multipartRequest.file?.({ limits: { fileSize: MAX_CSV_BYTES } });
    if (!file) throw new Error("Choose a CSV file before reviewing it.");
    return file.toBuffer();
  }
  const body = request.body;
  if (Buffer.isBuffer(body)) return body;
  throw new Error("Choose a CSV file before reviewing it.");
}

function parseIsActive(value: string | undefined, errors: string[]) {
  const text = value?.trim().toLowerCase();
  if (!text) return true;
  if (text === "true") return true;
  if (text === "false") return false;
  errors.push("is_active must be true or false.");
  return true;
}

async function parsePreview(input: Buffer, organizationId: string): Promise<ProductCsvNormalizedRow[]> {
  const bytes = input.byteLength;
  if (bytes > MAX_CSV_BYTES) throw new Error("CSV files must be 5 MiB or smaller.");
  let decoded: string;
  try {
    decoded = decodeUtf8Csv(input);
  } catch {
    throw new Error("CSV contains invalid UTF-8. Save the file as UTF-8 and review it again.");
  }
  let parsed: string[][];
  try {
    parsed = parseCsv(decoded);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Invalid CSV.");
  }
  if (!parsed.length) throw new Error("CSV must include a header row.");
  const headers = parsed[0].map(normalizedHeader);
  if (headers.length !== new Set(headers).size) throw new Error("CSV headers must be unique.");
  for (const required of REQUIRED_HEADERS) if (!headers.includes(required)) throw new Error(`CSV is missing required header "${required}".`);
  for (const header of headers) {
    if (INVENTORY_HEADERS.has(header)) throw new Error(`Inventory-bearing header "${header}" is not supported for product imports.`);
    if (!ALLOWED_HEADERS.has(header)) throw new Error(`Unsupported CSV header "${header}".`);
  }
  const data = parsed.slice(1);
  if (data.length > MAX_CSV_ROWS) throw new Error(`CSV imports are limited to ${MAX_CSV_ROWS.toLocaleString()} rows.`);
  const existing = await prisma.product.findMany({
    where: {
      organizationId,
      OR: [
        { barcodeValue: { in: data.map((row) => nullable(row[headers.indexOf("upc")])).filter((value): value is string => Boolean(value)) } },
        { name: { in: data.map((row) => nullable(row[headers.indexOf("name")])).filter((value): value is string => Boolean(value)), mode: "insensitive" } },
      ],
    },
    select: { barcodeValue: true, name: true },
  });
  const existingUpcs = new Set(existing.map((product) => product.barcodeValue).filter((value): value is string => Boolean(value)));
  const existingNames = new Set(existing.map((product) => normalizedKey(product.name)));
  const rows = data.map((values, index): ProductCsvNormalizedRow => {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (values.length !== headers.length) errors.push("Row has a different number of columns than the header.");
    const value = (header: string) => values[headers.indexOf(header)];
    const upc = nullable(value("upc"));
    const name = nullable(value("name"));
    const manufacturer = nullable(value("manufacturer"));
    const description = nullable(value("description"));
    const packageSize = nullable(value("package_size"));
    const category = nullable(value("category"));
    const isActive = parseIsActive(value("is_active"), errors);
    if (!name) errors.push("name is required.");
    if (upc && upc.length > 64) errors.push("upc must be 64 characters or fewer.");
    if (name && name.length > 300) errors.push("name must be 300 characters or fewer.");
    if (manufacturer && manufacturer.length > 200) errors.push("manufacturer must be 200 characters or fewer.");
    if (description && description.length > 2000) errors.push("description must be 2,000 characters or fewer.");
    if (packageSize && packageSize.length > 120) errors.push("package_size must be 120 characters or fewer.");
    // Category is a global legacy model, not a tenant-owned domain.
    const categoryId = null;
    if (category) errors.push("Category imports are not supported until tenant-scoped categories are available. Leave category blank.");
    if (upc && existingUpcs.has(upc)) errors.push(`UPC "${upc}" already exists in this organization.`);
    if (name && existingNames.has(normalizedKey(name))) warnings.push(`Name "${name}" already exists in this organization.`);
    return { row: index + 2, status: errors.length ? "error" : warnings.length ? "warning" : "valid", errors, warnings, upc, name, manufacturer, description, packageSize, category, categoryId, isActive };
  });
  for (const key of ["upc", "name"] as const) {
    const values = new Map<string, ProductCsvNormalizedRow[]>();
    for (const row of rows) {
      const value = row[key];
      if (!value) continue;
      const normalized = key === "name" ? normalizedKey(value) : value;
      values.set(normalized, [...(values.get(normalized) ?? []), row]);
    }
    for (const [value, duplicateRows] of values) if (duplicateRows.length > 1) {
      for (const row of duplicateRows) {
        (key === "upc" ? row.errors : row.warnings).push(`Duplicate ${key} "${value}" in this CSV.`);
        row.status = row.errors.length ? "error" : "warning";
      }
    }
  }
  return rows;
}

function totals(rows: ProductCsvNormalizedRow[]) {
  return {
    rows: rows.length,
    valid: rows.filter((row) => row.status === "valid").length,
    warnings: rows.filter((row) => row.status === "warning").length,
    errors: rows.filter((row) => row.status === "error").length,
  };
}

function productCsvTemplate() {
  return encodeCsvRow([...REQUIRED_HEADERS, ...OPTIONAL_HEADERS]);
}

function errorCsv(rows: ProductCsvNormalizedRow[]) {
  return encodeCsvRow(["row", ...REQUIRED_HEADERS, ...OPTIONAL_HEADERS, "errors"])
    + rows.filter((row) => row.status === "error").map((row) => encodeCsvRow([
      row.row, row.upc, row.name, row.manufacturer, row.description,
      row.packageSize, row.category, String(row.isActive), row.errors.join(" "),
    ])).join("");
}

function freezeRows(rows: ProductCsvNormalizedRow[]) {
  return rows.map((row) => Object.freeze({
    ...row,
    errors: Object.freeze([...row.errors]),
    warnings: Object.freeze([...row.warnings]),
  }) as ProductCsvNormalizedRow);
}

export async function productCsvRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);
  app.addContentTypeParser("text/csv", { parseAs: "buffer" }, (_request, body, done) => done(null, body));

  app.post("/import/preview", { bodyLimit: MAX_CSV_BYTES }, async (request, reply) => {
    const organizationId = await managedOrganization(request, (request.query as { organizationId?: string }).organizationId);
    if (!organizationId) return reply.code(404).send({ error: "organization not found" });
    try {
      const rows = freezeRows(await parsePreview(await uploadBody(request), organizationId));
      cleanPreviews();
      const preview: Preview = {
        previewId: randomUUID(),
        actorUserId: request.user.sub,
        organizationId,
        expiresAt: new Date(Date.now() + PREVIEW_TTL_MS),
        rows,
        rowHashes: rows.map(rowDigest),
        digest: digestRows(rows),
      };
      previews.set(preview.previewId, preview);
      return { previewId: preview.previewId, organizationId, expiresAt: preview.expiresAt.toISOString(), totals: totals(rows), rows, errorCsv: errorCsv(rows) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Invalid CSV." });
    }
  });

  app.post("/import/commit", async (request, reply) => {
    const parsed = productCsvCommitSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const preview = previews.get(parsed.data.previewId);
    if (!preview || preview.actorUserId !== request.user.sub || preview.organizationId !== parsed.data.organizationId || preview.expiresAt.getTime() <= Date.now()) {
      return reply.code(404).send({ error: "preview not found or expired" });
    }
    // Claim once before any await: names and blank UPCs are not unique, so the
    // database cannot stop concurrent replay of those rows. Failed commits need
    // another review; no partially committed preview is ever retried blindly.
    previews.delete(preview.previewId);
    const result = await prisma.$transaction(async (tx) => {
      const authorized = await tx.$queryRaw<Array<{ organizationId: string }>>`
        SELECT membership."organizationId"
        FROM "OrganizationMembership" AS membership
        INNER JOIN "Organization" AS organization ON organization."id" = membership."organizationId"
        INNER JOIN "User" AS actor ON actor."id" = membership."userId"
        WHERE membership."userId" = ${request.user.sub}
          AND membership."organizationId" = ${preview.organizationId}
          AND membership."isActive" = TRUE
          AND membership."role" IN ('OWNER', 'ADMIN', 'MANAGER')
          AND organization."isActive" = TRUE
          AND actor."isActive" = TRUE
        FOR UPDATE OF membership, organization, actor
      `;
      if (authorized.length !== 1) return { status: "forbidden" as const };
      if (
        preview.expiresAt.getTime() <= Date.now()
        || preview.digest !== digestRows(preview.rows)
        || preview.rowHashes.length !== preview.rows.length
        || preview.rows.some((row, index) => rowDigest(row) !== preview.rowHashes[index])
      ) return { status: "stale" as const };
      if (preview.rows.some((row) => row.status === "error" || !row.name || row.category || row.categoryId)) return { status: "invalid" as const };
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`product-csv:${preview.organizationId}`}))`;
      const upcs = preview.rows.map((row) => row.upc).filter((value): value is string => Boolean(value));
      // Product names are not unique in the commercial model. Only UPCs block writes.
      const existing = await tx.product.findMany({ where: { organizationId: preview.organizationId, barcodeValue: { in: upcs } }, select: { barcodeValue: true } });
      if (existing.length || preview.expiresAt.getTime() <= Date.now()) return { status: "stale" as const };
      await tx.product.createMany({ data: preview.rows.map((row) => ({ organizationId: preview.organizationId, barcodeValue: row.upc, name: row.name!, manufacturer: row.manufacturer, description: row.description, packageSize: row.packageSize, isActive: row.isActive })) });
      return { status: "created" as const, count: preview.rows.length };
    }).catch((error: unknown) => {
      // Other writers need not share this route's advisory lock. The database's
      // tenant/UPC unique constraint rolls back the whole batch if a writer wins.
      if (isUniqueConstraintError(error)) return { status: "stale" as const };
      throw error;
    });
    if (result.status === "forbidden") return reply.code(403).send({ error: "organization manager access required" });
    if (result.status === "invalid") return reply.code(409).send({ error: "Fix CSV errors before importing." });
    if (result.status === "stale") return reply.code(409).send({ error: "This preview is stale. Review the CSV again before importing." });
    return reply.code(201).send({ imported: result.count });
  });

  app.get("/export.csv", async (request, reply) => {
    const organizationId = await managedOrganization(request, (request.query as { organizationId?: string }).organizationId);
    if (!organizationId) return reply.code(404).send({ error: "organization not found" });
    const products = await prisma.product.findMany({ where: { organizationId }, orderBy: { name: "asc" } });
    let csv = productCsvTemplate();
    for (const product of products) csv += encodeCsvRow([product.barcodeValue, product.name, product.manufacturer, product.description, product.packageSize, null, product.isActive ? "true" : "false"]);
    return reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="products-${new Date().toISOString().slice(0, 10)}.csv"`).send(csv);
  });
}
