import { randomUUID } from "node:crypto";
import { prisma } from "./prisma.js";

export const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export function createUserSession(userId: string, tokenVersion: number) {
  return prisma.userSession.create({ data: { id: randomUUID(), userId, tokenVersion, expiresAt: new Date(Date.now() + SESSION_LIFETIME_MS) } });
}

export async function isSessionActive(sessionId: string, userId: string, tokenVersion: number): Promise<boolean> {
  const session = await prisma.userSession.findUnique({ where: { id: sessionId } });
  return Boolean(session && session.userId === userId && session.tokenVersion === tokenVersion && !session.revokedAt && session.expiresAt > new Date());
}

export async function revokeSession(sessionId: string): Promise<void> {
  await prisma.userSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function revokeAllUserSessions(userId: string): Promise<void> {
  await prisma.userSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}
