// payout_vault error codes, exactly as in contracts/payout_vault/RULES.md.
// The mock settlement adapter (SF2) maps the same numbers to the same names.
export const VAULT_ERRORS = {
  1: "AlreadyInitialized",
  2: "NotInitialized",
  3: "InvalidAmount",
  4: "FeeTooHigh",
  5: "InsufficientBalance",
  6: "PayoutNotFound",
  7: "NotPending",
  8: "Expired",
  9: "NotExpired",
  10: "BadSecret",
  11: "InvalidExpiry",
  12: "DuplicateExternalId",
} as const;

export type VaultErrorCode = keyof typeof VAULT_ERRORS;
export type VaultErrorName = (typeof VAULT_ERRORS)[VaultErrorCode];

export class VaultError extends Error {
  readonly code: VaultErrorCode;
  readonly cause?: unknown;

  constructor(code: VaultErrorCode, cause?: unknown) {
    super(`payout_vault error #${code} ${VAULT_ERRORS[code]}`);
    this.name = "VaultError";
    this.code = code;
    this.cause = cause;
  }

  get errorName(): VaultErrorName {
    return VAULT_ERRORS[this.code];
  }
}

const NAME_TO_CODE = new Map<string, VaultErrorCode>(
  Object.entries(VAULT_ERRORS).map(([code, name]) => [name, Number(code) as VaultErrorCode]),
);

function isVaultCode(n: number): n is VaultErrorCode {
  return n in VAULT_ERRORS;
}

/**
 * Returns the vault error behind a failed call, or undefined when the failure is not a
 * contract error (network, signing, a different contract). Accepts the host error text
 * ("Error(Contract, #12)") and the SDK's decoded Result error ({ message: "DuplicateExternalId" }).
 */
export function toVaultError(err: unknown): VaultError | undefined {
  if (err instanceof VaultError) return err;
  const text =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : typeof err === "object" && err !== null && "message" in err
          ? String((err as { message: unknown }).message)
          : "";
  const byNumber = /Error\(Contract, #(\d+)\)/.exec(text);
  if (byNumber) {
    const n = Number(byNumber[1]);
    if (isVaultCode(n)) return new VaultError(n, err);
  }
  const byName = NAME_TO_CODE.get(text.trim());
  return byName === undefined ? undefined : new VaultError(byName, err);
}
