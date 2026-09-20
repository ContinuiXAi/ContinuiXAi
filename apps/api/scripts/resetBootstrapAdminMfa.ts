import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

const email = argument("--email")?.toLowerCase();
const reason = argument("--reason");
if (!email || !reason || reason.length < 8) {
  throw new Error("Usage: npm run admin:mfa-reset -- --email <email> --reason <at-least-8-characters>");
}

const administrators = await prisma.user.findMany({ where: { email, role: "ADMIN", isActive: true }, select: { id: true } });
if (administrators.length !== 1) throw new Error("Exactly one active administrator must match the supplied email.");
const targetUserId = administrators[0].id;

await prisma.$transaction(async (tx) => {
  await tx.user.update({ where: { id: targetUserId }, data: { mfaEnabled: false, mfaSecretEncrypted: null, mfaBackupCodeHashes: Prisma.DbNull, mfaLastTotpCounter: null, tokenVersion: { increment: 1 } } });
  await tx.userSession.updateMany({ where: { userId: targetUserId, revokedAt: null }, data: { revokedAt: new Date() } });
  await tx.securityAuditEvent.create({ data: { targetUserId, action: "OPERATOR_BREAK_GLASS_MFA_RESET", reason } });
});

console.log("Administrator authenticator reset completed and active sessions revoked. Audit event recorded.");
await prisma.$disconnect();
