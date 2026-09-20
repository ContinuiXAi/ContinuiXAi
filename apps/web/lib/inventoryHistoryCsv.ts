export type InventoryHistory = {
  siteId: string; asOfExclusive: string; recordedBefore: string | null;
  valuationStatus: "unavailable"; catalogMetadata: "current"; quantityBasis: string;
  nextCursor: string | null;
  rows: Array<{
    product: { id: string; name: string; barcodeValue: string | null; isActive: boolean };
    quantity: string; unitOfMeasure: string | null;
    provenance: { source: string; eventCount: number; firstOccurredAt: string | null; lastOccurredAt: string | null; lastRecordedAt: string | null };
  }>;
};

function cell(value: unknown): string {
  const text = value == null ? "" : String(value);
  // Quoting alone does not prevent spreadsheet execution. Treat even signed
  // quantities as text to preserve Decimal precision, never binary floats.
  const safe = /^[\s\u0000-\u001f]*[=+@-]|^[\t\r\n]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

/** Current page only: never silently imply a paginated report is a full export. */
export function inventoryHistoryCsv(report: InventoryHistory): string {
  const headers = ["siteId", "asOfExclusive", "recordedBefore", "valuationStatus", "catalogMetadata", "quantityBasis", "productId", "productName", "barcode", "active", "quantity", "unitOfMeasure", "source", "eventCount", "firstOccurredAt", "lastOccurredAt", "lastRecordedAt"];
  const rows = report.rows.map(({ product, quantity, unitOfMeasure, provenance }) => [report.siteId, report.asOfExclusive, report.recordedBefore, report.valuationStatus, report.catalogMetadata, report.quantityBasis, product.id, product.name, product.barcodeValue, product.isActive, quantity, unitOfMeasure, provenance.source, provenance.eventCount, provenance.firstOccurredAt, provenance.lastOccurredAt, provenance.lastRecordedAt]);
  return [headers, ...rows].map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}
