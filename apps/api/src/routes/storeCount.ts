import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { ambiguousRetailBarcodeAlternate, preferredRetailBarcode, retailBarcodeEquivalents, upcEAliasForRetailBarcode } from "@continuixai/shared";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { isUniqueConstraintError } from "../lib/prismaErrors.js";
import { resolveProduct } from "../lib/barcodeLookup/index.js";
import { matchExistingCategory } from "../lib/barcodeLookup/categoryMatch.js";
import { ensurePilotSiteForUser } from "../lib/pilotSite.js";
import { assignedCountWhere, countWriteError, hasRequiredCountObservations, isCurrentCountAssignee, lockCountLocation, lockCountProduct, lockCountScope, requireCountWriter } from "../lib/storeCountWriteAccess.js";
import { lockSiteAndMembership } from "../lib/accessLocking.js";
import { BARCODE_ALIAS_SOURCE, lockProductBarcodeWrites, retailBarcodeDuplicateWhere, retailBarcodeProductWhere } from "../lib/productBarcodeIdentity.js";

// Cycle-count MVP: when set, the session expects/routes only that ABC class
// of product at the site instead of the full catalog. Omitted (undefined) ==
// the original full-site count, byte-for-byte unchanged from before this field
// existed — see the /sessions handler.
const cycleCountClassSchema = z.enum(["A", "B", "C"]);

const createSessionSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  siteId: z.string().trim().min(1).optional(),
  cycleCountClass: cycleCountClassSchema.optional(),
  replaceEmptySessionId: z.string().trim().min(1).optional(),
});

const scanSchema = z.object({
  barcodeValue: z.string().trim().min(1).max(128),
  locationId: z.string().trim().min(1),
  quantityDelta: z.number().int().min(0).max(999).default(1),
  clientScanId: z.string().trim().min(1).max(160).optional(),
  // Retailer module: optional use-by/expiration date for the units just
  // scanned. Coerced from an ISO date/datetime string; omit (or send null)
  // to leave any previously recorded date on this entry untouched (see the
  // scan handler). null is normalized to undefined first — z.coerce.date()
  // on its own would otherwise turn a literal null into new Date(null),
  // i.e. the Unix epoch, which is a valid-looking but wrong date.
  expiresAt: z.preprocess((value) => (value === null ? undefined : value), z.coerce.date().optional()),
});

const EXPIRING_SOON_DEFAULT_DAYS = 14;
const EXPIRING_SOON_MAX_DAYS = 90;
const expiringQuerySchema = z.object({
  withinDays: z.coerce.number().int().min(1).max(EXPIRING_SOON_MAX_DAYS).default(EXPIRING_SOON_DEFAULT_DAYS),
});

const setQuantitySchema = z.object({
  quantity: z.number().int().min(0).max(999999),
  expectedQuantity: z.number().int().min(0).max(999999),
});

type SessionRow = Awaited<ReturnType<typeof prisma.storeCountSession.findUnique>>;

export type SummaryEntryInput = {
  productId: string | null;
  barcodeValue: string;
  quantity: number;
  locationId: string;
  location: { code: string };
  product: { name: string; packageSize: string | null } | null;
};

export type SummaryRow = {
  key: string;
  productId: string | null;
  barcodeValue: string;
  productName: string | null;
  packageSize: string | null;
  total: number;
  byLocation: Record<string, { locationCode: string; quantity: number }>;
};

type InventoryExpectationGroup = {
  productId: string;
  _sum: { quantity: number | Prisma.Decimal | null };
};

type RequiredLocationHint = {
  locationId: string;
  location: { id: string; sortOrder: number; code: string };
};

type DiscrepancyExpectationInput = {
  productId: string;
  expectedStoreQty: number | Prisma.Decimal;
};

type DiscrepancyActualGroup = {
  productId: string | null;
  _sum: { quantity: number | null };
};

export type DiscrepancyRowData = {
  sessionId: string;
  productId: string;
  expectedStoreQty: number;
  actualStoreQty: number;
  difference: number;
};

export function buildExpectationSnapshotData(rows: InventoryExpectationGroup[], sessionId: string) {
  return rows.map((row) => ({
    sessionId,
    productId: row.productId,
    expectedStoreQty: row._sum.quantity ?? 0,
  }));
}

export function buildLocationVisitData(rows: RequiredLocationHint[], sessionId: string) {
  const locations = [...rows]
    .sort((a, b) =>
      a.location.sortOrder - b.location.sortOrder
      || a.location.code.localeCompare(b.location.code)
      || a.location.id.localeCompare(b.location.id),
    );
  const seen = new Set<string>();
  return locations.flatMap((row) => {
    if (seen.has(row.locationId)) return [];
    seen.add(row.locationId);
    return [{ sessionId, locationId: row.locationId }];
  });
}

export function buildDiscrepancyRows(
  expectations: DiscrepancyExpectationInput[],
  actuals: DiscrepancyActualGroup[],
  sessionId: string,
): DiscrepancyRowData[] {
  const expectedByProduct = new Map(
    expectations.map((expectation) => [expectation.productId, Number(expectation.expectedStoreQty)]),
  );
  const actualByProduct = new Map(
    actuals.flatMap((actual) => actual.productId
      ? [[actual.productId, actual._sum.quantity ?? 0] as const]
      : []),
  );
  const productIds = new Set([...expectedByProduct.keys(), ...actualByProduct.keys()]);

  return [...productIds]
    .sort((a, b) => a.localeCompare(b))
    .flatMap((productId) => {
      const expectedStoreQty = expectedByProduct.get(productId) ?? 0;
      const actualStoreQty = actualByProduct.get(productId) ?? 0;
      const difference = actualStoreQty - expectedStoreQty;
      return difference === 0
        ? []
        : [{ sessionId, productId, expectedStoreQty, actualStoreQty, difference }];
    });
}

export async function calculateStoreCountDiscrepancies(
  tx: Prisma.TransactionClient,
  scope: { sessionId: string; siteId: string; organizationId: string },
) {
  const unverifiedVisits = await tx.storeCountLocationVisit.count({
    where: {
      sessionId: scope.sessionId,
      status: { not: "VERIFIED" },
      location: { siteId: scope.siteId },
    },
  });
  if (unverifiedVisits > 0 || !await hasRequiredCountObservations(tx, scope.sessionId)) return { finalized: false as const, discrepancies: [] };

  const expectations = await tx.storeCountExpectation.findMany({
    where: {
      sessionId: scope.sessionId,
      product: { organizationId: scope.organizationId },
    },
    select: { productId: true, expectedStoreQty: true },
    orderBy: { productId: "asc" },
  });
  const actuals = await tx.storeCountEntry.groupBy({
    by: ["productId"],
    where: {
      sessionId: scope.sessionId,
      productId: { not: null },
      location: { siteId: scope.siteId },
      product: { organizationId: scope.organizationId },
    },
    _sum: { quantity: true },
    orderBy: { productId: "asc" },
  });
  const discrepancyRows = buildDiscrepancyRows(expectations, actuals, scope.sessionId);
  const existingDiscrepancies = await tx.storeCountDiscrepancy.findMany({
    where: {
      sessionId: scope.sessionId,
      product: { organizationId: scope.organizationId },
    },
    orderBy: [{ productId: "asc" }, { id: "asc" }],
  });
  const existingByProduct = new Map(existingDiscrepancies.map((row) => [row.productId, row]));
  const discrepancyByProduct = new Map(discrepancyRows.map((row) => [row.productId, row]));
  const productIds = [...new Set([
    ...expectations.map((row) => row.productId),
    ...actuals.flatMap((row) => row.productId ? [row.productId] : []),
  ])].sort((a, b) => a.localeCompare(b));

  for (const productId of productIds) {
    const row = discrepancyByProduct.get(productId);
    const existing = existingByProduct.get(productId);
    if (!row) {
      if (existing && (existing.status === "OPEN" || existing.status === "RESOLVED")) {
        const expectedStoreQty = Number(
          expectations.find((expectation) => expectation.productId === productId)?.expectedStoreQty ?? 0,
        );
        const actualStoreQty = actuals.find((actual) => actual.productId === productId)?._sum.quantity ?? 0;
        await tx.storeCountDiscrepancy.update({
          where: { id: existing.id },
          data: { expectedStoreQty, actualStoreQty, difference: 0, status: "RESOLVED" },
        });
      }
      continue;
    }
    if (existing) {
      if (existing.status === "APPROVED" || existing.status === "REJECTED") continue;
      await tx.storeCountDiscrepancy.update({
        where: { id: existing.id },
        data: {
          expectedStoreQty: row.expectedStoreQty,
          actualStoreQty: row.actualStoreQty,
          difference: row.difference,
          ...(existing.status === "RESOLVED" ? { status: "OPEN" as const } : {}),
        },
      });
      continue;
    }
    await tx.storeCountDiscrepancy.upsert({
      where: { sessionId_productId: { sessionId: scope.sessionId, productId } },
      update: {
        expectedStoreQty: row.expectedStoreQty,
        actualStoreQty: row.actualStoreQty,
        difference: row.difference,
      },
      create: row,
    });
  }

  const discrepancies = await tx.storeCountDiscrepancy.findMany({
    where: {
      sessionId: scope.sessionId,
      product: { organizationId: scope.organizationId },
    },
    orderBy: [{ productId: "asc" }, { id: "asc" }],
  });
  return { finalized: true as const, discrepancies };
}

async function rejectApprovedProductWrite(tx: Prisma.TransactionClient, sessionId: string, productId: string | null) {
  if (!productId) return;
  const rows = await tx.$queryRaw<Array<{ status: string }>>`
    SELECT "status" FROM "StoreCountDiscrepancy"
    WHERE "sessionId" = ${sessionId} AND "productId" = ${productId} AND "status" = 'APPROVED'
  `;
  if (rows.some((row) => row.status === "APPROVED")) throw new Error("PRODUCT_BASELINE_APPROVED");
}

export function buildSummaryRows(entries: SummaryEntryInput[]): SummaryRow[] {
  const byKey = new Map<string, SummaryRow>();
  for (const entry of entries) {
    const key = entry.productId ?? `barcode:${entry.barcodeValue}`;
    let row = byKey.get(key);
    if (!row) {
      row = {
        key,
        productId: entry.productId,
        barcodeValue: entry.barcodeValue,
        productName: entry.product?.name ?? null,
        packageSize: entry.product?.packageSize ?? null,
        total: 0,
        byLocation: {},
      };
      byKey.set(key, row);
    }
    row.total += entry.quantity;
    const existingLoc = row.byLocation[entry.locationId];
    row.byLocation[entry.locationId] = {
      locationCode: entry.location.code,
      quantity: (existingLoc?.quantity ?? 0) + entry.quantity,
    };
  }
  return [...byKey.values()].sort((a, b) =>
    (a.productName || a.barcodeValue).localeCompare(b.productName || b.barcodeValue),
  );
}

async function resolveAuthorizedSite(userId: string, requestedSiteId?: string, role?: string) {
  const sites = await prisma.site.findMany({
    where: {
      isActive: true,
      organization: {
        isActive: true,
        memberships: { some: { userId, isActive: true } },
      },
      // ADMIN role users may access every site within an organization they
      // belong to, without needing an individual per-site membership record.
      // Still strictly org-scoped above: an ADMIN cannot see another org's sites.
      ...(role === "ADMIN" ? {} : { memberships: { some: { userId, isActive: true } } }),
      ...(requestedSiteId ? { id: requestedSiteId } : {}),
    },
    orderBy: [{ code: "asc" }, { id: "asc" }],
    select: { id: true, organizationId: true },
  });

  if (requestedSiteId && sites[0]) return sites[0];
  if (!requestedSiteId && sites.length === 1) return sites[0];

  // Preserve the proven single-site pilot bootstrap: a user with an active
  // organization membership may be provisioned onto the one unambiguous site.
  // ensurePilotSiteForUser fails closed once multiple active/assigned sites exist.
  if (!requestedSiteId && role !== "ADMIN") {
    const pilotSite = await ensurePilotSiteForUser(userId, role);
    if (pilotSite && (!requestedSiteId || pilotSite.id === requestedSiteId)) {
      return { id: pilotSite.id, organizationId: pilotSite.organizationId };
    }
  }

  return null;
}

async function assertSessionAccess(
  sessionId: string,
  userId: string,
  role: string,
): Promise<{ ok: true; session: NonNullable<SessionRow> } | { ok: false; code: number; error: string }> {
  const session = await prisma.storeCountSession.findFirst({
    where: {
      id: sessionId,
      OR: [
        { siteId: null, ...(role === "ADMIN" ? {} : { startedById: userId }) },
        {
          site: {
            isActive: true,
            memberships: { some: { userId, isActive: true } },
            organization: {
              isActive: true,
              memberships: { some: { userId, isActive: true } },
            },
          },
        },
      ],
    },
  });
  if (!session) return { ok: false, code: 404, error: "count session not found" };
  return { ok: true, session };
}

async function findOrEnrichProduct(
  barcodeValue: string,
  organizationId: string,
  sessionId: string,
  userId: string,
) {
  const preferredBarcodeValue = preferredRetailBarcode(barcodeValue);
  let lookup: Awaited<ReturnType<typeof resolveProduct>>;
  try {
    lookup = await resolveProduct(preferredBarcodeValue);
  } catch {
    return null;
  }
  if (!lookup.found || !lookup.name?.trim()) return null;
  const lookupName = lookup.name.trim();

  const categories = await prisma.category.findMany({
    where: { isActive: true },
    select: { id: true, name: true, isActive: true },
  });
  const matchedCategory = matchExistingCategory(lookup.category, categories);

  const upcEAlias = upcEAliasForRetailBarcode(preferredBarcodeValue);
  const barcodeFormat = /^\d{12}$/.test(preferredBarcodeValue) ? "UPC_A" as const
    : /^\d{13}$/.test(preferredBarcodeValue) ? "EAN_13" as const
      : null;
  try {
    return await prisma.$transaction(async (tx) => {
      // Auto-enrichment is a catalog write triggered by a count. Re-lock the
      // count's complete authorization scope before that write so a concurrent
      // revocation cannot leave behind a product created by a denied scan.
      const scope = await requireCountWriter(tx, sessionId, userId);
      if (scope.organizationId !== organizationId) throw new Error("COUNT_ACCESS_REVOKED");
      await lockProductBarcodeWrites(tx, organizationId);
      const existing = await tx.product.findMany({
        where: retailBarcodeDuplicateWhere(organizationId, preferredBarcodeValue, barcodeFormat, upcEAlias),
        include: { identifiers: { where: { value: upcEAlias ?? "", type: "UPC" }, select: { value: true, type: true } } },
        take: 2,
      });
      if (existing.length > 1) throw new Error("BARCODE_CATALOG_CONFLICT");
      if (existing[0]) return existing[0];
      return tx.product.create({
        data: {
          organizationId,
          barcodeValue: preferredBarcodeValue,
          name: lookupName,
          manufacturer: lookup.brand?.trim() || null,
          description: lookup.description?.trim() || null,
          packageSize: lookup.size?.trim() || null,
          imageUrl: lookup.imageUrl?.trim() || null,
          categoryId: matchedCategory?.id ?? null,
          isActive: true,
          ...(upcEAlias
            ? {
                identifiers: {
                  create: {
                    organizationId,
                    type: "UPC" as const,
                    value: upcEAlias,
                    source: BARCODE_ALIAS_SOURCE,
                  },
                },
              }
            : {}),
        },
        include: { identifiers: { where: { value: upcEAlias ?? "", type: "UPC" }, select: { value: true, type: true } } },
      });
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const existing = await prisma.product.findMany({
      where: retailBarcodeDuplicateWhere(organizationId, preferredBarcodeValue, barcodeFormat, upcEAlias),
      include: { identifiers: { where: { value: upcEAlias ?? "", type: "UPC" }, select: { value: true, type: true } } },
      take: 2,
    });
    if (existing.length > 1) throw new Error("BARCODE_CATALOG_CONFLICT");
    return existing[0] ?? null;
  }
}

type CountProductIdentity = {
  id: string;
  organizationId: string | null;
  barcodeValue: string | null;
  name: string;
  packageSize?: string | null;
  identifiers?: Array<{
    value: string;
    type: string;
    source?: string | null;
    packagingId?: string | null;
  }>;
};

type ProductIdentityResolution =
  | { status: "found"; product: CountProductIdentity }
  | { status: "missing" }
  | { status: "conflict" }
  | { status: "ambiguous" };

type ProductIdentityDelegate = {
  findMany: (args: Prisma.ProductFindManyArgs) => Promise<unknown>;
};

const barcodeIdentifierSelection = (barcodeValue: string) => ({
  where: {
    OR: [
      { value: { in: [barcodeValue, ...retailBarcodeEquivalents(barcodeValue)] } },
      { type: "UPC" as const, source: BARCODE_ALIAS_SOURCE, packagingId: null },
    ],
  },
  select: { value: true, type: true, source: true, packagingId: true },
});

async function resolveCountProductIdentity(
  products: ProductIdentityDelegate,
  organizationId: string,
  barcodeValue: string,
): Promise<ProductIdentityResolution> {
  const exact = await products.findMany({
    where: { organizationId, barcodeValue: barcodeValue.trim() },
    include: { identifiers: barcodeIdentifierSelection(barcodeValue) },
    take: 2,
  }) as CountProductIdentity[];
  if (exact.length > 1) return { status: "conflict" };
  if (exact[0]) return { status: "found", product: exact[0] };

  const matches = await products.findMany({
    where: retailBarcodeProductWhere(organizationId, barcodeValue),
    include: { identifiers: barcodeIdentifierSelection(barcodeValue) },
    take: 2,
  }) as CountProductIdentity[];
  if (matches.length > 1) return { status: "conflict" };
  if (matches[0]) return { status: "found", product: matches[0] };

  const ambiguousAlternate = ambiguousRetailBarcodeAlternate(barcodeValue);
  if (ambiguousAlternate) {
    const alternateMatches = await products.findMany({
      where: retailBarcodeProductWhere(organizationId, barcodeValue, { includeAmbiguousAlternate: true }),
      include: { identifiers: barcodeIdentifierSelection(barcodeValue) },
      take: 2,
    }) as CountProductIdentity[];
    if (alternateMatches.length > 0) return { status: "conflict" };
    if (/^\d{8}$/.test(barcodeValue.trim())) return { status: "ambiguous" };
  }
  return { status: "missing" };
}

function countEntryBarcodeIdentity(product: CountProductIdentity | null, barcodeValue: string) {
  const scannedBarcodeEquivalents = retailBarcodeEquivalents(barcodeValue);
  const productBarcodeEquivalents = product?.barcodeValue
    ? retailBarcodeEquivalents(product.barcodeValue)
    : [];
  const expectedManagedAlias = product?.barcodeValue
    ? upcEAliasForRetailBarcode(product.barcodeValue)
    : null;
  const managedUpcAlias = product?.identifiers?.find((identifier) =>
    identifier.type === "UPC"
    && identifier.value === expectedManagedAlias
    && identifier.source === BARCODE_ALIAS_SOURCE
    && !identifier.packagingId
  )?.value ?? null;
  const matchedManagedUpcAlias = managedUpcAlias === barcodeValue;
  const productBarcodeSharesRetailIdentity = matchedManagedUpcAlias || productBarcodeEquivalents.some((candidate) =>
    scannedBarcodeEquivalents.includes(candidate),
  );
  const entryIdentityBarcode = matchedManagedUpcAlias && product?.barcodeValue
    ? preferredRetailBarcode(product.barcodeValue)
    : preferredRetailBarcode(barcodeValue);
  return {
    entryIdentityBarcode,
    // A product may also have unrelated supplier/case identifiers. Only let a
    // scan reuse the primary item's historical managed UPC-E row when the
    // scanned value is itself another representation of that primary barcode.
    managedUpcAlias: productBarcodeSharesRetailIdentity ? managedUpcAlias : null,
    equivalentEntryBarcodes: [...new Set([
      ...scannedBarcodeEquivalents,
      ...(productBarcodeSharesRetailIdentity ? productBarcodeEquivalents : []),
      entryIdentityBarcode,
    ])],
  };
}

async function findIdempotentEntry(clientScanId: string, sessionId: string) {
  const log = await prisma.storeCountScanLog.findUnique({
    where: { idempotencyKey: clientScanId },
    include: { entry: { include: { product: true, location: true, countedBy: { select: { id: true, name: true } } } } },
  });
  if (!log) return null;
  if (log.sessionId !== sessionId) return "conflict" as const;
  return log.entry;
}

export async function storeCountRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.post("/sessions", async (request, reply) => {
    const parsed = createSessionSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const userId = request.user.sub;
    if (!userId) return reply.code(401).send({ error: "invalid authenticated user" });

    let authorizedSite = await resolveAuthorizedSite(userId, parsed.data.siteId, request.user.role);
    if (!authorizedSite && !parsed.data.siteId) {
      authorizedSite = await ensurePilotSiteForUser(userId, request.user.role);
    }
    if (!authorizedSite) {
      if (parsed.data.siteId) return reply.code(403).send({ error: "you do not have access to that site" });
      return reply.code(400).send({ error: "select an authorized site before starting a count" });
    }

    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`store-count:${userId}:${authorizedSite.id}`}))`;
      let lockedSite: { id: string; organizationId: string } | null = null;
      let cycleClassConflictChecked = false;
      let cancelledReplacementRetry = false;
      let sessionName = parsed.data.name ?? null;
      let cycleCountClass = parsed.data.cycleCountClass ?? null;

      if (parsed.data.replaceEmptySessionId) {
        // Count mutations establish the global relation order by locking the
        // session before actor/organization/site authorization. Preserve that
        // order here so setup cannot deadlock with a concurrent scan/cancel.
        const replacement = await lockCountScope(tx, parsed.data.replaceEmptySessionId, userId);
        if (!replacement || replacement.siteId !== authorizedSite.id) {
          return { status: "replacement-not-found" as const };
        }
        if (!isCurrentCountAssignee(replacement, userId)) {
          return { status: "replacement-forbidden" as const };
        }
        lockedSite = { id: replacement.siteId, organizationId: replacement.organizationId };
        sessionName = parsed.data.name ?? replacement.name;
        cycleCountClass = parsed.data.cycleCountClass ?? replacement.cycleCountClass;

        if (replacement.status === "CANCELLED") {
          // A lost HTTP response can leave the old session cancelled while its
          // replacement is already active. Resume that replacement below, but
          // never let an old cancelled link create yet another count.
          cancelledReplacementRetry = true;
        } else if (replacement.status !== "ACTIVE") {
          return { status: "replacement-no-longer-active" as const };
        }

        if (replacement.status === "ACTIVE") {
          if (cycleCountClass) {
            // Check every normal conflict before cancelling the old session.
            // Returning a status from an interactive transaction commits prior
            // writes, so doing this afterward could cancel the old count while
            // still responding that no replacement was created.
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cycle-count-class:${lockedSite.id}:${cycleCountClass}`}))`;
            const conflicting = await tx.storeCountSession.findFirst({
              where: {
                id: { not: replacement.id },
                status: "ACTIVE",
                siteId: lockedSite.id,
                cycleCountClass,
              },
              select: { id: true },
            });
            if (conflicting) return { status: "class-locked" as const };
            cycleClassConflictChecked = true;
          }

          // Keep transaction-client operations sequential. Prisma interactive
          // transactions use one database connection, so parallel promises add
          // no throughput and make the authorization/cancellation sequence less
          // explicit when this path is exercised under contention.
          const entryCount = await tx.storeCountEntry.count({
            // Any persisted evidence makes the session nonempty. Do not hide a
            // corrupt/legacy cross-site row behind a relation filter and then
            // cancel the session that owns it.
            where: { sessionId: replacement.id },
          });
          const approvalCount = await tx.storeCountDiscrepancy.count({
            where: { sessionId: replacement.id },
          });
          const progressedLocationCount = await tx.storeCountLocationVisit.count({
            where: { sessionId: replacement.id, status: { not: "PENDING" } },
          });
          if (entryCount > 0 || approvalCount > 0 || progressedLocationCount > 0) {
            return { status: "replacement-has-activity" as const };
          }
          await tx.storeCountSession.update({
            where: { id: replacement.id, siteId: replacement.siteId, status: "ACTIVE" },
            data: { status: "CANCELLED", completedAt: new Date() },
          });
        }
      } else {
        lockedSite = await lockSiteAndMembership(tx, userId, authorizedSite.id, "update");
        if (!lockedSite) return { status: "forbidden" as const };
      }

      // One physical person can only be doing one count at a time: if this user
      // already has ANY active session at this site — full or class-scoped —
      // resume it, exactly as before cycleCountClass existed. Only a genuinely
      // new session reaches the cross-user class freeze below.
      const existing = await tx.storeCountSession.findFirst({
        where: { status: "ACTIVE", ...assignedCountWhere(userId), siteId: lockedSite.id },
        orderBy: { startedAt: "desc" },
      });
      if (existing) return { status: "ok" as const, created: false, session: existing };
      if (cancelledReplacementRetry) {
        return { status: "replacement-no-longer-active" as const };
      }

      if (cycleCountClass) {
        // Cycle-count freeze: at most one ACTIVE session per site per class,
        // across every user — stops two employees from double-counting the
        // same scheduled partial count. Scoped lock (not the per-user one
        // above) so concurrent requests from different users serialize here.
        if (!cycleClassConflictChecked) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cycle-count-class:${lockedSite.id}:${cycleCountClass}`}))`;
          const conflicting = await tx.storeCountSession.findFirst({
            where: { status: "ACTIVE", siteId: lockedSite.id, cycleCountClass },
            select: { id: true },
          });
          if (conflicting) return { status: "class-locked" as const };
        }
      }

      const session = await tx.storeCountSession.create({
        data: {
          name: sessionName,
          startedById: userId,
          assignedToId: userId,
          siteId: lockedSite.id,
          cycleCountClass,
        },
      });
      await tx.storeCountAssignmentEvent.create({
        data: {
          sessionId: session.id,
          fromUserId: null,
          toUserId: userId,
          assignedById: userId,
        },
      });

      const expectationGroups = await tx.inventoryTransaction.groupBy({
        by: ["productId"],
        where: {
          organizationId: lockedSite.organizationId,
          siteId: lockedSite.id,
          product: {
            organizationId: lockedSite.organizationId,
            ...(cycleCountClass ? { cycleCountClass } : {}),
          },
        },
        _sum: { quantity: true },
        orderBy: { productId: "asc" },
      });
      const expectations = buildExpectationSnapshotData(expectationGroups, session.id);
      if (expectations.length > 0) {
        await tx.storeCountExpectation.createMany({ data: expectations });
      }

      const requiredHints = await tx.productLocationHint.findMany({
        where: {
          organizationId: lockedSite.organizationId,
          siteId: lockedSite.id,
          location: { siteId: lockedSite.id, isActive: true },
          product: {
            organizationId: lockedSite.organizationId,
            isActive: true,
            ...(cycleCountClass ? { cycleCountClass } : {}),
          },
        },
        select: {
          productId: true,
          locationId: true,
          evidence: true,
          isRequired: true,
          product: { select: { id: true, barcodeValue: true, name: true, packageSize: true } },
          location: { select: { id: true, sortOrder: true, code: true } },
        },
        orderBy: [
          { location: { sortOrder: "asc" } },
          { location: { code: "asc" } },
          { location: { id: "asc" } },
        ],
      });
      await tx.storeCountSession.update({ where: { id: session.id }, data: { routeSnapshot: requiredHints } });
      const visits = buildLocationVisitData(requiredHints.filter((hint) => hint.isRequired), session.id);
      if (visits.length > 0) {
        await tx.storeCountLocationVisit.createMany({ data: visits });
      }
      return { status: "ok" as const, created: true, session };
    });

    if (result.status === "forbidden") {
      return reply.code(403).send({ error: "you do not have access to that site" });
    }
    if (result.status === "replacement-not-found") {
      return reply.code(404).send({ error: "the count being replaced was not found for this site" });
    }
    if (result.status === "replacement-forbidden") {
      return reply.code(403).send({ error: "only the current assignee can replace this count" });
    }
    if (result.status === "replacement-has-activity") {
      return reply.code(409).send({ error: "This count already has count activity and cannot be replaced. Return to the count and review it." });
    }
    if (result.status === "replacement-no-longer-active") {
      return reply.code(409).send({ error: "This setup count is no longer active. Return to Count and start setup again." });
    }
    if (result.status === "class-locked") {
      return reply.code(409).send({ error: "a cycle count for this class is already in progress at this site" });
    }
    return reply.code(result.created ? 201 : 200).send(result.session);
  });

  app.get("/sessions/active", async (request) => {
    const userId = request.user.sub;
    const authorizedSite = await resolveAuthorizedSite(userId, undefined, request.user.role);
    if (authorizedSite) {
      return prisma.storeCountSession.findFirst({
        where: { status: "ACTIVE", siteId: authorizedSite.id, ...assignedCountWhere(userId) },
        orderBy: { startedAt: "desc" },
        include: {
          assignedTo: { select: { id: true, name: true } },
          expectations: {
            where: { product: { organizationId: authorizedSite.organizationId } },
            orderBy: { productId: "asc" },
          },
          locationVisits: {
            where: { location: { siteId: authorizedSite.id } },
            orderBy: [{ location: { sortOrder: "asc" } }, { locationId: "asc" }],
            include: { location: true, completedBy: { select: { id: true, name: true } } },
          },
          entries: {
            where: {
              location: { siteId: authorizedSite.id },
              OR: [
                { productId: null },
                { product: { organizationId: authorizedSite.organizationId } },
              ],
            },
            orderBy: { updatedAt: "desc" },
            include: { product: true, location: true, countedBy: { select: { id: true, name: true } } },
          },
          assignmentEvents: {
            orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
            include: {
              fromUser: { select: { id: true, name: true } },
              toUser: { select: { id: true, name: true } },
              assignedBy: { select: { id: true, name: true } },
            },
          },
        },
      });
    }

    return prisma.storeCountSession.findFirst({
      where: { status: "ACTIVE", startedById: userId, siteId: null },
      orderBy: { startedAt: "desc" },
      include: {
        assignedTo: { select: { id: true, name: true } },
        expectations: { orderBy: { productId: "asc" } },
        locationVisits: {
          orderBy: [{ location: { sortOrder: "asc" } }, { locationId: "asc" }],
          include: { location: true, completedBy: { select: { id: true, name: true } } },
        },
        entries: {
          orderBy: { updatedAt: "desc" },
          include: { product: true, location: true, countedBy: { select: { id: true, name: true } } },
        },
        assignmentEvents: {
          orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
          include: {
            fromUser: { select: { id: true, name: true } },
            toUser: { select: { id: true, name: true } },
            assignedBy: { select: { id: true, name: true } },
          },
        },
      },
    });
  });

  app.get("/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user.sub;
    const role = request.user.role;
    if (!userId || !role) return reply.code(401).send({ error: "invalid authenticated user" });
    const access = await assertSessionAccess(id, userId, role);
    if (!access.ok) return reply.code(access.code).send({ error: access.error });

    const session = await prisma.storeCountSession.findUnique({
      where: { id },
      include: {
        entries: {
          orderBy: [{ locationId: "asc" }, { updatedAt: "desc" }],
          include: {
            product: { include: { category: true } },
            location: true,
            countedBy: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!session) return reply.code(404).send({ error: "count session not found" });
    return session;
  });

  app.post("/sessions/:id/scan", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = scanSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const userId = request.user.sub;
    const role = request.user.role;
    if (!userId || !role) return reply.code(401).send({ error: "invalid authenticated user" });

    const access = await assertSessionAccess(id, userId, role);
    if (!access.ok) return reply.code(access.code).send({ error: access.error });
    if (access.session.status !== "ACTIVE") return reply.code(409).send({ error: "count session is not active" });

    if (!access.session.siteId) {
      return reply.code(409).send({ error: "count session is not assigned to a site" });
    }
    const countSite = await prisma.site.findUnique({
      where: { id: access.session.siteId },
      select: { organizationId: true },
    });
    if (!countSite) return reply.code(409).send({ error: "count site no longer exists" });

    const { barcodeValue, locationId, quantityDelta, clientScanId, expiresAt } = parsed.data;
    const location = await prisma.storeLocation.findUnique({ where: { id: locationId } });
    if (!location) return reply.code(400).send({ error: "unknown locationId" });
    if (!location.isActive) return reply.code(400).send({ error: "this location is inactive" });
    if (access.session.siteId && location.siteId !== access.session.siteId) {
      return reply.code(403).send({ error: "location does not belong to this count site" });
    }

    const initialResolution = await resolveCountProductIdentity(prisma.product, countSite.organizationId, barcodeValue);
    if (initialResolution.status === "conflict") {
      return reply.code(409).send({ error: "barcode matches more than one product; review the catalog" });
    }
    if (initialResolution.status === "ambiguous") {
      return reply.code(422).send({ error: "This 8-digit code can be UPC-E or EAN-8. Configure the scanner to send UPC-A, use the camera, or select the product manually." });
    }
    let preflightProduct = initialResolution.status === "found" ? initialResolution.product : null;
    if (!preflightProduct) {
      try {
        preflightProduct = await findOrEnrichProduct(barcodeValue, countSite.organizationId, id, userId);
      } catch (error) {
        if (error instanceof Error && error.message === "BARCODE_CATALOG_CONFLICT") {
          return reply.code(409).send({ error: "barcode matches more than one product; review the catalog" });
        }
        const accessError = countWriteError(error);
        if (accessError) return reply.code(accessError.code).send({ error: accessError.error });
        preflightProduct = null;
      }
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const scope = await requireCountWriter(tx, id, userId);
        await lockCountLocation(tx, scope, locationId);

        if (clientScanId) {
          const prior = await tx.storeCountScanLog.findUnique({ where: { idempotencyKey: clientScanId } });
          if (prior) {
            if (prior.sessionId !== id) throw new Error("IDEMPOTENCY_SESSION_CONFLICT");
            const priorEntry = await tx.storeCountEntry.findUniqueOrThrow({
              where: { id: prior.entryId },
              include: { product: true, location: true, countedBy: { select: { id: true, name: true } } },
            });
            return { entry: priorEntry, countedByDifferentUser: false, previousCounterName: null };
          }
        }

        if (scope.organizationId !== countSite.organizationId || scope.siteId !== access.session.siteId) throw new Error("COUNT_ACCESS_REVOKED");
        // requireCountWriter holds the organization SHARE lock, so catalog
        // writers (which take UPDATE) cannot change this result until the scan
        // commits. Never trust the preflight lookup across this boundary.
        const lockedResolution = await resolveCountProductIdentity(tx.product, scope.organizationId, barcodeValue);
        if (lockedResolution.status === "conflict") throw new Error("COUNT_BARCODE_IDENTITY_CONFLICT");
        if (lockedResolution.status === "ambiguous") throw new Error("COUNT_BARCODE_AMBIGUOUS");
        const product = lockedResolution.status === "found" ? lockedResolution.product : null;
        if (preflightProduct && (!product || product.id !== preflightProduct.id)) throw new Error("COUNT_PRODUCT_INVALID");
        const { entryIdentityBarcode, equivalentEntryBarcodes, managedUpcAlias } = countEntryBarcodeIdentity(product, barcodeValue);
        if (product) await lockCountProduct(tx, scope, product.id);
        let previousEntry = await tx.storeCountEntry.findUnique({
          where: {
            sessionId_locationId_barcodeValue: { sessionId: id, locationId, barcodeValue: entryIdentityBarcode },
          },
          include: { countedBy: { select: { id: true, name: true } } },
        });
        const alternateEntryBarcodes = equivalentEntryBarcodes.filter((candidate) => candidate !== entryIdentityBarcode);
        const alternateEntries = alternateEntryBarcodes.length > 0
          ? await tx.storeCountEntry.findMany({
            where: {
              sessionId: id,
              locationId,
              barcodeValue: { in: alternateEntryBarcodes },
            },
            include: { countedBy: { select: { id: true, name: true } } },
            take: 2,
          })
          : [];
        // A pre-canonicalization release may have stored this UPC product under
        // its managed UPC-E alias. Reuse only a row linked to the same product;
        // the identical eight digits may independently be a real EAN-8 product.
        const managedAliasEntry = product && managedUpcAlias
          && managedUpcAlias !== entryIdentityBarcode
          && !alternateEntryBarcodes.includes(managedUpcAlias)
          ? await tx.storeCountEntry.findFirst({
            where: {
              sessionId: id,
              locationId,
              productId: product.id,
              barcodeValue: managedUpcAlias,
            },
            include: { countedBy: { select: { id: true, name: true } } },
          })
          : null;
        const candidateEntries = [previousEntry, ...alternateEntries, managedAliasEntry]
          .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
        const distinctEntryIds = new Set(candidateEntries.map((entry) => entry.id));
        if (distinctEntryIds.size > 1) {
          throw new Error("COUNT_BARCODE_IDENTITY_CONFLICT");
        }
        previousEntry ??= alternateEntries[0] ?? managedAliasEntry ?? null;
        const storedBarcodeValue = previousEntry?.barcodeValue ?? entryIdentityBarcode;
        if (previousEntry?.productId && previousEntry.productId !== product?.id) await lockCountProduct(tx, scope, previousEntry.productId);
        await rejectApprovedProductWrite(tx, id, previousEntry?.productId ?? null);
        await rejectApprovedProductWrite(tx, id, product?.id ?? null);
        const countedByDifferentUser = Boolean(previousEntry?.countedByUserId && previousEntry.countedByUserId !== userId);
        const previousCounterName = countedByDifferentUser ? previousEntry?.countedBy?.name ?? null : null;

        const now = new Date();
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO "StoreCountEntry"
            ("id", "sessionId", "productId", "barcodeValue", "locationId", "quantity", "countedByUserId", "scannedAt", "updatedAt", "expiresAt")
          VALUES
            (${randomUUID()}, ${id}, ${product?.id ?? null}, ${storedBarcodeValue}, ${locationId}, ${quantityDelta}, ${userId}, ${now}, ${now}, ${expiresAt ?? null})
          ON CONFLICT ("sessionId", "locationId", "barcodeValue")
          DO UPDATE SET
            "quantity" = "StoreCountEntry"."quantity" + EXCLUDED."quantity",
            "productId" = COALESCE(EXCLUDED."productId", "StoreCountEntry"."productId"),
            "countedByUserId" = EXCLUDED."countedByUserId",
            "scannedAt" = EXCLUDED."scannedAt",
            "updatedAt" = EXCLUDED."updatedAt",
            "expiresAt" = COALESCE(EXCLUDED."expiresAt", "StoreCountEntry"."expiresAt")
          RETURNING "id"
        `;
        const countedId = rows[0]?.id;
        if (!countedId) throw new Error("STORE_COUNT_ENTRY_WRITE_FAILED");
        const counted = await tx.storeCountEntry.findUniqueOrThrow({
          where: { id: countedId },
          include: { product: true, location: true, countedBy: { select: { id: true, name: true } } },
        });

        if (clientScanId) {
          await tx.storeCountScanLog.create({
            data: {
              idempotencyKey: clientScanId,
              entryId: counted.id,
              sessionId: id,
              userId,
              quantityDelta,
            },
          });
        }
        return { entry: counted, countedByDifferentUser, previousCounterName };
      });
      return reply.send({ ...result.entry, countedByDifferentUser: result.countedByDifferentUser, previousCounterName: result.previousCounterName });
    } catch (error) {
      const rejection = countWriteError(error);
      if (rejection) return reply.code(rejection.code).send({ error: rejection.error });
      if (error instanceof Error && error.message === "SESSION_NOT_ACTIVE") {
        return reply.code(409).send({ error: "count session is not active" });
      }
      if (error instanceof Error && error.message === "PRODUCT_BASELINE_APPROVED") {
        return reply.code(409).send({ error: "This product's baseline is approved. Start a new count to record a change." });
      }
      if (error instanceof Error && error.message === "IDEMPOTENCY_SESSION_CONFLICT") {
        return reply.code(409).send({ error: "clientScanId was already used for another count session" });
      }
      if (error instanceof Error && error.message === "COUNT_BARCODE_IDENTITY_CONFLICT") {
        return reply.code(409).send({ error: "This item already has more than one count row for equivalent barcodes. Ask a manager to reconcile the catalog before continuing." });
      }
      if (error instanceof Error && error.message === "COUNT_BARCODE_AMBIGUOUS") {
        return reply.code(422).send({ error: "This 8-digit code can be UPC-E or EAN-8. Configure the scanner to send UPC-A, use the camera, or select the product manually." });
      }
      if (error instanceof Error && error.message === "COUNT_PRODUCT_INVALID") {
        return reply.code(409).send({ error: "The product catalog changed while this item was being counted. Scan it again." });
      }
      if (clientScanId && isUniqueConstraintError(error)) {
        const prior = await findIdempotentEntry(clientScanId, id);
        if (prior === "conflict") return reply.code(409).send({ error: "clientScanId was already used for another count session" });
        if (prior) return reply.send(prior);
      }
      throw error;
    }
  });

  app.patch("/sessions/:sessionId/entries/:entryId", async (request, reply) => {
    const { sessionId, entryId } = request.params as { sessionId: string; entryId: string };
    const parsed = setQuantitySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const userId = request.user.sub;
    const role = request.user.role;
    if (!userId || !role) return reply.code(401).send({ error: "invalid authenticated user" });

    const access = await assertSessionAccess(sessionId, userId, role);
    if (!access.ok) return reply.code(access.code).send({ error: access.error });
    if (access.session.status !== "ACTIVE") return reply.code(409).send({ error: "count session is not active" });

    try {
      return await prisma.$transaction(async (tx) => {
        const scope = await requireCountWriter(tx, sessionId, userId);

        const entry = await tx.storeCountEntry.findFirst({ where: { id: entryId, sessionId, location: { siteId: scope.siteId }, OR: [{ productId: null }, { product: { organizationId: scope.organizationId } }] } });
        if (!entry) throw new Error("ENTRY_NOT_FOUND");
        await lockCountLocation(tx, scope, entry.locationId);
        if (entry.productId) await lockCountProduct(tx, scope, entry.productId);
        await rejectApprovedProductWrite(tx, sessionId, entry.productId);
        if (entry.quantity !== parsed.data.expectedQuantity) throw new Error("ENTRY_QUANTITY_CHANGED");

        return tx.storeCountEntry.update({
          where: { id: entryId },
          data: { quantity: parsed.data.quantity, countedByUserId: userId, scannedAt: new Date() },
          include: { product: true, location: true, countedBy: { select: { id: true, name: true } } },
        });
      });
    } catch (error) {
      const rejection = countWriteError(error);
      if (rejection) return reply.code(rejection.code).send({ error: rejection.error });
      if (error instanceof Error && error.message === "SESSION_NOT_ACTIVE") {
        return reply.code(409).send({ error: "count session is not active" });
      }
      if (error instanceof Error && error.message === "ENTRY_NOT_FOUND") {
        return reply.code(404).send({ error: "count entry not found" });
      }
      if (error instanceof Error && error.message === "ENTRY_QUANTITY_CHANGED") {
        return reply.code(409).send({ error: "This count changed on another device. Reload the latest total before correcting it." });
      }
      if (error instanceof Error && error.message === "PRODUCT_BASELINE_APPROVED") {
        return reply.code(409).send({ error: "This product's baseline is approved. Start a new count to record a change." });
      }
      throw error;
    }
  });

  app.get("/sessions/:id/summary", async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user.sub;
    const role = request.user.role;
    if (!userId || !role) return reply.code(401).send({ error: "invalid authenticated user" });
    const access = await assertSessionAccess(id, userId, role);
    if (!access.ok) return reply.code(access.code).send({ error: access.error });

    const session = await prisma.storeCountSession.findUnique({
      where: { id },
      include: { entries: { include: { product: true, location: true } } },
    });
    if (!session) return reply.code(404).send({ error: "count session not found" });

    const rows = buildSummaryRows(session.entries);
    const totalUnits = rows.reduce((sum, row) => sum + row.total, 0);
    const locations = [...new Set(session.entries.map((entry) => entry.location.code))].sort();

    return {
      session: {
        id: session.id,
        name: session.name,
        status: session.status,
        startedAt: session.startedAt,
        completedAt: session.completedAt,
      },
      distinctProducts: rows.length,
      totalUnits,
      locations,
      rows,
    };
  });

  // Retailer module: rotation/markdown alert. Surfaces entries in this
  // session whose recorded expiresAt falls within the given window, soonest
  // first, so a counter/manager knows what to pull or mark down before it
  // goes stale (Walmart's item-level-RFID rotation-alert idea, built here on
  // the barcode-scan + count-entry infrastructure that already exists).
  app.get("/sessions/:id/expiring", async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user.sub;
    const role = request.user.role;
    if (!userId || !role) return reply.code(401).send({ error: "invalid authenticated user" });
    const access = await assertSessionAccess(id, userId, role);
    if (!access.ok) return reply.code(access.code).send({ error: access.error });

    const parsedQuery = expiringQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) return reply.code(400).send({ error: parsedQuery.error.flatten() });
    const { withinDays } = parsedQuery.data;

    const now = new Date();
    const horizon = new Date(now.getTime() + withinDays * 24 * 60 * 60 * 1000);

    const entries = await prisma.storeCountEntry.findMany({
      where: {
        sessionId: id,
        expiresAt: { not: null, lte: horizon },
      },
      orderBy: { expiresAt: "asc" },
      include: {
        product: { select: { id: true, name: true, packageSize: true } },
        location: { select: { id: true, code: true, name: true } },
      },
    });

    return {
      withinDays,
      asOf: now,
      rows: entries.map((entry) => ({
        entryId: entry.id,
        barcodeValue: entry.barcodeValue,
        productId: entry.productId,
        productName: entry.product?.name ?? null,
        packageSize: entry.product?.packageSize ?? null,
        locationId: entry.locationId,
        locationCode: entry.location.code,
        quantity: entry.quantity,
        expiresAt: entry.expiresAt,
        isAlreadyExpired: entry.expiresAt !== null && entry.expiresAt.getTime() < now.getTime(),
      })),
    };
  });

  app.post("/sessions/:id/complete", async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user.sub;
    const role = request.user.role;
    if (!userId || !role) return reply.code(401).send({ error: "invalid authenticated user" });
    const access = await assertSessionAccess(id, userId, role);
    if (!access.ok) return reply.code(access.code).send({ error: access.error });
    if (access.session.status !== "ACTIVE") return reply.code(409).send({ error: "count session is not active" });
    if (!access.session.siteId) {
      const legacyResult = await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{
          status: string;
          startedById: string | null;
          assignedToId: string | null;
        }>>`
          SELECT session."status", session."startedById", session."assignedToId"
          FROM "StoreCountSession" AS session
          WHERE session."id" = ${id}
            AND session."siteId" IS NULL
          FOR UPDATE OF session
        `;
        const locked = rows[0];
        if (!locked || locked.status !== "ACTIVE") return { status: "not-active" as const };
        const legacyScope = { ...locked, organizationRole: "" };
        if (!isCurrentCountAssignee(legacyScope, userId)) return { status: "forbidden" as const };
        const actors = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "User" WHERE "id" = ${userId} AND "isActive" = TRUE FOR SHARE
        `;
        if (!actors.length) return { status: "forbidden" as const };
        const entryCount = await tx.storeCountEntry.count({ where: { sessionId: id } });
        if (entryCount === 0) return { status: "empty" as const };
        const session = await tx.storeCountSession.update({
          where: { id, siteId: null },
          data: { status: "COMPLETED", completedAt: new Date() },
        });
        return { status: "completed" as const, session };
      });
      if (legacyResult.status === "not-active") return reply.code(409).send({ error: "count session is not active" });
      if (legacyResult.status === "forbidden") {
        return reply.code(403).send({ error: "only the current assignee can complete this session; ask a supervisor to reassign it first" });
      }
      if (legacyResult.status === "empty") return reply.code(409).send({ error: "cannot complete an empty count" });
      return legacyResult.session;
    }

    const result = await prisma.$transaction(async (tx) => {
      const locked = await lockCountScope(tx, id, userId);
      if (!locked) return { status: "not-found" as const };
      if (locked.status !== "ACTIVE") return { status: "not-active" as const };
      if (!isCurrentCountAssignee(locked, userId)) return { status: "forbidden" as const };

      const calculation = await calculateStoreCountDiscrepancies(tx, {
        sessionId: id,
        siteId: locked.siteId,
        organizationId: locked.organizationId,
      });
      if (!calculation.finalized) return { status: "unverified-locations" as const };

      const entryCount = await tx.storeCountEntry.count({
        where: { sessionId: id, location: { siteId: locked.siteId } },
      });
      if (entryCount === 0) return { status: "empty" as const };

      const unexplained = await tx.storeCountDiscrepancy.count({
        where: {
          sessionId: id,
          status: "OPEN",
          reason: null,
          product: { organizationId: locked.organizationId },
        },
      });
      if (unexplained > 0) return { status: "unexplained" as const };

      const session = await tx.storeCountSession.update({
        where: { id, siteId: locked.siteId },
        data: { status: "COMPLETED", completedAt: new Date() },
      });
      return { status: "completed" as const, session };
    });

    if (result.status === "not-found") return reply.code(404).send({ error: "count session not found" });
    if (result.status === "not-active") return reply.code(409).send({ error: "count session is not active" });
    if (result.status === "forbidden") {
      return reply.code(403).send({ error: "only the current assignee can complete this session; ask a supervisor to reassign it first" });
    }
    if (result.status === "unverified-locations") {
      return reply.code(409).send({ error: "verify every required location before completing this count" });
    }
    if (result.status === "empty") return reply.code(409).send({ error: "cannot complete an empty count" });
    if (result.status === "unexplained") {
      return reply.code(409).send({ error: "add an employee explanation for every discrepancy before completing this count" });
    }
    return result.session;
  });

  app.post("/sessions/:id/cancel", async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user.sub;
    const role = request.user.role;
    if (!userId || !role) return reply.code(401).send({ error: "invalid authenticated user" });
    const access = await assertSessionAccess(id, userId, role);
    if (!access.ok) return reply.code(access.code).send({ error: access.error });
    if (access.session.status !== "ACTIVE") return reply.code(409).send({ error: "count session is not active" });
    if (!access.session.siteId) {
      const legacyResult = await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{
          status: string;
          startedById: string | null;
          assignedToId: string | null;
        }>>`
          SELECT session."status", session."startedById", session."assignedToId"
          FROM "StoreCountSession" AS session
          WHERE session."id" = ${id}
            AND session."siteId" IS NULL
          FOR UPDATE OF session
        `;
        const locked = rows[0];
        if (!locked || locked.status !== "ACTIVE") return { status: "not-active" as const };
        const legacyScope = { ...locked, organizationRole: "" };
        if (!isCurrentCountAssignee(legacyScope, userId)) return { status: "forbidden" as const };
        const actors = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "User" WHERE "id" = ${userId} AND "isActive" = TRUE FOR SHARE
        `;
        if (!actors.length) return { status: "forbidden" as const };
        const approvals = await tx.storeCountDiscrepancy.count({ where: { sessionId: id, status: "APPROVED" } });
        if (approvals > 0) return { status: "approved" as const };
        const session = await tx.storeCountSession.update({
          where: { id, siteId: null, status: "ACTIVE" },
          data: { status: "CANCELLED", completedAt: new Date() },
        });
        return { status: "cancelled" as const, session };
      });
      if (legacyResult.status === "not-active") return reply.code(409).send({ error: "count session is not active" });
      if (legacyResult.status === "forbidden") {
        return reply.code(403).send({ error: "only the current assignee can cancel this session; ask a supervisor to reassign it first" });
      }
      if (legacyResult.status === "approved") {
        return reply.code(409).send({ error: "This count has approved adjustments and cannot be cancelled. Complete its remaining work." });
      }
      return legacyResult.session;
    }

    try {
      return await prisma.$transaction(async (tx) => {
        const scope = await requireCountWriter(tx, id, userId);
        const approvals = await tx.storeCountDiscrepancy.count({ where: { sessionId: id, status: "APPROVED" } });
        if (approvals > 0) return reply.code(409).send({ error: "This count has approved adjustments and cannot be cancelled. Complete its remaining work." });
        return tx.storeCountSession.update({ where: { id, siteId: scope.siteId, status: "ACTIVE" }, data: { status: "CANCELLED", completedAt: new Date() } });
      });
    } catch (error) {
      const rejection = countWriteError(error);
      if (rejection) return reply.code(rejection.code).send({ error: rejection.error });
      throw error;
    }
  });
}
