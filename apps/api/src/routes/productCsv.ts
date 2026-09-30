import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Prisma } from "@prisma/client";
import { ambiguousRetailBarcodeAlternate, inferRetailBarcodeFormat, normalizeRetailBarcode, preferredRetailBarcode, productCsvCommitSchema, retailBarcodeEquivalents, upcEAliasForRetailBarcode, type ProductCsvNormalizedRow, type RetailBarcodeFormat } from "@continuixai/shared";
import { decodeUtf8Csv, encodeCsvRow, parseCsv, stripCsvFormulaGuard } from "../lib/csv.js";
import { prisma } from "../lib/prisma.js";
import { isUniqueConstraintError } from "../lib/prismaErrors.js";
import { lockActorOrganizationAccess } from "../lib/accessLocking.js";
import { BARCODE_ALIAS_SOURCE, BARCODE_PRIMARY_SOURCE, MANAGED_BARCODE_SOURCES, lockProductBarcodeWrites, retailIdentifierTypesForValue } from "../lib/productBarcodeIdentity.js";

const MAX_CSV_BYTES = 5 * 1024 * 1024;
const MAX_CSV_ROWS = 10_000;
const PREVIEW_TTL_MS = 15 * 60 * 1000;
const MAX_PREVIEWS = 100;
const REQUIRED_HEADERS = ["upc", "name"] as const;
const OPTIONAL_HEADERS = ["manufacturer", "description", "package_size", "category", "is_active", "barcode_format"] as const;
const INVENTORY_HEADERS = new Set(["quantity", "on_hand", "committed", "incoming"]);
const ALLOWED_HEADERS = new Set<string>([...REQUIRED_HEADERS, ...OPTIONAL_HEADERS]);
const RETAIL_IDENTIFIER_TYPES = ["UPC", "EAN", "GTIN"] as const;
const LOOKUP_CHUNK_SIZE = 500;

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

function chunks<T>(values: T[], size = LOOKUP_CHUNK_SIZE) {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function parseBarcodeFormat(value: string | undefined, errors: string[]): RetailBarcodeFormat | null {
  const text = nullable(value);
  if (!text) return null;
  const normalized = text.toUpperCase().replaceAll("-", "_");
  if (["UPC_E", "EAN_8", "UPC_A", "EAN_13"].includes(normalized)) return normalized as RetailBarcodeFormat;
  errors.push("barcode_format must be UPC_E, EAN_8, UPC_A, or EAN_13.");
  return null;
}

function csvBarcode(rawUpc: string | null, format: RetailBarcodeFormat | null, errors: string[]) {
  if (!rawUpc) {
    if (format) errors.push("upc is required when barcode_format is provided.");
    return { upc: null, barcodeAlias: null, canonicalFormat: null };
  }
  if (!format && /^\d{8}$/.test(rawUpc) && ambiguousRetailBarcodeAlternate(rawUpc)) {
    errors.push("This 8-digit code can be UPC-E or EAN-8. Set barcode_format to UPC_E or EAN_8.");
    return { upc: rawUpc, barcodeAlias: null, canonicalFormat: null };
  }
  const upc = format ? normalizeRetailBarcode(rawUpc, format) : preferredRetailBarcode(rawUpc);
  if (!upc) {
    errors.push(`upc is not a valid ${format?.replace("_", "-") ?? "retail barcode"}.`);
    return { upc: rawUpc, barcodeAlias: null, canonicalFormat: null };
  }
  const canonicalFormat = /^\d{12}$/.test(upc)
    ? (inferRetailBarcodeFormat(upc) === "UPC_A" ? "UPC_A" : null)
    : /^\d{13}$/.test(upc)
      ? (inferRetailBarcodeFormat(upc) === "EAN_13" ? "EAN_13" : null)
      : /^\d{8}$/.test(upc)
        ? (format === "EAN_8" ? "EAN_8" : inferRetailBarcodeFormat(upc))
        : null;
  const inferredUpcIdentity = canonicalFormat === "UPC_A";
  return {
    upc,
    barcodeAlias: inferredUpcIdentity ? upcEAliasForRetailBarcode(upc) : null,
    canonicalFormat,
  };
}

type ExistingProductIdentity = {
  id?: string;
  barcodeValue: string | null;
  name?: string;
  identifiers?: Array<{ value: string; type: string }>;
};

type ExistingIdentityIndex = {
  primaryValues: Set<string>;
  identifierKeys: Set<string>;
  names: Set<string>;
};

const identifierKey = (type: string, value: string) => `${type}\u0000${value}`;

function indexExistingProducts(products: ExistingProductIdentity[]): ExistingIdentityIndex {
  const index: ExistingIdentityIndex = {
    primaryValues: new Set(),
    identifierKeys: new Set(),
    names: new Set(),
  };
  for (const product of products) {
    if (product.barcodeValue) index.primaryValues.add(product.barcodeValue);
    if (product.name) index.names.add(normalizedKey(product.name));
    for (const identifier of product.identifiers ?? []) {
      index.identifierKeys.add(identifierKey(identifier.type, identifier.value));
    }
  }
  return index;
}

function rowConflictsWithIndex(row: ProductCsvNormalizedRow, index: ExistingIdentityIndex) {
  if (!row.upc) return false;
  for (const value of retailBarcodeEquivalents(row.upc)) {
    if (index.primaryValues.has(value)) return true;
    for (const type of retailIdentifierTypesForValue(value, row.barcodeFormat, row.barcodeAlias)) {
      if (index.identifierKeys.has(identifierKey(type, value))) return true;
    }
  }
  if (row.barcodeAlias) {
    if (index.identifierKeys.has(identifierKey("UPC", row.barcodeAlias))) return true;
    if (index.identifierKeys.has(identifierKey("GTIN", row.barcodeAlias))) return true;
  }
  return false;
}

async function existingPreviewProducts(
  organizationId: string,
  rows: ProductCsvNormalizedRow[],
): Promise<ExistingProductIdentity[]> {
  const lookupValues = [...new Set(rows.flatMap((row) => row.upc
    ? [...retailBarcodeEquivalents(row.upc), ...(row.barcodeAlias ? [row.barcodeAlias] : [])]
    : []))];
  const names = [...new Set(rows.map((row) => row.name).filter((value): value is string => Boolean(value)))];
  const existing: ExistingProductIdentity[] = [];
  for (const values of chunks(lookupValues)) {
    existing.push(...await prisma.product.findMany({
      where: {
        organizationId,
        OR: [
          { barcodeValue: { in: values } },
          { identifiers: { some: { value: { in: values }, type: { in: [...RETAIL_IDENTIFIER_TYPES] } } } },
        ],
      },
      select: {
        id: true,
        barcodeValue: true,
        name: true,
        identifiers: {
          where: { value: { in: values }, type: { in: [...RETAIL_IDENTIFIER_TYPES] } },
          select: { value: true, type: true },
        },
      },
    }));
  }
  for (const nameChunk of chunks(names)) {
    existing.push(...await prisma.product.findMany({
      where: { organizationId, name: { in: nameChunk, mode: "insensitive" } },
      select: { id: true, barcodeValue: true, name: true, identifiers: { select: { value: true, type: true } } },
    }));
  }
  return existing;
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
  const rows = data.map((values, index): ProductCsvNormalizedRow => {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (values.length !== headers.length) errors.push("Row has a different number of columns than the header.");
    const value = (header: string) => {
      const headerIndex = headers.indexOf(header);
      return headerIndex >= 0 ? values[headerIndex] : undefined;
    };
    const rawUpc = nullable(value("upc"));
    const barcodeFormat = parseBarcodeFormat(value("barcode_format"), errors);
    const { upc, barcodeAlias, canonicalFormat } = csvBarcode(rawUpc, barcodeFormat, errors);
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
    return { row: index + 2, status: errors.length ? "error" : warnings.length ? "warning" : "valid", errors, warnings, upc, barcodeFormat: canonicalFormat, barcodeAlias, name, manufacturer, description, packageSize, category, categoryId, isActive };
  });
  const existing = await existingPreviewProducts(organizationId, rows);
  const existingIndex = indexExistingProducts(existing);
  for (const row of rows) {
    if (row.upc && rowConflictsWithIndex(row, existingIndex)) {
      row.errors.push(`UPC "${row.upc}" already exists in this organization.`);
    }
    if (row.name && existingIndex.names.has(normalizedKey(row.name))) row.warnings.push(`Name "${row.name}" already exists in this organization.`);
    row.status = row.errors.length ? "error" : row.warnings.length ? "warning" : "valid";
  }
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
      row.packageSize, row.category, String(row.isActive), row.barcodeFormat, row.errors.join(" "),
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
      const authorized = await lockActorOrganizationAccess(tx, request.user.sub, preview.organizationId, "update");
      if (!authorized || !["OWNER", "ADMIN", "MANAGER"].includes(authorized.organizationRole)) return { status: "forbidden" as const };
      if (
        preview.expiresAt.getTime() <= Date.now()
        || preview.digest !== digestRows(preview.rows)
        || preview.rowHashes.length !== preview.rows.length
        || preview.rows.some((row, index) => rowDigest(row) !== preview.rowHashes[index])
      ) return { status: "stale" as const };
      if (preview.rows.some((row) => row.status === "error" || !row.name || row.category || row.categoryId)) return { status: "invalid" as const };
      await lockProductBarcodeWrites(tx, preview.organizationId);
      const lookupValues = [...new Set(preview.rows.flatMap((row) => row.upc
        ? [...retailBarcodeEquivalents(row.upc), ...(row.barcodeAlias ? [row.barcodeAlias] : [])]
        : []))];
      // Product names are not unique in the commercial model. Only retail
      // identities block writes. Chunking keeps the advertised 10k-row import
      // below PostgreSQL/driver bind-parameter limits.
      const existing: ExistingProductIdentity[] = [];
      for (const values of chunks(lookupValues)) {
        existing.push(...await tx.product.findMany({
          where: {
            organizationId: preview.organizationId,
            OR: [
              { barcodeValue: { in: values } },
              { identifiers: { some: { value: { in: values }, type: { in: [...RETAIL_IDENTIFIER_TYPES] } } } },
            ],
          },
          select: {
            id: true,
            barcodeValue: true,
            name: true,
            identifiers: {
              where: { value: { in: values }, type: { in: [...RETAIL_IDENTIFIER_TYPES] } },
              select: { value: true, type: true },
            },
          },
        }));
      }
      const existingIndex = indexExistingProducts(existing);
      if (preview.rows.some((row) => rowConflictsWithIndex(row, existingIndex))
        || preview.expiresAt.getTime() <= Date.now()) return { status: "stale" as const };
      await tx.product.createMany({ data: preview.rows.map((row) => ({ organizationId: preview.organizationId, barcodeValue: row.upc, name: row.name!, manufacturer: row.manufacturer, description: row.description, packageSize: row.packageSize, isActive: row.isActive })) });
      const identifierRows = preview.rows.filter((row) => row.upc && (row.barcodeAlias || row.barcodeFormat === "EAN_8"));
      if (identifierRows.length > 0) {
        const createdProducts: Array<{ id: string; barcodeValue: string | null }> = [];
        for (const values of chunks(identifierRows.map((row) => row.upc!))) {
          createdProducts.push(...await tx.product.findMany({
            where: { organizationId: preview.organizationId, barcodeValue: { in: values } },
            select: { id: true, barcodeValue: true },
          }));
        }
        const productIdByBarcode = new Map(createdProducts.map((product) => [product.barcodeValue, product.id]));
        const identifierData = identifierRows.flatMap((row) => [
          ...(row.barcodeAlias
            ? [{
                organizationId: preview.organizationId,
                productId: productIdByBarcode.get(row.upc) ?? "",
                type: "UPC" as const,
                value: row.barcodeAlias,
                source: BARCODE_ALIAS_SOURCE,
              }]
            : []),
          ...(row.barcodeFormat === "EAN_8"
            ? [{
                organizationId: preview.organizationId,
                productId: productIdByBarcode.get(row.upc) ?? "",
                type: "EAN" as const,
                value: row.upc!,
                source: BARCODE_PRIMARY_SOURCE,
              }]
            : []),
        ]);
        if (identifierData.some((identifier) => !identifier.productId)) throw new Error("PRODUCT_ALIAS_TARGET_MISSING");
        await tx.productIdentifier.createMany({ data: identifierData });
      }
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
    const products = await prisma.product.findMany({
      where: { organizationId },
      orderBy: { name: "asc" },
      include: {
        identifiers: {
          where: { source: { in: [...MANAGED_BARCODE_SOURCES] } },
          select: { type: true, value: true, source: true },
        },
      },
    });
    let csv = productCsvTemplate();
    for (const product of products) {
      const barcodeValue = product.barcodeValue ?? "";
      const managedIdentifiers = product.identifiers ?? [];
      const hasEanPrimaryMarker = managedIdentifiers.some((identifier) =>
        identifier.source === BARCODE_PRIMARY_SOURCE
        && identifier.type === "EAN"
        && identifier.value === barcodeValue,
      );
      const hasManagedUpcAlias = managedIdentifiers.some((identifier) =>
        identifier.source === BARCODE_ALIAS_SOURCE
        && identifier.type === "UPC"
        && identifier.value === upcEAliasForRetailBarcode(barcodeValue),
      );
      const barcodeFormat = hasEanPrimaryMarker && /^\d{8}$/.test(barcodeValue)
        ? "EAN_8"
        : hasManagedUpcAlias && /^\d{12}$/.test(barcodeValue)
          ? "UPC_A"
          : inferRetailBarcodeFormat(barcodeValue);
      csv += encodeCsvRow([product.barcodeValue, product.name, product.manufacturer, product.description, product.packageSize, null, product.isActive ? "true" : "false", barcodeFormat]);
    }
    return reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="products-${new Date().toISOString().slice(0, 10)}.csv"`).send(csv);
  });
}
