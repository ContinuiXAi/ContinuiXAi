ALTER TABLE "StoreCountDiscrepancy" ADD COLUMN "explainedById" TEXT, ADD COLUMN "explainedAt" TIMESTAMP(3);
CREATE INDEX "StoreCountDiscrepancy_explainedById_idx" ON "StoreCountDiscrepancy"("explainedById");
ALTER TABLE "StoreCountDiscrepancy" ADD CONSTRAINT "StoreCountDiscrepancy_explainedById_fkey" FOREIGN KEY ("explainedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
