-- Retailer module: optional use-by/expiration date on a counted entry, so a
-- scan can flag stock for rotation/markdown before it goes stale (the same
-- idea Walmart uses item-level RFID for on fresh categories, done here with
-- the barcode-scan infrastructure that already exists). Nullable, additive,
-- no backfill needed or attempted for existing rows.
ALTER TABLE "StoreCountEntry" ADD COLUMN "expiresAt" TIMESTAMP(3);

CREATE INDEX "StoreCountEntry_sessionId_expiresAt_idx" ON "StoreCountEntry" ("sessionId", "expiresAt");
