-- Forward-only, quantity-report index. No ledger data or prior migrations change.
-- Query validation is documented in docs/INVENTORY-HISTORY.md; it does not
-- establish production build duration, storage/WAL demand, or lock safety.
-- Use docs/INVENTORY-HISTORY-INDEX-PRODUCTION-RUNBOOK.md before deployment.
-- The query constrains organization/site/product equality before time ranges.
-- A normal CREATE INDEX may block writes: schedule deployment separately.
CREATE INDEX "InventoryTransaction_history_idx"
  ON "InventoryTransaction" ("organizationId", "siteId", "productId", "occurredAt", "createdAt");
