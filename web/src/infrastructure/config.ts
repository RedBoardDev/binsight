/**
 * Public client configuration. Auth is 100% Privy: the browser holds the Privy access token and
 * calls the API origin DIRECTLY (no BFF proxy, no session cookie), so both values are
 * `NEXT_PUBLIC_` vars inlined into the client bundle at build time.
 */

/** Backend API base URL — the browser calls it directly with the Privy token as Bearer. */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8787';

/** Privy application id for the browser SDK (same Privy app the API verifies against). */
export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? '';
