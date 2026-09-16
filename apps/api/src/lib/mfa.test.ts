import { describe, expect, it } from "vitest";
import {
  consumeBackupCode,
  decryptSecret,
  encryptSecret,
  generateBackupCodes,
  generateTotpSecret,
  hashBackupCodes,
  verifyTotp,
  assertMfaEncryptionConfig,
  findTotpCounter,
} from "./mfa.js";

describe("MFA helpers", () => {
  it("generates a valid base32 TOTP secret", () => {
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });

  it("encrypts the TOTP secret at rest and decrypts it correctly", () => {
    const secret = "JBSWY3DPEHPK3PXP";
    const encrypted = encryptSecret(secret);
    expect(encrypted).not.toContain(secret);
    expect(decryptSecret(encrypted)).toBe(secret);
  });

  it("accepts the RFC TOTP vector using the app's six-digit truncation", () => {
    const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    expect(verifyTotp(rfcSecret, "287082", 59_000)).toBe(true);
    expect(verifyTotp(rfcSecret, "000000", 59_000)).toBe(false);
  });

  it("returns the accepted time-step counter for replay prevention", () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    expect(findTotpCounter(secret, "287082", 59_000)).toBe(1n);
    expect(findTotpCounter(secret, "000000", 59_000)).toBeNull();
  });

  it("makes backup codes single-use", async () => {
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(8);
    const hashes = await hashBackupCodes(codes);
    const first = await consumeBackupCode(codes[0], hashes);
    expect(first.valid).toBe(true);
    expect(first.remaining).toHaveLength(7);
    const second = await consumeBackupCode(codes[0], first.remaining);
    expect(second.valid).toBe(false);
  });

  it("rejects a missing or shared MFA encryption key in production", () => {
    const previous = { nodeEnv: process.env.NODE_ENV, mfa: process.env.MFA_ENCRYPTION_KEY, jwt: process.env.JWT_SECRET };
    process.env.NODE_ENV = "production";
    process.env.JWT_SECRET = "a".repeat(32);
    delete process.env.MFA_ENCRYPTION_KEY;
    expect(() => assertMfaEncryptionConfig()).toThrow(/MFA_ENCRYPTION_KEY/);
    process.env.MFA_ENCRYPTION_KEY = process.env.JWT_SECRET;
    expect(() => assertMfaEncryptionConfig()).toThrow(/must not equal/);
    process.env.MFA_ENCRYPTION_KEY = "b".repeat(32);
    expect(() => assertMfaEncryptionConfig()).not.toThrow();
    process.env.NODE_ENV = previous.nodeEnv;
    if (previous.mfa === undefined) delete process.env.MFA_ENCRYPTION_KEY; else process.env.MFA_ENCRYPTION_KEY = previous.mfa;
    if (previous.jwt === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous.jwt;
  });
});
