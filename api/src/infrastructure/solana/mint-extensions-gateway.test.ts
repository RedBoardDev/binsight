import {
  ACCOUNT_SIZE,
  ACCOUNT_TYPE_SIZE,
  AccountType,
  ExtensionType,
  MINT_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TRANSFER_FEE_CONFIG_SIZE,
} from '@solana/spl-token';
import { type AccountInfo, type Connection, PublicKey } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { MintExtensionsGateway } from './mint-extensions-gateway';

const MINT = 'So11111111111111111111111111111111111111112'; // any valid base58 address (getAccountInfo is faked)
const TLV_HEADER_SIZE = 4; // Token-2022 TLV entry header = u16 extension type + u16 length

/** A Token-2022 mint account buffer carrying exactly one TransferFeeConfig extension (the TLV data is zeroed). */
function token2022MintWithTransferFee(): Buffer {
  const buf = Buffer.alloc(
    ACCOUNT_SIZE + ACCOUNT_TYPE_SIZE + TLV_HEADER_SIZE + TRANSFER_FEE_CONFIG_SIZE,
  );
  buf[ACCOUNT_SIZE] = AccountType.Mint; // marks the padded account as a Mint so unpackMint reads the TLV region
  buf.writeUInt16LE(ExtensionType.TransferFeeConfig, ACCOUNT_SIZE + ACCOUNT_TYPE_SIZE);
  buf.writeUInt16LE(TRANSFER_FEE_CONFIG_SIZE, ACCOUNT_SIZE + ACCOUNT_TYPE_SIZE + 2);
  return buf;
}

const acct = (owner: PublicKey, data: Buffer): AccountInfo<Buffer> => ({
  owner,
  data,
  executable: false,
  lamports: 1,
  rentEpoch: 0,
});

/** Fake Connection whose getAccountInfo returns `info` (or throws it when it is an Error). */
const conn = (info: AccountInfo<Buffer> | null | Error) => {
  const getAccountInfo = vi.fn(async () => {
    if (info instanceof Error) throw info;
    return info;
  });
  return { getAccountInfo } as unknown as Connection & { getAccountInfo: typeof getAccountInfo };
};

describe('MintExtensionsGateway — Token-2022 TransferFeeConfig presence (finding #105, fail-closed on unreadable)', () => {
  it('classic-SPL owner → false (confirmed non-Token-2022 mint cannot carry the extension; NOT an error)', async () => {
    // WHY: this is the common case — most mints are classic SPL. It MUST resolve false (→ open allowed), not
    // fail-closed, or the enabled filter would block every normal token. An owner-mismatch is confirmation, not a fault.
    const onError = vi.fn();
    expect(
      await new MintExtensionsGateway(conn(acct(TOKEN_PROGRAM_ID, Buffer.alloc(MINT_SIZE))), {
        onError,
      }).hasTransferFee(MINT),
    ).toBe(false);
    expect(onError).not.toHaveBeenCalled();
  });

  it('Token-2022 mint with no extensions → false', async () => {
    const onError = vi.fn();
    expect(
      await new MintExtensionsGateway(conn(acct(TOKEN_2022_PROGRAM_ID, Buffer.alloc(MINT_SIZE))), {
        onError,
      }).hasTransferFee(MINT),
    ).toBe(false);
    expect(onError).not.toHaveBeenCalled();
  });

  it("Token-2022 mint carrying a TransferFeeConfig → true (the fee'd mint we must not open)", async () => {
    expect(
      await new MintExtensionsGateway(
        conn(acct(TOKEN_2022_PROGRAM_ID, token2022MintWithTransferFee())),
      ).hasTransferFee(MINT),
    ).toBe(true);
  });

  it('account not found (null) → null + onError (unreadable ⇒ fail closed)', async () => {
    // WHY: a nonexistent/not-yet-visible mint is UNKNOWN, not fee-free — resolving false could let a fee slip through.
    const onError = vi.fn();
    expect(
      await new MintExtensionsGateway(conn(null), { onError }).hasTransferFee(MINT),
    ).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), MINT);
  });

  it('RPC/network error → null + onError (unreadable ⇒ fail closed, never throws on the open path)', async () => {
    const onError = vi.fn();
    expect(
      await new MintExtensionsGateway(conn(new Error('ECONNRESET')), { onError }).hasTransferFee(
        MINT,
      ),
    ).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), MINT);
  });

  it('malformed mint address → null + onError, without ever touching the RPC', async () => {
    const onError = vi.fn();
    const c = conn(acct(TOKEN_2022_PROGRAM_ID, Buffer.alloc(MINT_SIZE)));
    expect(
      await new MintExtensionsGateway(c, { onError }).hasTransferFee('!!!not-base58!!!'),
    ).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), '!!!not-base58!!!');
    expect(c.getAccountInfo).not.toHaveBeenCalled();
  });

  it("reads at 'confirmed' by default and honors a custom commitment", async () => {
    const cDefault = conn(acct(TOKEN_2022_PROGRAM_ID, Buffer.alloc(MINT_SIZE)));
    await new MintExtensionsGateway(cDefault).hasTransferFee(MINT);
    expect(cDefault.getAccountInfo).toHaveBeenCalledWith(expect.any(PublicKey), 'confirmed');

    const cFinal = conn(acct(TOKEN_2022_PROGRAM_ID, Buffer.alloc(MINT_SIZE)));
    await new MintExtensionsGateway(cFinal, { commitment: 'finalized' }).hasTransferFee(MINT);
    expect(cFinal.getAccountInfo).toHaveBeenCalledWith(expect.any(PublicKey), 'finalized');
  });
});
