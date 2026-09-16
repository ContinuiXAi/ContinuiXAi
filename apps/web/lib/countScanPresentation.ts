export type CountScanPresentationInput = {
  barcodeValue: string;
  quantityAdded: number;
  currentQuantity: number;
  productName: string | null;
  locationCode: string;
  locationName: string | null;
};

export type CountScanPresentation = {
  title: string;
  upc: string;
  location: string;
  added: number;
  current: number;
  known: boolean;
  announcement: string;
};

export function buildCountScanPresentation(input: CountScanPresentationInput): CountScanPresentation {
  const location = input.locationName?.trim()
    ? `${input.locationCode} — ${input.locationName.trim()}`
    : input.locationCode;
  const productName = input.productName?.trim() || null;

  return {
    title: productName || "Unknown product",
    upc: input.barcodeValue,
    location,
    added: input.quantityAdded,
    current: input.currentQuantity,
    known: Boolean(productName),
    announcement: productName
      ? `Added ${input.quantityAdded} of ${productName} to ${location}. Ready for the next item.`
      : `Added ${input.quantityAdded} of UPC ${input.barcodeValue} to ${location}. Product details need review.`,
  };
}
