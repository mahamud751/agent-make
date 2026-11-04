import crypto from "node:crypto";
import { env } from "../config/env";

const key = () => {
  const k = Buffer.from(env.ENCRYPTION_KEY, "base64");
  if (k.length !== 32) throw new Error("ENCRYPTION_KEY must decode to 32 bytes");
  return k;
};

/** AES-256-GCM. Output: base64(iv | tag | ciphertext). */
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}

export function decrypt(payload: string): string {
  const buf = Buffer.from(payload, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}

export const encryptJson = (v: unknown) => encrypt(JSON.stringify(v));
export const decryptJson = <T = Record<string, unknown>>(v: string): T => JSON.parse(decrypt(v)) as T;

export const sha256 = (v: string) => crypto.createHash("sha256").update(v).digest("hex");

export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString("base64url");

export function hmacSign(secret: string, body: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Signature header format: t=<unix>,v1=<hex hmac of "<t>.<body>"> (Stripe-style, replay-resistant). */
export function signPayload(secret: string, body: string, now = Math.floor(Date.now() / 1000)): string {
  return `t=${now},v1=${hmacSign(secret, `${now}.${body}`)}`;
}

export function verifySignature(secret: string, body: string, header: string | undefined, toleranceSec = 300): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!t || !parts.v1) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > toleranceSec) return false;
  return safeEqual(parts.v1, hmacSign(secret, `${t}.${body}`));
}
