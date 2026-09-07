import { Keypair, type PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import {
  bs58,
  DryRunSigner,
  DryRunSkip,
  LocalKeypairSigner,
  PrivyOutageError,
  PrivySessionSigner,
  type TransactionSigningBackend,
} from './signer';

const silentLog = pino({ level: 'silent' });
const PROGRAM = Keypair.generate().publicKey;

/** A minimal tx whose `feePayer` (+ optional co-signer) is a required signer — a stand-in for a real DLMM/close tx. */
function buildTx(feePayer: PublicKey, blockhash: string, coSigner?: PublicKey): Transaction {
  const t = new Transaction();
  t.feePayer = feePayer;
  t.recentBlockhash = blockhash;
  const keys = [{ pubkey: feePayer, isSigner: true, isWritable: true }];
  if (coSigner) keys.push({ pubkey: coSigner, isSigner: true, isWritable: true });
  t.add(new TransactionInstruction({ programId: PROGRAM, keys, data: Buffer.alloc(0) }));
  return t;
}

/**
 * A FakePrivyClient that reproduces the ONE thing Privy does off-chain: add the OWNER (feePayer) signature over the
 * ALREADY-frozen message (feePayer + blockhash fixed), PRESERVING any co-signer partial signature already present. It
 * signs the base64 tx locally with a stub owner keypair — exactly the composition devnet 4f proves on real hardware.
 */
function fakePrivy(
  owner: Keypair,
  onCall?: (authKey: string | undefined) => void,
): TransactionSigningBackend {
  return {
    signTransaction: async (_walletId, transactionBase64, authorizationKey) => {
      onCall?.(authorizationKey);
      const t = Transaction.from(Buffer.from(transactionBase64, 'base64'));
      t.partialSign(owner); // Privy adds the owner (feePayer) signature; any co-signer sig on the wire is preserved
      return t
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString('base64');
    },
  };
}

describe('LocalKeypairSigner — byte-identical to the pre-Inc.4 SYSTEM/bench path', () => {
  it('an OPEN (owner + ephemeral co-signer) reproduces `fresh.sign(copier, ephemeral)` bytes + signature EXACTLY', () => {
    // WHY: the on-chain bench signs with this path. If the abstraction changed a single byte (feePayer, order, the
    // co-signer set) the bench would break. We compare against the literal old sequence: sign(owner, ephemeral) →
    // serialize() → bs58(signature), over a tx with a FIXED feePayer + blockhash (the frozen message).
    const owner = Keypair.generate();
    const ephemeral = Keypair.generate();
    const blockhash = Keypair.generate().publicKey.toBase58();

    const ref = buildTx(owner.publicKey, blockhash, ephemeral.publicKey);
    ref.sign(owner, ephemeral); // the exact pre-Inc.4 call
    const refRaw = ref.serialize();
    const refSig = bs58(ref.signature as Buffer);

    // Same inputs through the signer (feePayer set by the caller before sign, as process-command does).
    const tx = buildTx(owner.publicKey, blockhash, ephemeral.publicKey);
    return new LocalKeypairSigner(owner).sign(tx, [ephemeral]).then(({ raw, signature }) => {
      expect(Buffer.from(raw).equals(refRaw)).toBe(true);
      expect(signature).toBe(refSig);
    });
  });

  it('a NON-open (owner only, no co-signer) reproduces `fresh.sign(copier)` bytes + signature EXACTLY', async () => {
    const owner = Keypair.generate();
    const blockhash = Keypair.generate().publicKey.toBase58();

    const ref = buildTx(owner.publicKey, blockhash);
    ref.sign(owner);
    const { raw, signature } = await new LocalKeypairSigner(owner).sign(
      buildTx(owner.publicKey, blockhash),
      [],
    );
    expect(Buffer.from(raw).equals(ref.serialize())).toBe(true);
    expect(signature).toBe(bs58(ref.signature as Buffer));
  });

  it('exposes the keypair pubkey as `publicKey` (the owner the Wall B check compares against)', () => {
    const owner = Keypair.generate();
    expect(new LocalKeypairSigner(owner).publicKey.equals(owner.publicKey)).toBe(true);
  });
});

describe('PrivySessionSigner — partial-sign COMPOSITION (owner from Privy, co-signer preserved)', () => {
  it('the output signature == the owner signature over the frozen message, and the co-signer partial sig is PRESERVED', async () => {
    // WHY (the ONE composition fact provable off-chain): the ephemeral position key signs LOCALLY, Privy adds the
    // owner signature over the SAME frozen message, and BOTH must survive into the wire bytes — else a two-sided/open
    // tx would fail on-chain for a missing signer. We assert both signatures verify AND the returned pin == the owner
    // sig computed independently.
    const owner = Keypair.generate(); // the "Privy-custodied" owner
    const ephemeral = Keypair.generate();
    const blockhash = Keypair.generate().publicKey.toBase58();
    let seenAuthKey: string | undefined | null = null;
    const signer = new PrivySessionSigner(
      fakePrivy(owner, (k) => {
        seenAuthKey = k;
      }),
      'wallet-1',
      owner.publicKey.toBase58(),
      'COFFRE_AUTH_KEY',
    );

    const { raw, signature } = await signer.sign(
      buildTx(owner.publicKey, blockhash, ephemeral.publicKey),
      [ephemeral],
    );

    const decoded = Transaction.from(raw);
    expect(decoded.verifySignatures()).toBe(true); // BOTH the owner + ephemeral sigs verify over the message
    expect(signature).toBe(bs58(decoded.signature as Buffer)); // the pin == the owner (feePayer) signature
    const ephSig = decoded.signatures.find((s) => s.publicKey.equals(ephemeral.publicKey));
    expect(ephSig?.signature).not.toBeNull(); // the co-signer partial sig is PRESERVED, not dropped

    // …and that owner signature equals an INDEPENDENT sign of the same message (ed25519 is deterministic):
    const ref = buildTx(owner.publicKey, blockhash, ephemeral.publicKey);
    ref.partialSign(ephemeral);
    ref.partialSign(owner);
    expect(signature).toBe(bs58(ref.signature as Buffer));

    expect(seenAuthKey).toBe('COFFRE_AUTH_KEY'); // the coffre authorization key was threaded to the backend
  });

  it('exposes the wallet ADDRESS as `publicKey` (the owner the Wall B check compares against)', () => {
    const owner = Keypair.generate();
    const signer = new PrivySessionSigner(fakePrivy(owner), 'w', owner.publicKey.toBase58());
    expect(signer.publicKey.equals(owner.publicKey)).toBe(true);
  });
});

describe('PrivySessionSigner — bounded backoff / outage classification (ULTRACODE #22, wave-4e classifier)', () => {
  it('a TRANSIENT 429 then success → retries and returns (the backoff absorbed the rate-limit)', async () => {
    const owner = Keypair.generate();
    const blockhash = Keypair.generate().publicKey.toBase58();
    let calls = 0;
    const backend: TransactionSigningBackend = {
      signTransaction: async (_w, b64) => {
        calls++;
        if (calls === 1) throw Object.assign(new Error('rate limited'), { status: 429 }); // transient → retried
        const t = Transaction.from(Buffer.from(b64, 'base64'));
        t.partialSign(owner);
        return t
          .serialize({ requireAllSignatures: false, verifySignatures: false })
          .toString('base64');
      },
    };
    const signer = new PrivySessionSigner(backend, 'w', owner.publicKey.toBase58());
    const { signature } = await signer.sign(buildTx(owner.publicKey, blockhash), []);
    expect(calls).toBe(2); // one 429, then success — the bounded backoff retried
    expect(signature).toBeTruthy();
  });

  it('a DETERMINISTIC 4xx (bad request/permission) is surfaced IMMEDIATELY — never retried, never an outage', async () => {
    let calls = 0;
    const backend: TransactionSigningBackend = {
      signTransaction: async () => {
        calls++;
        throw Object.assign(new Error('bad request'), { status: 400 });
      },
    };
    const signer = new PrivySessionSigner(backend, 'w', Keypair.generate().publicKey.toBase58());
    await expect(
      signer.sign(
        buildTx(Keypair.generate().publicKey, Keypair.generate().publicKey.toBase58()),
        [],
      ),
    ).rejects.toThrow('bad request');
    expect(calls).toBe(1); // NOT retried — a 4xx is a deterministic reject, not a transient outage
  });

  it('a PERSISTENT 5xx beyond the retry budget → a typed PrivyOutageError (for the wave-4e outage classifier #20)', async () => {
    let calls = 0;
    const backend: TransactionSigningBackend = {
      signTransaction: async () => {
        calls++;
        throw Object.assign(new Error('boom'), { status: 503 });
      },
    };
    const signer = new PrivySessionSigner(
      backend,
      'wallet-x',
      Keypair.generate().publicKey.toBase58(),
    );
    const err = await signer
      .sign(buildTx(Keypair.generate().publicKey, Keypair.generate().publicKey.toBase58()), [])
      .catch((e) => e);
    expect(err).toBeInstanceOf(PrivyOutageError);
    expect((err as PrivyOutageError).walletId).toBe('wallet-x');
    expect(calls).toBe(4); // MAX_SIGN_RETRIES (3) + the initial attempt
  });

  it('a HUNG sign (never resolves) TIMES OUT per attempt → never freezes the loop, rolls up to a PrivyOutageError (D3-01)', async () => {
    // WHY: signing runs on the coffre's serialized consume-loop batch barrier — a single black-holed Privy TEE call
    // would otherwise stall EVERY user's opens AND closes indefinitely (the forbidden never-miss-close freeze). Each
    // attempt is bounded by PRIVY_SIGN_TIMEOUT_MS so the loop always advances; the reconcile then re-drives the close.
    vi.useFakeTimers();
    try {
      let calls = 0;
      const backend: TransactionSigningBackend = {
        signTransaction: () => {
          calls++;
          return new Promise<string>(() => {}); // black-holed TEE call — never resolves
        },
      };
      const signer = new PrivySessionSigner(
        backend,
        'wallet-hung',
        Keypair.generate().publicKey.toBase58(),
      );
      const settled = signer
        .sign(buildTx(Keypair.generate().publicKey, Keypair.generate().publicKey.toBase58()), [])
        .catch((e) => e);
      // Drive past 4 attempts × (10s timeout) + the 250/500/1000ms backoffs. If the sign truly hung, this would never
      // settle; because each attempt times out, the promise RESOLVES to a typed outage — proof the loop is unblocked.
      await vi.advanceTimersByTimeAsync(4 * 10_000 + 250 + 500 + 1000 + 50);
      const err = await settled;
      expect(err).toBeInstanceOf(PrivyOutageError); // every attempt timed out → an outage, not a permanent freeze
      expect((err as PrivyOutageError).walletId).toBe('wallet-hung');
      expect(calls).toBe(4); // MAX_SIGN_RETRIES(3) + initial — each attempt bounded by the timeout, none hung forever
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('DryRunSigner — declines to sign so the caller finalizes a benign skipped', () => {
  it('throws DryRunSkip carrying the user publicKey (never signs, never broadcasts)', async () => {
    const pk = Keypair.generate().publicKey;
    const signer = new DryRunSigner(pk, silentLog);
    expect(signer.publicKey.equals(pk)).toBe(true); // real address → the Wall B owner check stays meaningful
    const err = await signer.sign().catch((e) => e);
    expect(err).toBeInstanceOf(DryRunSkip);
    expect((err as DryRunSkip).publicKey.equals(pk)).toBe(true);
  });
});
