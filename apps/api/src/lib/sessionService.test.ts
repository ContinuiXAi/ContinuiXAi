import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() }));
vi.mock("./prisma.js", () => ({ prisma: { userSession: mocks } }));
import { createUserSession, isSessionActive, revokeAllUserSessions, revokeSession } from "./sessionService.js";

describe("revocable user sessions", () => {
  beforeEach(() => vi.clearAllMocks());
  it("creates a bounded server-side session", async () => {
    mocks.create.mockResolvedValue({ id: "session" });
    await createUserSession("user", 4);
    expect(mocks.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: "user", tokenVersion: 4, expiresAt: expect.any(Date) }) });
  });
  it("requires matching active unexpired user and token version", async () => {
    mocks.findUnique.mockResolvedValue({ userId: "user", tokenVersion: 4, revokedAt: null, expiresAt: new Date(Date.now() + 60_000) });
    await expect(isSessionActive("session", "user", 4)).resolves.toBe(true);
    await expect(isSessionActive("session", "other", 4)).resolves.toBe(false);
    mocks.findUnique.mockResolvedValue({ userId: "user", tokenVersion: 4, revokedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) });
    await expect(isSessionActive("session", "user", 4)).resolves.toBe(false);
  });
  it("supports current-session and all-session revocation", async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 });
    await revokeSession("session");
    await revokeAllUserSessions("user");
    expect(mocks.updateMany).toHaveBeenNthCalledWith(1, { where: { id: "session", revokedAt: null }, data: { revokedAt: expect.any(Date) } });
    expect(mocks.updateMany).toHaveBeenNthCalledWith(2, { where: { userId: "user", revokedAt: null }, data: { revokedAt: expect.any(Date) } });
  });
});
