-- 20260908000000_site_membership's backfill INSERT did not filter on
-- Organization.isActive, so a member of an already-deactivated organization
-- could receive a live SiteMembership row to that organization's site(s).
-- 20260908100000_site_membership_backfill_remediation correctly filters on
-- Organization.isActive going forward, but never revisited rows the first
-- migration had already created for inactive organizations.
--
-- This migration closes that gap by deactivating (not deleting, to preserve
-- the audit trail) any SiteMembership row whose organization is inactive.
-- Confirmed by seeding a deactivated organization with an active member
-- before this migration and observing the stale active row survive both
-- prior migrations unchanged.
UPDATE "SiteMembership" sm
SET "isActive" = false, "updatedAt" = CURRENT_TIMESTAMP
FROM "Site" s
JOIN "Organization" o ON o."id" = s."organizationId"
WHERE s."id" = sm."siteId"
  AND o."isActive" = false
  AND sm."isActive" = true;
