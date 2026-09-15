export type PendingCountItem = {
  barcodeValue: string;
  productId: string | null;
  productName: string | null;
  packageSize: string | null;
  known: boolean;
};

export type ConfirmedCountScan = PendingCountItem & {
  locationId: string;
  quantity: number;
};

export function normalizeCountQuantity(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const quantity = Number(value);
  return Number.isInteger(quantity) && quantity >= 1 && quantity <= 999 ? quantity : null;
}

export function buildConfirmedCountScan(
  item: PendingCountItem,
  quantity: number,
  locationId: string,
): ConfirmedCountScan {
  if (!locationId || !Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
    throw new Error("Invalid confirmed count scan.");
  }
  return { ...item, quantity, locationId };
}
