import { z } from "zod";

export const productInputSchema = z.object({
  barcodeValue: z.string().trim().min(1).max(64).nullable().optional(),
  name: z.string().trim().min(1).max(300),
  manufacturer: z.string().trim().max(200).nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  packageSize: z.string().trim().max(120).nullable().optional(),
  imageUrl: z.string().trim().max(2000).nullable().optional(),
  categoryId: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
});
export type ProductInput = z.infer<typeof productInputSchema>;

export const productUpdateSchema = productInputSchema.partial();
export type ProductUpdate = z.infer<typeof productUpdateSchema>;

/** The commit deliberately accepts only a server-issued preview and tenant id. */
export const productCsvCommitSchema = z.object({
  previewId: z.string().uuid(),
  organizationId: z.string().trim().min(1),
}).strict();
export type ProductCsvCommit = z.infer<typeof productCsvCommitSchema>;

export const productCsvNormalizedRowSchema = z.object({
  row: z.number().int().positive(),
  status: z.enum(["valid", "warning", "error"]),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  upc: z.string().max(64).nullable(),
  name: z.string().max(300).nullable(),
  manufacturer: z.string().max(200).nullable(),
  description: z.string().max(2000).nullable(),
  packageSize: z.string().max(120).nullable(),
  category: z.string().max(200).nullable(),
  categoryId: z.string().nullable(),
  isActive: z.boolean(),
});
export type ProductCsvNormalizedRow = z.infer<typeof productCsvNormalizedRowSchema>;
