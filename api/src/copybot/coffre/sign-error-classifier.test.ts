import { PermissionDeniedError } from '@privy-io/node';
import { describe, expect, it } from 'vitest';
import { PrivyOutageError } from '@/copybot/coffre/signer';
import {
  classifySignError,
  isRevokedDelegationError,
  type SignErrorClass,
} from './sign-error-classifier';

/** A minimal API-error double (duck-typed `.status`) — exercises the classification without a real SDK error. */
const withStatus = (status: number): { status: number; message: string } => ({
  status,
  message: `http ${status}`,
});

describe('classifySignError — the per-user sign-failure branch selector (SPEC §2.4, #20/#21)', () => {
  it("a PrivyOutageError (bounded retries exhausted) → 'outage'", () => {
    const err = new PrivyOutageError('wallet-1', 4, new Error('503'));
    expect(classifySignError(err)).toBe<SignErrorClass>('outage');
  });

  it("a permission-denied (403) Privy error → 'revoked' (the session signer is no longer authorized)", () => {
    expect(classifySignError(withStatus(403))).toBe<SignErrorClass>('revoked');
  });

  it("an authentication (401) error → 'revoked'", () => {
    expect(classifySignError(withStatus(401))).toBe<SignErrorClass>('revoked');
  });

  it("a revoked-signer MESSAGE (devnet placeholder) → 'revoked' even without a status", () => {
    expect(classifySignError(new Error('session signer not authorized for wallet'))).toBe(
      'revoked',
    );
    expect(classifySignError(new Error('delegation was revoked by the user'))).toBe('revoked');
  });

  it("a generic land error → 'other' (falls through to the existing bounded retry)", () => {
    expect(classifySignError(new Error('blockhash not found'))).toBe<SignErrorClass>('other');
    expect(classifySignError(withStatus(500))).toBe<SignErrorClass>('other');
    expect(classifySignError(null)).toBe<SignErrorClass>('other');
  });

  it("outage is classified BEFORE revoked — a PrivyOutageError never reads as 'revoked'", () => {
    // A PrivyOutageError carries no revoked status/message, but assert the ordering contract explicitly.
    expect(classifySignError(new PrivyOutageError('w', 4, withStatus(403)))).toBe('outage');
  });
});

describe('isRevokedDelegationError — documented placeholder + broad 401/403 fallback (devnet-4f finalizes)', () => {
  it('recognises the typed Privy PermissionDeniedError class', () => {
    const err = new PermissionDeniedError(403, { error: 'forbidden' }, 'forbidden', new Headers());
    expect(isRevokedDelegationError(err)).toBe(true);
  });

  it('does NOT flag a plain 5xx / transient error as revoked', () => {
    expect(isRevokedDelegationError(withStatus(503))).toBe(false);
    expect(isRevokedDelegationError(new Error('timeout'))).toBe(false);
  });
});
