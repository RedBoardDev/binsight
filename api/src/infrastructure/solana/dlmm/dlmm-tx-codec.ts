/**
 * Copy-bot — the production DLMM tx codec adapter (finding #59). Implements the domain's `DlmmTxCodec` port by
 * composing the EXISTING pure decoders — Wall-B Anchor Event-CPI decode (`decodeDlmmLegs`/`hasDlmmEvents`, no
 * Meteora SDK) + the log-label parser (`parseInstruction`) — so `src/domain/copybot/classify-dlmm-tx.ts`
 * decodes through an injected port and imports NO infrastructure. This owns only the wiring: the decoding is
 * byte-for-byte the same functions as before, so behavior is unchanged.
 */
import type { DlmmTxCodec } from '@/domain/copybot/classify-dlmm-tx';
import { parseInstruction } from '../helius-subscriber';
import { decodeDlmmLegs, hasDlmmEvents } from './dlmm-event-decoder';

/** The single production codec injected into `buildDetectedEvents`/`poolsOf` (see `detection.ts`). */
export const dlmmTxCodec: DlmmTxCodec = { hasDlmmEvents, decodeDlmmLegs, parseInstruction };
