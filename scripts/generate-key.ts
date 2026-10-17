// Makes the App's ES256 signing key pair. The private key stays here, in a
// gitignored file; the public JWK it prints is what you paste into Photon's
// Developer → Apps page.
//
//   pnpm keygen [kid]

import { writeFileSync } from "node:fs";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";

const kid = process.argv[2] ?? `supermemory-${new Date().toISOString().slice(0, 10)}`;
if (!/^[A-Za-z0-9._-]{1,128}$/.test(kid)) throw new Error("kid must be 1–128 of [A-Za-z0-9._-]");

const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
const path = `${kid}.pem`;
writeFileSync(path, await exportPKCS8(privateKey), { mode: 0o600, flag: "wx" });

const { kty, crv, x, y } = await exportJWK(publicKey);
console.log(`Private key written to ${path} (keep it out of git; set PHOTON_APP_PRIVATE_KEY_PATH).`);
console.log(`Set PHOTON_APP_KEY_ID=${kid}`);
console.log("Public key for Photon:");
console.log(JSON.stringify({ kty, crv, x, y, kid, alg: "ES256" }, null, 2));
