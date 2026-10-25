import { Address, Keypair, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
	PasskeyAuthMismatchError,
	authEntryAddress,
	authEntryExpirationLedger,
	authEntryNonce,
	decodeSealedPrepareBlob,
	encodeSealedPrepareBlob,
	matchSignedAuthEntries,
	rootInvocationFingerprint,
	stampAuthEntryExpiration,
} from "../src/index.ts";

function makeAuthEntry(opts: {
	address: string;
	nonce: string;
	expiration: number;
	invocationBytes?: Buffer;
}): xdr.SorobanAuthorizationEntry {
	const rootInvocation = new xdr.SorobanAuthorizedInvocation({
		function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
			new xdr.InvokeContractArgs({
				contractAddress: Address.fromString(opts.address).toScAddress(),
				functionName: "claim",
				args: [
					xdr.ScVal.scvBytes(opts.invocationBytes ?? Buffer.from("secret-bytes")),
				],
			}),
		),
		subInvocations: [],
	});
	return new xdr.SorobanAuthorizationEntry({
		credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
			new xdr.SorobanAddressCredentials({
				address: Address.fromString(opts.address).toScAddress(),
				nonce: xdr.Int64.fromString(opts.nonce),
				signatureExpirationLedger: opts.expiration,
				signature: xdr.ScVal.scvVoid(),
			}),
		),
		rootInvocation,
	});
}

describe("passkey claim auth matching", () => {
	// G… credentials exercise the same address/nonce/fingerprint rules as C….
	const address = Keypair.random().publicKey();

	it("stamps expiration without changing fingerprint of rootInvocation", () => {
		const entry = makeAuthEntry({ address, nonce: "42", expiration: 100 });
		const before = rootInvocationFingerprint(entry);
		const stamped = stampAuthEntryExpiration(entry, 999_999);
		expect(authEntryExpirationLedger(stamped)).toBe(999_999);
		expect(rootInvocationFingerprint(stamped)).toBe(before);
		expect(authEntryNonce(stamped)).toBe("42");
		expect(authEntryAddress(stamped)).toBe(address);
	});

	it("accepts signed entries that match prepare meta", () => {
		const unsigned = stampAuthEntryExpiration(
			makeAuthEntry({ address, nonce: "7", expiration: 1 }),
			500_000,
		);
		const meta = {
			signatureExpirationLedger: 500_000,
			fingerprints: [rootInvocationFingerprint(unsigned)],
			nonces: [authEntryNonce(unsigned)],
			addresses: [authEntryAddress(unsigned)],
		};
		const signedXdr = unsigned.toXDR("base64");
		const matched = matchSignedAuthEntries(meta, [signedXdr]);
		expect(matched).toHaveLength(1);
		expect(authEntryExpirationLedger(matched[0]!)).toBe(500_000);
	});

	it("rejects wrong signatureExpirationLedger", () => {
		const entry = stampAuthEntryExpiration(
			makeAuthEntry({ address, nonce: "1", expiration: 1 }),
			100,
		);
		const meta = {
			signatureExpirationLedger: 100,
			fingerprints: [rootInvocationFingerprint(entry)],
			nonces: ["1"],
			addresses: [address],
		};
		const wrong = stampAuthEntryExpiration(entry, 101);
		expect(() =>
			matchSignedAuthEntries(meta, [wrong.toXDR("base64")]),
		).toThrow(PasskeyAuthMismatchError);
	});

	it("rejects rootInvocation fingerprint drift", () => {
		const a = stampAuthEntryExpiration(
			makeAuthEntry({
				address,
				nonce: "1",
				expiration: 1,
				invocationBytes: Buffer.from("a"),
			}),
			50,
		);
		const b = stampAuthEntryExpiration(
			makeAuthEntry({
				address,
				nonce: "1",
				expiration: 1,
				invocationBytes: Buffer.from("b"),
			}),
			50,
		);
		const meta = {
			signatureExpirationLedger: 50,
			fingerprints: [rootInvocationFingerprint(a)],
			nonces: ["1"],
			addresses: [address],
		};
		expect(() => matchSignedAuthEntries(meta, [b.toXDR("base64")])).toThrow(
			/fingerprint/i,
		);
	});

	it("round-trips sealed prepare blob", () => {
		const blob = {
			v: 1 as const,
			authEntries: ["AAAA"],
			hostFunction: "BBBB",
		};
		const decoded = decodeSealedPrepareBlob(encodeSealedPrepareBlob(blob));
		expect(decoded).toEqual(blob);
	});
});
