export type PackagingQuantity = {
  unitsOfEach: number;
};

export type CompositionComponent = {
  productId: string;
  quantityPerParent: number;
};

export type ExpandedComponent = {
  productId: string;
  eachQuantity: number;
};

export type VersionedCompositionComponent = {
  parentPackagingId: string;
  componentProductId: string;
  quantityPerParent: number;
  version: number;
  isActive: boolean;
};

export const MAX_INVENTORY_QUANTITY = 2_147_483_647;

function assertPositiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer`);
  }
  if (value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  if (value > MAX_INVENTORY_QUANTITY) {
    throw new Error(`${label} exceeds maximum ${MAX_INVENTORY_QUANTITY}`);
  }
}

function checkedMultiply(left: number, right: number, label: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result) || result > MAX_INVENTORY_QUANTITY) {
    throw new Error(`${label} exceeds maximum ${MAX_INVENTORY_QUANTITY}`);
  }
  return result;
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result > MAX_INVENTORY_QUANTITY) {
    throw new Error(`${label} exceeds maximum ${MAX_INVENTORY_QUANTITY}`);
  }
  return result;
}

export function resolvePackagingQuantity(packaging: PackagingQuantity, requestedQuantity: number) {
  assertPositiveInteger(packaging.unitsOfEach, "Pack quantity");
  assertPositiveInteger(requestedQuantity, "Requested quantity");
  return checkedMultiply(packaging.unitsOfEach, requestedQuantity, "Resolved pack quantity");
}

export function expandComposition(
  components: CompositionComponent[],
  requestedQuantity: number,
): ExpandedComponent[] {
  assertPositiveInteger(requestedQuantity, "Requested quantity");
  if (components.length === 0) throw new Error("Composition must contain at least one component");

  for (const component of components) {
    if (!component.productId.trim()) throw new Error("Component productId is required");
    assertPositiveInteger(component.quantityPerParent, "Component quantity");
  }

  return components.map((component) => ({
    productId: component.productId,
    eachQuantity: checkedMultiply(component.quantityPerParent, requestedQuantity, "Expanded component quantity"),
  }));
}

function expandComponentRows(
  components: Array<{ componentProductId: string; quantityPerParent: number }>,
  parentProductId: string,
  parentQuantity: number,
): ExpandedComponent[] {
  assertPositiveInteger(parentQuantity, "Parent quantity");
  const totals = new Map<string, number>();
  for (const row of components) {
    if (!row.componentProductId.trim() || row.componentProductId === parentProductId) {
      throw new Error("Invalid display component");
    }
    assertPositiveInteger(row.quantityPerParent, "Component quantity");
    const expanded = checkedMultiply(row.quantityPerParent, parentQuantity, "Expanded component quantity");
    totals.set(
      row.componentProductId,
      checkedAdd(totals.get(row.componentProductId) ?? 0, expanded, "Aggregated component quantity"),
    );
  }
  if (totals.size === 0) throw new Error("Composition must contain at least one component");
  return [...totals].map(([productId, eachQuantity]) => ({ productId, eachQuantity }));
}

export function aggregateCompositionDefinition(
  components: Array<{ componentProductId: string; quantityPerParent: number }>,
  parentProductId: string,
): ExpandedComponent[] {
  return expandComponentRows(components, parentProductId, 1);
}

export function expandVersionedComposition(
  components: VersionedCompositionComponent[],
  parentProductId: string,
  parentQuantity: number,
): ExpandedComponent[] {
  const selected = components[0];
  if (!selected) throw new Error("Composition must contain at least one component");
  if (!selected.parentPackagingId.trim()) throw new Error("Parent packaging is required");
  assertPositiveInteger(selected.version, "Composition version");
  for (const row of components) {
    if (!row.isActive) throw new Error("Inactive composition cannot produce ledger inputs");
    if (row.parentPackagingId !== selected.parentPackagingId || row.version !== selected.version) {
      throw new Error("Composition rows must use a single packaging and version");
    }
    assertPositiveInteger(row.version, "Composition version");
  }
  return expandComponentRows(components, parentProductId, parentQuantity);
}
