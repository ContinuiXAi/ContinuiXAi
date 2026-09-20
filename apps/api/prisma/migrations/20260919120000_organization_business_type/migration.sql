-- Retail/Wholesale/Repacker module foundation: tag each Organization with
-- the supply-chain segment it operates as, so the product can surface
-- segment-specific features from one shared codebase instead of forking it.
-- Forward-only. Every existing Organization row becomes RETAILER (the
-- segment currently being built out and the correct default for the
-- single-site pilot orgs that exist today per the 2026-09-18 charter).
CREATE TYPE "BusinessType" AS ENUM ('RETAILER', 'WHOLESALER', 'DISTRIBUTOR', 'REPACKER', 'CO_OP', 'OTHER');

ALTER TABLE "Organization" ADD COLUMN "businessType" "BusinessType" NOT NULL DEFAULT 'RETAILER';
