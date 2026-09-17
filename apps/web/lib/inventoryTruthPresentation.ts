export type CountRouteProduct = {
  productId: string;
  barcodeValue: string;
  name: string;
  packageSize: string | null;
  expectedStoreQty: number;
  suspectedLocations: Array<{
    locationId: string;
    code: string;
    verified: boolean;
    evidence: "ASSIGNED" | "PREVIOUSLY_COUNTED" | "RECENTLY_STOCKED" | "RECEIVED" | "DISPLAY_COMPONENT";
  }>;
};

export type CountRoute = {
  sessionId: string;
  expectedProducts: number;
  locations: Array<{
    id: string;
    code: string;
    name: string | null;
    status: string;
    products: CountRouteProduct[];
    routePosition?: number;
    completedLocations?: number;
    totalLocations?: number;
  }>;
};

export function countInstruction({ expectedStoreQty }: { expectedStoreQty: number }) {
  return `${expectedStoreQty} expected in the store. Count every actual product at this location—not the shelf tag.`;
}

export function shortageInstruction(missingUnits: number) {
  return `${missingUnits} units are still missing after the listed locations were checked. Choose a reason or request manager review.`;
}

export function overageInstruction(extraUnits: number) {
  return `${extraUnits} extra units found. Confirm the product and location.`;
}

export function frozenCountExpectationNotice() {
  return "Count's Expected in store is frozen at count start.";
}
