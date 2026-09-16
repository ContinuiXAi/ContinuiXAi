CREATE TYPE "ProductLocationEvidence" AS ENUM (
  'ASSIGNED',
  'PREVIOUSLY_COUNTED',
  'RECENTLY_STOCKED',
  'RECEIVED',
  'DISPLAY_COMPONENT'
);

CREATE TYPE "StoreCountLocationVisitStatus" AS ENUM (
  'PENDING',
  'ACTIVE',
  'VERIFIED'
);

CREATE TYPE "StoreCountDiscrepancyStatus" AS ENUM (
  'OPEN',
  'APPROVED',
  'REJECTED'
);

CREATE TYPE "StoreCountDiscrepancyReason" AS ENUM (
  'COULD_NOT_FIND',
  'WRONG_SHELF_OR_LOCATION',
  'RECEIVING_PROBLEM',
  'STOCKING_PROBLEM',
  'SALE_NOT_RECORDED',
  'DAMAGE_OR_EXPIRATION',
  'EMPTY_PACKAGE_POSSIBLE_THEFT',
  'PRODUCT_OR_PACKAGE_CHANGED',
  'OTHER_MANAGER_REVIEW'
);

ALTER TABLE "StoreCountSession"
  ADD COLUMN "assignedToId" TEXT;

ALTER TABLE "InventoryTransaction"
  ALTER COLUMN "locationId" DROP NOT NULL;

CREATE TABLE "ProductLocationHint" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "evidence" "ProductLocationEvidence" NOT NULL,
  "isRequired" BOOLEAN NOT NULL DEFAULT true,
  "lastObservedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProductLocationHint_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProductComposition" (
  "id" TEXT NOT NULL,
  "parentPackagingId" TEXT NOT NULL,
  "componentProductId" TEXT NOT NULL,
  "quantityPerParent" INTEGER NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductComposition_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StoreCountExpectation" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "expectedStoreQty" DECIMAL(18,4) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StoreCountExpectation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StoreCountLocationVisit" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "status" "StoreCountLocationVisitStatus" NOT NULL DEFAULT 'PENDING',
  "completedById" TEXT,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "StoreCountLocationVisit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StoreCountAssignmentEvent" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "fromUserId" TEXT,
  "toUserId" TEXT NOT NULL,
  "assignedById" TEXT NOT NULL,
  "reason" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StoreCountAssignmentEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StoreCountDiscrepancy" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "expectedStoreQty" DECIMAL(18,4) NOT NULL,
  "actualStoreQty" DECIMAL(18,4) NOT NULL,
  "difference" DECIMAL(18,4) NOT NULL,
  "reason" "StoreCountDiscrepancyReason",
  "note" TEXT,
  "status" "StoreCountDiscrepancyStatus" NOT NULL DEFAULT 'OPEN',
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StoreCountDiscrepancy_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StoreCountSession_assignedToId_status_idx"
  ON "StoreCountSession"("assignedToId", "status");

CREATE UNIQUE INDEX "ProductLocationHint_siteId_productId_locationId_key"
  ON "ProductLocationHint"("siteId", "productId", "locationId");
CREATE INDEX "ProductLocationHint_organizationId_siteId_locationId_idx"
  ON "ProductLocationHint"("organizationId", "siteId", "locationId");
CREATE INDEX "ProductLocationHint_productId_idx"
  ON "ProductLocationHint"("productId");

CREATE UNIQUE INDEX "ProductComposition_parentPackaging_componentProduct_version_key"
  ON "ProductComposition"("parentPackagingId", "componentProductId", "version");
CREATE INDEX "ProductComposition_componentProductId_isActive_idx"
  ON "ProductComposition"("componentProductId", "isActive");

CREATE UNIQUE INDEX "StoreCountExpectation_sessionId_productId_key"
  ON "StoreCountExpectation"("sessionId", "productId");
CREATE INDEX "StoreCountExpectation_productId_idx"
  ON "StoreCountExpectation"("productId");

CREATE UNIQUE INDEX "StoreCountLocationVisit_sessionId_locationId_key"
  ON "StoreCountLocationVisit"("sessionId", "locationId");
CREATE INDEX "StoreCountLocationVisit_locationId_status_idx"
  ON "StoreCountLocationVisit"("locationId", "status");
CREATE INDEX "StoreCountLocationVisit_completedById_idx"
  ON "StoreCountLocationVisit"("completedById");

CREATE INDEX "StoreCountAssignmentEvent_sessionId_occurredAt_idx"
  ON "StoreCountAssignmentEvent"("sessionId", "occurredAt");
CREATE INDEX "StoreCountAssignmentEvent_fromUserId_idx"
  ON "StoreCountAssignmentEvent"("fromUserId");
CREATE INDEX "StoreCountAssignmentEvent_toUserId_occurredAt_idx"
  ON "StoreCountAssignmentEvent"("toUserId", "occurredAt");
CREATE INDEX "StoreCountAssignmentEvent_assignedById_idx"
  ON "StoreCountAssignmentEvent"("assignedById");

CREATE UNIQUE INDEX "StoreCountDiscrepancy_sessionId_productId_key"
  ON "StoreCountDiscrepancy"("sessionId", "productId");
CREATE INDEX "StoreCountDiscrepancy_sessionId_status_idx"
  ON "StoreCountDiscrepancy"("sessionId", "status");
CREATE INDEX "StoreCountDiscrepancy_productId_status_idx"
  ON "StoreCountDiscrepancy"("productId", "status");
CREATE INDEX "StoreCountDiscrepancy_reviewedById_idx"
  ON "StoreCountDiscrepancy"("reviewedById");

ALTER TABLE "StoreCountSession"
  ADD CONSTRAINT "StoreCountSession_assignedToId_fkey"
  FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ProductLocationHint"
  ADD CONSTRAINT "ProductLocationHint_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProductLocationHint"
  ADD CONSTRAINT "ProductLocationHint_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProductLocationHint"
  ADD CONSTRAINT "ProductLocationHint_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProductLocationHint"
  ADD CONSTRAINT "ProductLocationHint_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "StoreLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ProductComposition"
  ADD CONSTRAINT "ProductComposition_parentPackagingId_fkey"
  FOREIGN KEY ("parentPackagingId") REFERENCES "ProductPackaging"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProductComposition"
  ADD CONSTRAINT "ProductComposition_componentProductId_fkey"
  FOREIGN KEY ("componentProductId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StoreCountExpectation"
  ADD CONSTRAINT "StoreCountExpectation_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "StoreCountSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StoreCountExpectation"
  ADD CONSTRAINT "StoreCountExpectation_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StoreCountLocationVisit"
  ADD CONSTRAINT "StoreCountLocationVisit_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "StoreCountSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StoreCountLocationVisit"
  ADD CONSTRAINT "StoreCountLocationVisit_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "StoreLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StoreCountLocationVisit"
  ADD CONSTRAINT "StoreCountLocationVisit_completedById_fkey"
  FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "StoreCountAssignmentEvent"
  ADD CONSTRAINT "StoreCountAssignmentEvent_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "StoreCountSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StoreCountAssignmentEvent"
  ADD CONSTRAINT "StoreCountAssignmentEvent_fromUserId_fkey"
  FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StoreCountAssignmentEvent"
  ADD CONSTRAINT "StoreCountAssignmentEvent_toUserId_fkey"
  FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StoreCountAssignmentEvent"
  ADD CONSTRAINT "StoreCountAssignmentEvent_assignedById_fkey"
  FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StoreCountDiscrepancy"
  ADD CONSTRAINT "StoreCountDiscrepancy_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "StoreCountSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StoreCountDiscrepancy"
  ADD CONSTRAINT "StoreCountDiscrepancy_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StoreCountDiscrepancy"
  ADD CONSTRAINT "StoreCountDiscrepancy_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
