-- Cycle-count workflow MVP (2026-09-19 competitor research, P1): ABC
-- classification drives scheduled partial counts instead of always counting
-- every product at a site. Forward-only, fully backward compatible — every
-- existing Product and StoreCountSession gets NULL, which means "unclassified"
-- / "full, unscoped count" respectively, identical to today's only behavior.
CREATE TYPE "ProductCycleCountClass" AS ENUM ('A', 'B', 'C');

ALTER TABLE "Product" ADD COLUMN "cycleCountClass" "ProductCycleCountClass";
ALTER TABLE "StoreCountSession" ADD COLUMN "cycleCountClass" "ProductCycleCountClass";

CREATE INDEX "Product_organizationId_cycleCountClass_idx" ON "Product"("organizationId", "cycleCountClass");
CREATE INDEX "StoreCountSession_siteId_cycleCountClass_status_idx" ON "StoreCountSession"("siteId", "cycleCountClass", "status");
