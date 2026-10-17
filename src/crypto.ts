import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM for what this service keeps at rest: the App's client secret,
// webhook signing secrets and queued messages. Format: v1.<iv>.<tag>.<data>,
// each part base64url.

export function seal(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), data].map((part) =>
    typeof part === "string" ? part : part.toString("base64url"),
  ).join(".");
}

export function open(key: Buffer, sealed: string): string {
  const [version, iv, tag, data] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || data === undefined) throw new Error("Unreadable sealed value");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(data, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
