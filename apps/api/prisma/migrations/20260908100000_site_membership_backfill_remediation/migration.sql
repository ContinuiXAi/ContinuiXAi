-- Preserve the access organization members had before site-level authorization
-- was introduced. This corrective migration intentionally runs after
-- 20260908000000_site_membership on both fresh and already-populated databases.
INSERT INTO "SiteMembership" ("id", "siteId", "userId", "isActive", "createdAt", "updatedAt")
SELECT
  'sm_' || md5(random()::text || clock_timestamp()::text || s."id" || om."userId"),
  s."id",
  om."userId",
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "OrganizationMembership" om
JOIN "Organization" o ON o."id" = om."organizationId" AND o."isActive" = true
JOIN "Site" s ON s."organizationId" = om."organizationId" AND s."isActive" = true
JOIN "User" u ON u."id" = om."userId" AND u."isActive" = true
WHERE om."isActive" = true
ON CONFLICT ("siteId", "userId")
DO UPDATE SET "isActive" = true, "updatedAt" = CURRENT_TIMESTAMP;
