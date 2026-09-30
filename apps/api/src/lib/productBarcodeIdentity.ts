import type { Prisma } from "@prisma/client";
import { inferRetailBarcodeFormat, retailBarcodeEquivalents, retailBarcodeLookupCandidates, type RetailBarcodeFormat } from "@continuixai/shared";

const RETAIL_IDENTIFIER_TYPES = ["UPC", "EAN", "GTIN"] as const;
export const BARCODE_ALIAS_SOURCE = "CONTINUIXAI_BARCODE_ALIAS";
export const BARCODE_PRIMARY_SOURCE = "CONTINUIXAI_BARCODE_PRIMARY";
export const MANAGED_BARCODE_SOURCES = [BARCODE_ALIAS_SOURCE, BARCODE_PRIMARY_SOURCE] as const;

export function retailBarcodeProductWhere(
  organizationId: string,
  barcodeValue: string,
  options?: { includeAmbiguousAlternate?: boolean },
): Prisma.ProductWhereInput {
  const [exactValue, ...aliasValues] = options?.includeAmbiguousAlternate
    ? retailBarcodeLookupCandidates(barcodeValue)
    : retailBarcodeEquivalents(barcodeValue);
  return {
    organizationId,
    OR: [
      { barcodeValue: { in: [exactValue, ...aliasValues] } },
      {
        identifiers: {
          some: {
            OR: [
              { value: exactValue },
              ...(aliasValues.length > 0
                ? [{ value: { in: aliasValues }, type: { in: [...RETAIL_IDENTIFIER_TYPES] } }]
                : []),
            ],
          },
        },
      },
    ],
  };
}

export function retailIdentifierTypesForValue(
  value: string,
  format?: RetailBarcodeFormat | null,
  typedUpcAlias?: string | null,
) {
  if (typedUpcAlias === value) return ["UPC", "GTIN"] as const;
  if (/^\d{12}$/.test(value)) return ["UPC", "GTIN"] as const;
  if (/^\d{13}$/.test(value)) return ["EAN", "GTIN"] as const;
  if (/^\d{8}$/.test(value)) {
    if (format === "EAN_8") return ["EAN", "GTIN"] as const;
    if (format === "UPC_E" || format === "UPC_A") return ["UPC", "GTIN"] as const;
    const inferred = inferRetailBarcodeFormat(value);
    if (inferred === "EAN_8") return ["EAN", "GTIN"] as const;
    if (inferred === "UPC_E") return ["UPC", "GTIN"] as const;
  }
  return RETAIL_IDENTIFIER_TYPES;
}

/** Duplicate detection for a known identity, deliberately excluding a
 * coincidental UPC-E/EAN-8 alternate. Product.barcodeValue has no type, while
 * ProductIdentifier aliases are compared only within the relevant retail
 * symbologies. */
export function retailBarcodeDuplicateWhere(
  organizationId: string,
  barcodeValue: string,
  format?: RetailBarcodeFormat | null,
  typedUpcAlias?: string | null,
): Prisma.ProductWhereInput {
  const values = retailBarcodeEquivalents(barcodeValue);
  return {
    organizationId,
    OR: [
      { barcodeValue: { in: values } },
      ...values.map((value) => ({
        identifiers: {
          some: {
            value,
            type: { in: [...retailIdentifierTypesForValue(value, format, typedUpcAlias)] },
          },
        },
      })),
      ...(typedUpcAlias && !values.includes(typedUpcAlias)
        ? [{ identifiers: { some: { value: typedUpcAlias, type: { in: ["UPC" as const, "GTIN" as const] } } } }]
        : []),
    ],
  };
}

export async function lockProductBarcodeWrites(
  tx: Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">,
  organizationId: string,
) {
  // Follow the API-wide relation order before taking the logical identity
  // lock. CSV already holds this row through authorization; acquiring it again
  // is harmless and prevents Organization -> advisory / advisory ->
  // Organization ABBA cycles across the other product writers.
  const organizations = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Organization" WHERE "id" = ${organizationId} AND "isActive" = TRUE FOR SHARE
  `;
  if (organizations.length !== 1) throw new Error("PRODUCT_ORGANIZATION_INACTIVE");
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`product-barcode:${organizationId}`}))`;
}
