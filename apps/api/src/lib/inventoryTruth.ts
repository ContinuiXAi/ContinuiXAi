export function expectedStoreTotal(rows: Array<{ quantity: number }>) {
  return rows.reduce((sum, row) => sum + row.quantity, 0);
}

export function computeStoreDifference(expected: number, actual: Array<{ quantity: number }>) {
  const actualTotal = actual.reduce((sum, row) => sum + row.quantity, 0);
  return { actualTotal, difference: actualTotal - expected };
}

export function buildLocationRoute(rows: Array<{ id: string; sortOrder: number; code: string }>) {
  return [...rows]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code) || a.id.localeCompare(b.id))
    .map((row) => row.id);
}
