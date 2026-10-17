import { createInstallationAssertion } from "@photon-hq/auth-api/installation-backend";
import { importPKCS8 } from "jose";

/** Signs a fresh client assertion for one Photon endpoint path. Never reuse one, even on retry. */
export type AssertionSigner = (path: string) => Promise<string>;

export async function createAssertionSigner(options: {
  apiOrigin: string;
  appId: string;
  keyId: string;
  algorithm: "ES256" | "RS256";
  privateKeyPem: string;
}): Promise<AssertionSigner> {
  const privateKey = await importPKCS8(options.privateKeyPem, options.algorithm);
  return (path) =>
    createInstallationAssertion({
      appId: options.appId,
      // Photon checks the exact endpoint URL as the audience.
      audience: new URL(path, options.apiOrigin).href,
      algorithm: options.algorithm,
      keyId: options.keyId,
      privateKey,
    });
}
