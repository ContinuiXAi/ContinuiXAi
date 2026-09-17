-- Forward-only, quantity-report index. No ledger data or prior migrations change.
-- PROVISIONAL / UNMEASURED: local PostgreSQL was unavailable during authoring.
-- Run scripts/inventoryHistoryDbValidation.ts on disposable PostgreSQL 17 and
-- review EXPLAIN (ANALYZE, BUFFERS) comparisons before approving this order.
-- The query constrains organization/site/product equality before time ranges.
-- A normal CREATE INDEX may block writes: schedule deployment separately.
CREATE INDEX "InventoryTransaction_history_idx"
  ON "InventoryTransaction" ("organizationId", "siteId", "productId", "occurredAt", "createdAt");
