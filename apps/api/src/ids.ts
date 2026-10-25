import { createHash, randomBytes } from "node:crypto";

export type IdPrefix =
	| "org"
	| "key"
	| "rcp"
	| "end"
	| "qte"
	| "pay"
	| "leg"
	| "bat"
	| "whs"
	| "evt"
	| "idm"
	| "aud"
	| "pkp";

export const newId = (prefix: IdPrefix): string => `${prefix}_${randomBytes(12).toString("hex")}`;

export const sha256Hex = (input: string): string => createHash("sha256").update(input, "utf8").digest("hex");

/** A new API key. The full key is shown once; only its hash is stored. */
export function newApiKey(): { key: string; prefix: string; keyHash: string } {
  const key = `fp_test_${randomBytes(24).toString("hex")}`;
  return { key, prefix: key.slice(0, 12), keyHash: sha256Hex(key) };
}
