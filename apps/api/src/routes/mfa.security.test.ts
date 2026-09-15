import Fastify from "fastify";
import jwt from "@fastify/jwt";
import cookie from "@fastify/cookie";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "user-1", name: "User", email: "user@example.test", employeeNumber: "EMP-1", role: "GENERAL" as const, isActive: true, tokenVersion: 1, mfaEnabled: true, mfaSecretEncrypted: "encrypted", mfaBackupCodeHashes: [], mfaLastTotpCounter: null as bigint | null },
  updateMany: vi.fn(),
  update: vi.fn(),
  session: vi.fn(),
  qr: vi.fn(async () => "data:image/png;base64,test"),
}));

vi.mock("../lib/prisma.js", () => ({ prisma: { user: {
  findUnique: vi.fn(async () => ({ ...mocks.user })),
  findUniqueOrThrow: vi.fn(async () => ({ ...mocks.user })),
  updateMany: mocks.updateMany,
  update: mocks.update,
} } }));
vi.mock("../lib/sessionService.js", () => ({ createUserSession: mocks.session }));
vi.mock("../lib/mfa.js", () => ({
  consumeBackupCode: vi.fn(async () => ({ valid: false, remaining: [] })),
  decryptSecret: vi.fn(() => "SECRET"),
  encryptSecret: vi.fn(() => "encrypted"),
  generateBackupCodes: vi.fn(() => ["BACKUP"]),
  generateTotpSecret: vi.fn(() => "SECRET"),
  hashBackupCodes: vi.fn(async () => ["hash"]),
  otpauthUri: vi.fn(() => "otpauth://totp/test"),
  findTotpCounter: vi.fn(() => 100n),
}));
vi.mock("qrcode", () => ({ default: { toDataURL: mocks.qr } }));

import { mfaRoutes } from "./mfa.js";

async function app() {
  const instance = Fastify();
  await instance.register(cookie);
  await instance.register(jwt, { secret: "test-secret-long-enough" });
  await instance.register(mfaRoutes, { prefix: "/api/auth" });
  return instance;
}

function challenge(instance: Awaited<ReturnType<typeof app>>, purpose: "mfa-setup" | "mfa-login") {
  return instance.jwt.sign({ sub: mocks.user.id, role: mocks.user.role, tv: mocks.user.tokenVersion, purpose });
}

describe("MFA replay controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mocks.user, { tokenVersion: 1, mfaEnabled: true, mfaSecretEncrypted: "encrypted", mfaBackupCodeHashes: [], mfaLastTotpCounter: null });
    mocks.session.mockResolvedValue({ id: "session-1" });
  });

  it("refuses to reopen setup after enrollment is complete", async () => {
    const instance = await app();
    const response = await instance.inject({ method: "POST", url: "/api/auth/mfa/setup", payload: { challengeToken: challenge(instance, "mfa-setup") } });
    expect(response.statusCode).toBe(409);
    expect(mocks.update).not.toHaveBeenCalled();
    await instance.close();
  });

  it("returns only the manual authenticator key and never generates a QR code", async () => {
    Object.assign(mocks.user, { mfaEnabled: false, mfaSecretEncrypted: null });
    const instance = await app();
    const response = await instance.inject({ method: "POST", url: "/api/auth/mfa/setup", payload: { challengeToken: challenge(instance, "mfa-setup") } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ secret: "SECRET", account: "EMP-1" });
    expect(mocks.qr).not.toHaveBeenCalled();
    await instance.close();
  });

  it("atomically refuses reuse of an accepted TOTP counter", async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const instance = await app();
    const token = challenge(instance, "mfa-login");
    const first = await instance.inject({ method: "POST", url: "/api/auth/mfa/verify", payload: { challengeToken: token, code: "123456" } });
    const replay = await instance.inject({ method: "POST", url: "/api/auth/mfa/verify", payload: { challengeToken: token, code: "123456" } });
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error).toMatch(/already been used/);
    await instance.close();
  });

  it("consumes enrollment by advancing tokenVersion", async () => {
    Object.assign(mocks.user, { mfaEnabled: false });
    mocks.updateMany.mockImplementationOnce(async () => { Object.assign(mocks.user, { mfaEnabled: true, tokenVersion: 2, mfaLastTotpCounter: 100n }); return { count: 1 }; });
    const instance = await app();
    const token = challenge(instance, "mfa-setup");
    const first = await instance.inject({ method: "POST", url: "/api/auth/mfa/confirm", payload: { challengeToken: token, code: "123456" } });
    const replay = await instance.inject({ method: "POST", url: "/api/auth/mfa/confirm", payload: { challengeToken: token, code: "123456" } });
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(401);
    await instance.close();
  });
});
