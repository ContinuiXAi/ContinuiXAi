import { z } from "zod";

const emailSchema = z.string().trim().email().transform((value) => value.toLowerCase());
const recoveryPinSchema = z.string().regex(/^\d{6}$/, "Recovery PIN must be exactly 6 digits.");

export const PASSWORD_SPECIAL_CHARACTERS = "!@#$%^&*";
export const PASSWORD_RULES_TEXT =
  "Password must be at least 10 characters, must not start with a number, and must include an uppercase letter, a lowercase letter, a number, and one special character: ! @ # $ % ^ & *.";

export const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters.")
  .refine((value) => !/^\d/.test(value), "Password must not start with a number.")
  .refine((value) => /[A-Z]/.test(value), "Password must include at least one uppercase letter.")
  .refine((value) => /[a-z]/.test(value), "Password must include at least one lowercase letter.")
  .refine((value) => /\d/.test(value), "Password must include at least one number.")
  .refine((value) => /[!@#$%^&*]/.test(value), "Password must include at least one special character: ! @ # $ % ^ & *.");

export const bootstrapAdminSchema = z.object({
  name: z.string().trim().min(1),
  email: emailSchema,
  password: passwordSchema,
});

export const loginSchema = z.object({
  identifier: z.string().trim().min(1).optional(),
  email: emailSchema.optional(),
  password: z.string().min(1),
}).refine((value) => !!(value.identifier || value.email), {
  message: "Email or employee number is required.",
});

export const registerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: emailSchema,
  password: passwordSchema,
  recoveryPin: recoveryPinSchema,
});

export const recoverUserIdSchema = z.object({
  email: emailSchema,
  recoveryPin: recoveryPinSchema,
});

export const recoverPasswordSchema = z.object({
  identifier: z.string().trim().min(1),
  recoveryPin: recoveryPinSchema,
  newPassword: passwordSchema,
});

export const createUserSchema = z.object({
  name: z.string().min(1),
  email: emailSchema,
  password: passwordSchema,
  role: z.enum(["ADMIN", "GENERAL"]).default("GENERAL"),
  organizationId: z.string().trim().min(1),
});

export const updateProfileSchema = z.object({
  name: z.string().min(1).optional(),
  email: emailSchema.optional(),
  currentPassword: z.string().optional(),
  newPassword: passwordSchema.optional(),
});

export type BootstrapAdminInput = z.infer<typeof bootstrapAdminSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type RecoverUserIdInput = z.infer<typeof recoverUserIdSchema>;
export type RecoverPasswordInput = z.infer<typeof recoverPasswordSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
