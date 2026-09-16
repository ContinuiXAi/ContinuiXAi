import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";
import { setMediaCookie } from "../lib/mediaAuth.js";
import {
  consumeBackupCode,
  decryptSecret,
  encryptSecret,
  generateBackupCodes,
  generateTotpSecret,
  hashBackupCodes,
  findTotpCounter,
} from "../lib/mfa.js";
import { createUserSession } from "../lib/sessionService.js";

const JWT_EXPIRES_IN = "7d";
type UserRole = "ADMIN" | "GENERAL";
type Challenge = { sub: string; role?: UserRole; tv?: number; purpose?: string };

function readChallenge(app: FastifyInstance, token: string): Challenge | null {
  try {
    return app.jwt.verify<Challenge>(token);
  } catch {
    return null;
  }
}

async function loadChallengeUser(app: FastifyInstance, token: string, purpose: "mfa-setup" | "mfa-login") {
  const challenge = readChallenge(app, token);
  if (!challenge || challenge.purpose !== purpose || typeof challenge.tv !== "number") return null;
  const user = await prisma.user.findUnique({ where: { id: challenge.sub } });
  if (!user || !user.isActive || user.tokenVersion !== challenge.tv) return null;
  return user;
}

async function sessionResponse(app: FastifyInstance, reply: Parameters<typeof setMediaCookie>[1], user: { id: string; name: string; email: string; employeeNumber: string | null; role: UserRole; tokenVersion: number }) {
  const session = await createUserSession(user.id, user.tokenVersion);
  const token = app.jwt.sign({ sub: user.id, role: user.role, tv: user.tokenVersion, sid: session.id }, { expiresIn: JWT_EXPIRES_IN });
  setMediaCookie(app, reply, user.id, user.tokenVersion, session.id);
  return { token, user: { id: user.id, name: user.name, email: user.email, employeeNumber: user.employeeNumber, role: user.role, mfaEnabled: true } };
}

export async function mfaRoutes(app: FastifyInstance) {
  app.post("/mfa/setup", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const { challengeToken } = (request.body ?? {}) as { challengeToken?: string };
    if (!challengeToken) return reply.code(400).send({ error: "MFA setup token is required." });
    const user = await loadChallengeUser(app, challengeToken, "mfa-setup");
    if (!user) return reply.code(401).send({ error: "MFA setup session expired. Sign in again." });
    if (user.mfaEnabled) return reply.code(409).send({ error: "Authenticator setup is already complete." });

    let secret: string;
    if (user.mfaSecretEncrypted) {
      try { secret = decryptSecret(user.mfaSecretEncrypted); } catch { secret = generateTotpSecret(); }
    } else {
      secret = generateTotpSecret();
    }
    await prisma.user.update({ where: { id: user.id }, data: { mfaSecretEncrypted: encryptSecret(secret), mfaEnabled: false } });
    return { secret, account: user.employeeNumber || user.email };
  });

  app.post("/mfa/confirm", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const { challengeToken, code } = (request.body ?? {}) as { challengeToken?: string; code?: string };
    if (!challengeToken || !code) return reply.code(400).send({ error: "MFA setup token and 6-digit code are required." });
    const user = await loadChallengeUser(app, challengeToken, "mfa-setup");
    if (!user || !user.mfaSecretEncrypted) return reply.code(401).send({ error: "MFA setup session expired. Sign in again." });

    let secret: string;
    try { secret = decryptSecret(user.mfaSecretEncrypted); } catch { return reply.code(400).send({ error: "MFA setup must be restarted." }); }
    const counter = findTotpCounter(secret, code);
    if (counter === null) return reply.code(401).send({ error: "That verification code is not correct." });

    const backupCodes = generateBackupCodes();
    const hashes = await hashBackupCodes(backupCodes);
    const accepted = await prisma.user.updateMany({ where: { id: user.id, tokenVersion: user.tokenVersion, mfaEnabled: false }, data: { mfaEnabled: true, mfaBackupCodeHashes: hashes, mfaLastTotpCounter: counter, tokenVersion: { increment: 1 } } });
    if (accepted.count !== 1) return reply.code(409).send({ error: "Authenticator setup was already completed. Sign in again." });
    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    return { ...await sessionResponse(app, reply, updated), backupCodes };
  });

  app.post("/mfa/verify", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const { challengeToken, code } = (request.body ?? {}) as { challengeToken?: string; code?: string };
    if (!challengeToken || !code) return reply.code(400).send({ error: "MFA challenge and verification code are required." });
    const user = await loadChallengeUser(app, challengeToken, "mfa-login");
    if (!user || !user.mfaEnabled || !user.mfaSecretEncrypted) return reply.code(401).send({ error: "MFA verification session expired. Sign in again." });

    let counter: bigint | null = null;
    try { counter = findTotpCounter(decryptSecret(user.mfaSecretEncrypted), code); } catch { /* invalid encrypted secret */ }
    if (counter !== null) {
      const accepted = await prisma.user.updateMany({ where: { id: user.id, OR: [{ mfaLastTotpCounter: null }, { mfaLastTotpCounter: { lt: counter } }] }, data: { mfaLastTotpCounter: counter } });
      if (accepted.count !== 1) return reply.code(401).send({ error: "That verification code has already been used." });
      return sessionResponse(app, reply, user);
    }

    const hashes = Array.isArray(user.mfaBackupCodeHashes) ? user.mfaBackupCodeHashes.filter((v): v is string => typeof v === "string") : [];
    const backup = await consumeBackupCode(code, hashes);
    if (!backup.valid) return reply.code(401).send({ error: "That verification code is not correct." });

    const consumed = await prisma.user.updateMany({ where: { id: user.id, mfaBackupCodeHashes: { equals: hashes } }, data: { mfaBackupCodeHashes: backup.remaining } });
    if (consumed.count !== 1) return reply.code(401).send({ error: "That backup code has already been used." });
    return sessionResponse(app, reply, user);
  });
}
