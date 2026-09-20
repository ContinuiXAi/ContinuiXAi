-- Current assignee ownership governs active site work. Preserve starter identity
-- as immutable history while allowing a former assignee to begin new work.
DO $$
DECLARE
  duplicate_groups TEXT;
BEGIN
  SELECT string_agg(
    format(
      'assignedToId=%L, siteId=%L, activeCount=%s',
      duplicate_group.assignee_id,
      duplicate_group.site_id,
      duplicate_group.active_count
    ),
    '; ' ORDER BY duplicate_group.assignee_id, duplicate_group.site_id
  )
  INTO duplicate_groups
  FROM (
    SELECT
      "assignedToId" AS assignee_id,
      "siteId" AS site_id,
      COUNT(*) AS active_count
    FROM "StoreCountSession"
    WHERE "status" = 'ACTIVE'
      AND "assignedToId" IS NOT NULL
      AND "siteId" IS NOT NULL
    GROUP BY "assignedToId", "siteId"
    HAVING COUNT(*) > 1
  ) AS duplicate_group;

  IF duplicate_groups IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot create StoreCountSession_one_active_per_assignee_site; duplicate ACTIVE assignee/site groups: %', duplicate_groups
      USING HINT = 'Finish or reassign each conflicting active count through the authorized workflow, preserving starter identity, entries, assignment events, and approval history; then retry the migration.';
  END IF;
END;
$$;

DROP INDEX IF EXISTS "StoreCountSession_one_active_per_user";

CREATE UNIQUE INDEX "StoreCountSession_one_active_per_assignee_site"
  ON "StoreCountSession"("assignedToId", "siteId")
  WHERE "status" = 'ACTIVE'
    AND "assignedToId" IS NOT NULL
    AND "siteId" IS NOT NULL;

CREATE UNIQUE INDEX "StoreCountSession_one_active_unassigned_starter"
  ON "StoreCountSession"("startedById")
  WHERE "status" = 'ACTIVE'
    AND "assignedToId" IS NULL
    AND "startedById" IS NOT NULL;

-- Store-total adjustments intentionally have no physical location. Physical
-- movement events still require a location at the transaction site.
CREATE OR REPLACE FUNCTION "validate_inventory_transaction_scope"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  site_org TEXT;
  location_site TEXT;
  product_org TEXT;
  packaging_product TEXT;
  actor_is_member BOOLEAN;
BEGIN
  SELECT "organizationId" INTO site_org
  FROM "Site"
  WHERE "id" = NEW."siteId";

  IF site_org IS NULL OR site_org <> NEW."organizationId" THEN
    RAISE EXCEPTION 'InventoryTransaction Site must belong to Organization';
  END IF;

  IF NEW."locationId" IS NULL THEN
    IF NEW."type" NOT IN ('COUNT_ADJUSTMENT', 'MANUAL_ADJUSTMENT') THEN
      RAISE EXCEPTION 'InventoryTransaction physical movement requires a Location';
    END IF;
  ELSE
    SELECT "siteId" INTO location_site
    FROM "StoreLocation"
    WHERE "id" = NEW."locationId";

    IF location_site IS NULL OR location_site <> NEW."siteId" THEN
      RAISE EXCEPTION 'InventoryTransaction Location must belong to Site';
    END IF;
  END IF;

  SELECT "organizationId" INTO product_org
  FROM "Product"
  WHERE "id" = NEW."productId";

  IF product_org IS NULL OR product_org <> NEW."organizationId" THEN
    RAISE EXCEPTION 'InventoryTransaction Product must belong to Organization';
  END IF;

  IF NEW."packagingId" IS NOT NULL THEN
    SELECT "productId" INTO packaging_product
    FROM "ProductPackaging"
    WHERE "id" = NEW."packagingId";

    IF packaging_product IS NULL OR packaging_product <> NEW."productId" THEN
      RAISE EXCEPTION 'InventoryTransaction Packaging must belong to Product';
    END IF;
  END IF;

  IF NEW."actorUserId" IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM "OrganizationMembership"
      WHERE "organizationId" = NEW."organizationId"
        AND "userId" = NEW."actorUserId"
        AND "isActive" = true
    ) INTO actor_is_member;

    IF NOT actor_is_member THEN
      RAISE EXCEPTION 'InventoryTransaction actor must be an active Organization member';
    END IF;
  END IF;

  IF NEW."quantity" = 0 THEN
    RAISE EXCEPTION 'InventoryTransaction quantity cannot be zero';
  END IF;

  IF NEW."type" IN ('RECEIVE', 'TRANSFER_IN') AND NEW."quantity" <= 0 THEN
    RAISE EXCEPTION 'Inbound InventoryTransaction quantity must be positive';
  END IF;

  IF NEW."type" IN ('SHIP', 'TRANSFER_OUT', 'DAMAGE', 'RETURN_TO_VENDOR') AND NEW."quantity" >= 0 THEN
    RAISE EXCEPTION 'Outbound InventoryTransaction quantity must be negative';
  END IF;

  RETURN NEW;
END;
$$;
