import { Connection } from '@solana/web3.js';
import type { Logger } from 'pino';

// Reads-only secondary-RPC failover (#50). A whitelisted READ that throws on the primary endpoint gets exactly
// ONE retry on a fallback endpoint; everything else — most importantly `sendRawTransaction` — stays single-transport
// on the primary, so a flaky/lagging fallback can never double-land a transaction or fabricate a confirm verdict.

const RPC_COMMITMENT = 'confirmed'; // matches the mains' historical `new Connection(url, 'confirmed')` byte-for-byte
const FALLBACK_ATTEMPTS = 1; // one shot on the secondary, never ping-pong

/** Method-name keys of `Connection` (the only names a whitelist may contain — keeps the install typed). */
type ConnectionMethodName = {
  [K in keyof Connection]-?: Connection[K] extends (...args: never[]) => unknown ? K : never;
}[keyof Connection];

/**
 * Brain read whitelist — all idempotent reads on the detection/reconcile/filter path. Worst case of a LAGGING
 * fallback is an early failsafe-close, already bounded by the 90s reconcile open-grace + the direct getAccountInfo
 * close-confirm (fail-safe direction: an extra close attempt, never a double-execution).
 */
export const BRAIN_FAILOVER_READS = [
  'getSignaturesForAddress',
  'getParsedTransactions',
  'getAccountInfo',
  'getMultipleAccountsInfo',
  'getProgramAccounts',
  'getParsedTokenAccountsByOwner',
  'getTokenAccountsByOwner',
  'getBalance',
  'getSlot',
  'getLatestBlockhash',
] as const satisfies readonly ConnectionMethodName[];

/**
 * Coffre read whitelist — getSlot/getLatestBlockhash/getTransaction ONLY. `getBlockHeight` and
 * `getSignatureStatus(es)` stay primary-only ON PURPOSE: a broken/lagging fallback must NEVER fabricate a
 * 'dead' verdict (→ re-claim → re-sign = double-execution). During a primary outage the confirm-worker and
 * recovery simply fail → rows stay 'submitted'/retryLater — a SAFE pause, not a hazard.
 * `sendRawTransaction` is in NO whitelist: land() is single-transport, unchanged.
 */
export const COFFRE_FAILOVER_READS = [
  'getSlot',
  'getLatestBlockhash',
  'getTransaction',
] as const satisfies readonly ConnectionMethodName[];

/** Minimal logger seam (infra convention: injected pino; optional so the module stays dependency-light). */
type FailoverLog = Pick<Logger, 'warn'>;

/** Loosely-typed view of a Connection method for the generic wrapper (`unknown`-based — no `any`). */
type AnyConnectionMethod = (...args: unknown[]) => Promise<unknown>;

/**
 * Install an OWN-PROPERTY override for `name` on `primary`: try the primary implementation, and on a throw serve
 * the SAME call from `fallback` (FALLBACK_ATTEMPTS shots, then the fallback's error propagates). Only whitelisted
 * names get this wrapper — every other method keeps the plain prototype lookup, i.e. primary-only.
 * The primary implementation is resolved from the prototype AT CALL TIME so behavior (and tests spying on
 * `Connection.prototype`) always see the live method.
 */
function installFailover(
  primary: Connection,
  fallback: Connection,
  name: ConnectionMethodName,
  log: FailoverLog | undefined,
): void {
  const wrapped = async function (this: Connection, ...args: unknown[]): Promise<unknown> {
    // Cast rationale: the wrapper is name-generic, so per-method parameter tuples can't be carried through a
    // runtime loop; `unknown[]`-in/`Promise<unknown>`-out is the sound erased shape (callers keep the REAL
    // per-method types via the untouched `Connection` public surface).
    const primaryImpl = Connection.prototype[name] as AnyConnectionMethod;
    try {
      return await primaryImpl.apply(this, args);
    } catch (primaryErr) {
      log?.warn(
        {
          method: name,
          err: primaryErr instanceof Error ? primaryErr.message : String(primaryErr),
        },
        'primary RPC read failed — serving from the fallback endpoint (primary is degraded)',
      );
      const fallbackImpl = fallback[name] as AnyConnectionMethod;
      let lastErr: unknown = primaryErr;
      for (let attempt = 0; attempt < FALLBACK_ATTEMPTS; attempt++) {
        try {
          return await fallbackImpl.apply(fallback, args);
        } catch (fallbackErr) {
          lastErr = fallbackErr;
        }
      }
      throw lastErr;
    }
  };
  Object.defineProperty(primary, name, { value: wrapped, writable: true, configurable: true });
}

/** A primary `Connection` holding an internal fallback `Connection`; only whitelisted reads ever touch it. */
class FailoverConnection extends Connection {
  constructor(
    primaryUrl: string,
    fallbackUrl: string,
    methods: readonly ConnectionMethodName[],
    log: FailoverLog | undefined,
  ) {
    super(primaryUrl, RPC_COMMITMENT);
    // Same commitment as the primary: a failover read must answer the SAME question the primary was asked.
    const fallback = new Connection(fallbackUrl, RPC_COMMITMENT);
    for (const name of methods) installFailover(this, fallback, name, log);
  }
}

/**
 * Build the process RPC connection. No fallback URL configured ⇒ a bare `new Connection(url, 'confirmed')` —
 * byte-for-byte today's single-endpoint behavior (no hidden wrapper). With a fallback URL, whitelisted reads
 * failover once to the secondary; non-whitelisted methods (submit, confirm verdicts) stay primary-only.
 */
export function createFailoverConnection(
  primaryUrl: string,
  fallbackUrl: string | undefined,
  methods: readonly ConnectionMethodName[],
  log?: FailoverLog,
): Connection {
  if (!fallbackUrl) return new Connection(primaryUrl, RPC_COMMITMENT);
  return new FailoverConnection(primaryUrl, fallbackUrl, methods, log);
}
