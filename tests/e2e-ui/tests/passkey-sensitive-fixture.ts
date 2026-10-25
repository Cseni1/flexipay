// Test-only marker for passkey claim payloads. It is not a contract, not an API shape and never
// part of the app bundle: any occurrence in the console, browser storage, DOM or built assets
// means a secret-bearing payload leaked. CCR-20 defines the real wire shapes; the web app
// re-exports them from the shared domain schema instead of copying them here.
export const SENSITIVE_MARKER = "PASSKEY-SENSITIVE-TEST-MARKER"
