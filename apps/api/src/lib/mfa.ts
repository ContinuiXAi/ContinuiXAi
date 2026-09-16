import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import * as OTPAuth from "otpauth";

function key(): Buffer {
  const source = process.env.MFA_ENCRYPTION_KEY || "dev-mfa-encryption-key-change-me";
  return createHash("sha256").update(source).digest();
}

export function assertMfaEncryptionConfig(): void {
  if (process.env.NODE_ENV !== "production") return;
  const source = process.env.MFA_ENCRYPTION_KEY?.trim() ?? "";
  if (source.length < 32) {
    throw new Error("MFA_ENCRYPTION_KEY must be an independent random value of at least 32 characters in production.");
  }
  if (source === process.env.JWT_SECRET) {
    throw new Error("MFA_ENCRYPTION_KEY must not equal JWT_SECRET.");
  }
}

export function generateTotpSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}
export function findTotpCounter(secret: string, code: string, now = Date.now()): bigint | null {
  const normalized = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(normalized)) return null;
  const totp = new OTPAuth.TOTP({ issuer: "ContinuiXAi Ops", algorithm: "SHA1", digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) });
  const delta = totp.validate({ token: normalized, timestamp: now, window: 1 });
  return delta === null ? null : BigInt(Math.floor(now / 30_000) + delta);
}

export function verifyTotp(secret: string, code: string, now = Date.now()): boolean {
  return findTotpCounter(secret, code, now) !== null;
}

export function encryptSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function decryptSecret(payload: string): string {
  const [ivText, tagText, cipherText] = payload.split(".");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(cipherText, "base64url")), decipher.final()]).toString("utf8");
}

export function otpauthUri(secret: string, account: string): string {
  return new OTPAuth.TOTP({ issuer: "ContinuiXAi Ops", label: account, algorithm: "SHA1", digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).toString();
}

export function generateBackupCodes(): string[] {
  return Array.from({ length: 8 }, () => randomBytes(5).toString("hex").toUpperCase());
}

export async function hashBackupCodes(codes: string[]): Promise<string[]> {
  return Promise.all(codes.map((code) => bcrypt.hash(code, 10)));
}

export async function consumeBackupCode(code: string, hashes: string[]): Promise<{ valid: boolean; remaining: string[] }> {
  const normalized = code.trim().toUpperCase();
  for (let i = 0; i < hashes.length; i += 1) {
    if (await bcrypt.compare(normalized, hashes[i])) return { valid: true, remaining: hashes.filter((_, index) => index !== i) };
  }
  return { valid: false, remaining: hashes };
}
