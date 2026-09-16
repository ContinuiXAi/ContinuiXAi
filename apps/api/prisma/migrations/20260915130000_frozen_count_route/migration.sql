-- Freeze the assigned product/location set. Later hint changes apply only to
-- future counts. Preserve existing visits, entries, reviews and assignment history.
ALTER TABLE "StoreCountSession" ADD COLUMN "routeSnapshot" JSONB NOT NULL DEFAULT '[]';

UPDATE "StoreCountSession" AS session
SET "routeSnapshot" = COALESCE((
  SELECT jsonb_agg(jsonb_build_object(
    'productId', hint."productId", 'locationId', hint."locationId", 'evidence', hint."evidence", 'isRequired', hint."isRequired",
    'product', jsonb_build_object('id', product."id", 'barcodeValue', product."barcodeValue", 'name', product."name", 'packageSize', product."packageSize"),
    'location', jsonb_build_object('id', location."id", 'code', location."code", 'sortOrder', location."sortOrder")
  ) ORDER BY location."sortOrder", location."code", product."id")
  FROM "ProductLocationHint" AS hint
  INNER JOIN "Site" AS site ON site."id" = session."siteId"
  INNER JOIN "Product" AS product ON product."id" = hint."productId" AND product."organizationId" = site."organizationId"
  INNER JOIN "StoreLocation" AS location ON location."id" = hint."locationId" AND location."siteId" = site."id"
  WHERE hint."siteId" = site."id" AND hint."organizationId" = site."organizationId"
), '[]'::jsonb);
