import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import {
  bootstrapAdminSchema,
  createUserSchema,
  loginSchema,
  recoverPasswordSchema,
  recoverUserIdSchema,
  registerSchema,
  updateProfileSchema,
} from "@continuixai/shared";
import { prisma } from "../lib/prisma.js";
import { t } from "../lib/i18n.js";
import { bumpTokenVersion, invalidateTokenVersionCache } from "../lib/tokenVersion.js";
import { clearMediaCookie } from "../lib/mediaAuth.js";
import { isPublicRegistrationEnabled } from "../lib/publicRegistration.js";
import { comparePasswordOrDummy, compareRecoveryPinOrDummy } from "../lib/credentialTiming.js";
import { revokeAllUserSessions, revokeSession } from "../lib/sessionService.js";

function newEmployeeNumber(): string {
  return `EMP-${randomBytes(5).toString("hex").toUpperCase()}`;
}

async function createEmployeeNumber(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = newEmployeeNumber();
    const exists = await prisma.user.findUnique({ where: { employeeNumber: candidate }, select: { id: true } });
    if (!exists) return candidate;
  }
  throw new Error("Unable to allocate a unique employee number.");
}

async function findOrganizationScopedAdminTarget(adminUserId: string, targetUserId: string) {
  return prisma.user.findFirst({
    where: {
      id: targetUserId,
      organizationMemberships: {
        some: {
          isActive: true,
          organization: {
            isActive: true,
            memberships: {
              some: { userId: adminUserId, isActive: true, role: { in: ["OWNER", "ADMIN"] } },
            },
          },
        },
        none: {
          isActive: true,
          organization: {
            isActive: true,
            memberships: {
              none: { userId: adminUserId, isActive: true, role: { in: ["OWNER", "ADMIN"] } },
            },
          },
        },
      },
    },
  });
}

async function verifyRecoveryPin(user: {
  id: string;
  recoveryPinHash: string | null;
  recoveryFailureCount: number;
  recoveryLockedUntil: Date | null;
}, pin: string): Promise<boolean> {
  const validPin = await compareRecoveryPinOrDummy(pin, user.recoveryPinHash);
  if (!user.recoveryPinHash || (user.recoveryLockedUntil && user.recoveryLockedUntil > new Date())) return false;
  if (validPin) {
    await prisma.user.update({
      where: { id: user.id },
      data: { recoveryFailureCount: 0, recoveryLockedUntil: null },
    });
    return true;
  }
  const shouldLock = user.recoveryFailureCount >= 4;
  await prisma.user.update({
    where: { id: user.id },
    data: {
      recoveryFailureCount: shouldLock ? 0 : { increment: 1 },
      recoveryLockedUntil: shouldLock ? new Date(Date.now() + 15 * 60_000) : null,
    },
  });
  return false;
}

export async function authRoutes(app: FastifyInstance) {
  app.get("/registration-status", async () => ({ enabled: isPublicRegistrationEnabled() }));

  app.get("/bootstrap/status", async () => {
    const userCount = await prisma.user.count();
    return { needsBootstrap: userCount === 0 };
  });

  app.post("/bootstrap/admin", async (request, reply) => {
    const parsed = bootstrapAdminSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const userCount = await prisma.user.count();
    if (userCount > 0) return reply.code(409).send({ error: t("bootstrapDisabled", request.locale) });

    const { name, email, password } = parsed.data;
    const passwordHash = await bcrypt.hash(password, 10);
    const employeeNumber = await createEmployeeNumber();
    const user = await prisma.user.create({ data: { name, email, employeeNumber, passwordHash, role: "ADMIN" } });
    return reply.code(201).send({ id: user.id, name: user.name, email: user.email, employeeNumber: user.employeeNumber, role: user.role });
  });

  app.post("/register", { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } }, async (request, reply) => {
    if (!isPublicRegistrationEnabled()) {
      return reply.code(403).send({ error: "Account creation requires an administrator." });
    }
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { name, email, password, recoveryPin } = parsed.data;
    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) return reply.code(409).send({ error: "An account with that email already exists." });

    const [passwordHash, recoveryPinHash, employeeNumber] = await Promise.all([
      bcrypt.hash(password, 10), bcrypt.hash(recoveryPin, 10), createEmployeeNumber(),
    ]);
    const user = await prisma.user.create({ data: { name, email, employeeNumber, passwordHash, recoveryPinHash, role: "GENERAL" } });
    return reply.code(201).send({ id: user.id, name: user.name, email: user.email, employeeNumber: user.employeeNumber, role: user.role });
  });

  app.post("/login", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const identifier = (parsed.data.identifier ?? parsed.data.email ?? "").trim();
    const user = await prisma.user.findFirst({ where: { OR: [{ email: identifier.toLowerCase() }, { employeeNumber: identifier.toUpperCase() }] } });
    const valid = await comparePasswordOrDummy(parsed.data.password, user?.passwordHash);
    if (!user || !user.isActive || !valid) return reply.code(401).send({ error: t("invalidCredentials", request.locale) });

    const purpose = user.mfaEnabled ? "mfa-login" : "mfa-setup";
    const challengeToken = app.jwt.sign({ sub: user.id, role: user.role, tv: user.tokenVersion, purpose }, { expiresIn: "10m" });
    return {
      mfaRequired: true,
      enrollmentRequired: !user.mfaEnabled,
      challengeToken,
      user: { id: user.id, name: user.name, email: user.email, employeeNumber: user.employeeNumber, role: user.role },
    };
  });

  app.post("/recover/user-id", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const parsed = recoverUserIdSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
    if (!user || !user.isActive || !user.recoveryPinHash) { await compareRecoveryPinOrDummy(parsed.data.recoveryPin); return reply.code(401).send({ error: "We could not verify that account." }); }
    const valid = await verifyRecoveryPin(user, parsed.data.recoveryPin);
    if (!valid) return reply.code(401).send({ error: "We could not verify that account." });
    return { employeeNumber: user.employeeNumber, email: user.email };
  });

  app.post("/recover/password", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const parsed = recoverPasswordSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const identifier = parsed.data.identifier.trim();
    const user = await prisma.user.findFirst({ where: { OR: [{ email: identifier.toLowerCase() }, { employeeNumber: identifier.toUpperCase() }] } });
    if (!user || !user.isActive || !user.recoveryPinHash) { await compareRecoveryPinOrDummy(parsed.data.recoveryPin); return reply.code(401).send({ error: "We could not verify that account." }); }
    const valid = await verifyRecoveryPin(user, parsed.data.recoveryPin);
    if (!valid) return reply.code(401).send({ error: "We could not verify that account." });
    const passwordHash = await bcrypt.hash(parsed.data.newPassword, 10);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
    await bumpTokenVersion(user.id);
    await revokeAllUserSessions(user.id);
    return { ok: true };
  });

  app.post("/logout", { preHandler: [app.authenticate] }, async (request, reply) => {
    await revokeSession(request.user.sid!);
    clearMediaCookie(reply);
    return reply.code(204).send();
  });

  app.post("/logout-all", { preHandler: [app.authenticate] }, async (request, reply) => {
    await bumpTokenVersion(request.user.sub);
    await revokeAllUserSessions(request.user.sub);
    clearMediaCookie(reply);
    return reply.code(204).send();
  });

  app.get("/me", { preHandler: [app.authenticate] }, async (request, reply) => {
    const user = await prisma.user.findUnique({ where: { id: request.user.sub } });
    if (!user || !user.isActive) return reply.code(401).send({ error: "unauthorized" });
    const taskManager = user.role === "ADMIN" || Boolean(await prisma.organizationMembership.findFirst({
      where: { userId: user.id, isActive: true, role: { in: ["OWNER", "ADMIN", "MANAGER"] } },
      select: { id: true },
    }));
    return { id: user.id, name: user.name, email: user.email, employeeNumber: user.employeeNumber, role: user.role, jobTitle: user.jobTitle, taskManager, mfaEnabled: user.mfaEnabled };
  });

  app.get("/user-organizations", { preHandler: [app.authenticate, app.requireAdmin] }, async (request) => {
    const memberships = await prisma.organizationMembership.findMany({
      where: {
        userId: request.user.sub,
        isActive: true,
        role: { in: ["OWNER", "ADMIN"] },
        organization: { isActive: true },
      },
      select: { organization: { select: { id: true, name: true } } },
      orderBy: { organization: { name: "asc" } },
    });
    return memberships.map(({ organization }) => organization);
  });

  app.post("/users", { preHandler: [app.authenticate, app.requireAdmin] }, async (request, reply) => {
    const parsed = createUserSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { name, email, password, role, organizationId } = parsed.data;
    const [passwordHash, employeeNumber] = await Promise.all([bcrypt.hash(password, 10), createEmployeeNumber()]);
    const user = await prisma.$transaction(async (tx) => {
      const managedOrganizations = await tx.$queryRaw<Array<{ organizationId: string }>>`
        SELECT membership."organizationId"
        FROM "OrganizationMembership" AS membership
        INNER JOIN "Organization" AS organization
          ON organization."id" = membership."organizationId"
        WHERE membership."userId" = ${request.user.sub}
          AND membership."organizationId" = ${organizationId}
          AND membership."isActive" = TRUE
          AND membership."role" IN ('OWNER', 'ADMIN')
          AND organization."isActive" = TRUE
        FOR UPDATE OF membership, organization
      `;
      if (managedOrganizations.length !== 1) return null;

      const sites = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT site."id"
        FROM "Site" AS site
        WHERE site."organizationId" = ${organizationId}
          AND site."isActive" = TRUE
        FOR UPDATE OF site
      `;
      const created = await tx.user.create({ data: { name, email, employeeNumber, passwordHash, role } });
      await tx.organizationMembership.create({ data: { organizationId, userId: created.id, role: role === "ADMIN" ? "ADMIN" : "VIEWER" } });
      for (const site of sites) await tx.siteMembership.create({ data: { siteId: site.id, userId: created.id } });
      return created;
    });
    if (!user) return reply.code(404).send({ error: "Organization not found." });
    return reply.code(201).send({ id: user.id, name: user.name, email: user.email, employeeNumber: user.employeeNumber, role: user.role, isActive: user.isActive });
  });

  app.get("/users", { preHandler: [app.authenticate, app.requireAdmin] }, async (request) => {
    return prisma.user.findMany({ where: { OR: [{ id: request.user.sub }, { organizationMemberships: { some: { isActive: true, organization: { memberships: { some: { userId: request.user.sub, isActive: true } } } } } }] }, select: { id: true, name: true, email: true, employeeNumber: true, role: true, jobTitle: true, isActive: true, mfaEnabled: true }, orderBy: { createdAt: "asc" } });
  });

  app.delete("/users/:id", { preHandler: [app.authenticate, app.requireAdmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (id === request.user.sub) return reply.code(400).send({ error: t("cannotDeleteSelf", request.locale) });
    const target = await findOrganizationScopedAdminTarget(request.user.sub, id);
    if (!target) return reply.code(404).send({ error: t("userNotFound", request.locale) });
    await prisma.user.update({ where: { id }, data: { isActive: false } });
    await prisma.organizationMembership.updateMany({ where: { userId: id }, data: { isActive: false } });
    await bumpTokenVersion(id);
    await revokeAllUserSessions(id);
    return reply.code(204).send();
  });

  app.post("/users/:id/reset-password", { preHandler: [app.authenticate, app.requireAdmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (id === request.user.sub) return reply.code(400).send({ error: t("cannotResetOwnPassword", request.locale) });
    const target = await findOrganizationScopedAdminTarget(request.user.sub, id);
    if (!target) return reply.code(404).send({ error: t("userNotFound", request.locale) });
    const temporaryPassword = randomBytes(12).toString("base64url");
    const passwordHash = await bcrypt.hash(temporaryPassword, 10);
    await prisma.user.update({ where: { id }, data: { passwordHash } });
    await bumpTokenVersion(id);
    await revokeAllUserSessions(id);
    return { id: target.id, email: target.email, name: target.name, temporaryPassword };
  });

  app.post("/users/:id/reset-mfa", { preHandler: [app.authenticate, app.requireAdmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (id === request.user.sub) return reply.code(400).send({ error: "Administrators cannot reset their own authenticator here." });
    const target = await findOrganizationScopedAdminTarget(request.user.sub, id);
    if (!target) return reply.code(404).send({ error: t("userNotFound", request.locale) });
    await prisma.user.update({ where: { id }, data: { mfaEnabled: false, mfaSecretEncrypted: null, mfaBackupCodeHashes: Prisma.DbNull, mfaLastTotpCounter: null } });
    await bumpTokenVersion(id);
    await revokeAllUserSessions(id);
    await prisma.securityAuditEvent.create({ data: { actorUserId: request.user.sub, targetUserId: id, action: "ADMIN_MFA_RESET" } });
    return { ok: true };
  });

  app.patch("/profile", { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsed = updateProfileSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const userId = request.user.sub;
    const { name, email, currentPassword, newPassword } = parsed.data;
    const updateData: Record<string, unknown> = {};
    if (name) updateData.name = name;
    if (email) updateData.email = email;
    if (newPassword) {
      if (!currentPassword) return reply.code(400).send({ error: t("currentPasswordRequired", request.locale) });
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return reply.code(404).send({ error: t("userNotFound", request.locale) });
      const valid = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!valid) return reply.code(400).send({ error: t("incorrectCurrentPassword", request.locale) });
      updateData.passwordHash = await bcrypt.hash(newPassword, 10);
    }
    const user = await prisma.user.update({ where: { id: userId }, data: updateData });
    if (newPassword) { await bumpTokenVersion(userId); await revokeAllUserSessions(userId); clearMediaCookie(reply); } else invalidateTokenVersionCache(userId);
    return { id: user.id, name: user.name, email: user.email, employeeNumber: user.employeeNumber, role: user.role, jobTitle: user.jobTitle, mfaEnabled: user.mfaEnabled };
  });
}
