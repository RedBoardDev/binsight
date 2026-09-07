/**
 * Copy-bot · Inc.1 — bus HMAC envelope (PURE, node:crypto). The bus (Redis) is an UNTRUSTED transport:
 * integrity comes ONLY from the HMAC over the EXACT body bytes, never from Redis. The `hop` is bound into
 * the MAC (domain separation) → an envelope from one hop cannot be replayed on another. We verify the MAC
 * BEFORE `JSON.parse` (never parse an unauthenticated payload).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface Envelope {
  /** the serialized JSON payload — the EXACT bytes the MAC covers. */
  body: string;
  /** hex HMAC-SHA256 of `${hop}\n${body}` with the hop key. */
  hmac: string;
}

const mac = (hop: string, key: string, body: string): string =>
  createHmac('sha256', key).update(`${hop}\n${body}`).digest('hex');

/**
 * Exact character length of a well-formed `hmac` field: a sha256 MAC is 32 bytes → 64 lowercase hex chars once
 * `.digest('hex')`-encoded. The bus consumer (`RedisBus.parse`) rejects any `hmac` of a different length BEFORE
 * decoding it with `Buffer.from(hmac,'hex')`, so a forged frame carrying an oversized `hmac` can never force a giant
 * allocation on the vault's consume path (DoS guard, finding #166). Co-located with `mac`: if the MAC algorithm ever
 * changes, this length must change with it.
 */
export const HMAC_HEX_LEN = 64;

/** Serialize + sign a payload for a given hop. */
export function encodeEnvelope(hop: string, key: string, payload: unknown): Envelope {
  const body = JSON.stringify(payload);
  return { body, hmac: mac(hop, key, body) };
}

/**
 * Verify the MAC (exact bytes + hop) in constant time, then parse. Returns the parsed object, or `null` if the
 * MAC does not match (tampering, wrong hop, wrong key) — in that case we DO NOT parse.
 */
export function verifyEnvelope(hop: string, key: string, env: Envelope): unknown | null {
  const expected = mac(hop, key, env.body);
  const got = Buffer.from(env.hmac, 'hex');
  const exp = Buffer.from(expected, 'hex');
  if (got.length !== exp.length || !timingSafeEqual(got, exp)) return null;
  // D2-02: the body is authenticated, but a producer bug (or a compromised hop key) could still hand us a MALFORMED
  // JSON body. Parse defensively so a poison frame is REJECTED like a bad MAC (→ the caller DLQs + ACKs it) instead of
  // THROWING out of `RedisBus.parse` and wedging the whole consume loop mid-batch (the heartbeat would stay green while
  // nothing is consumed). A bad-JSON reject and a bad-MAC reject are indistinguishable to the caller — both are poison.
  try {
    return JSON.parse(env.body);
  } catch {
    return null;
  }
}
