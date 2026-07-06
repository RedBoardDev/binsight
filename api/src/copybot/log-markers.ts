/**
 * Cross-process log MARKERS that double as a test contract. The on-chain harness measures the bot's reaction
 * latency and gates the no-miss killer tests by matching these markers out of the brain/coffre log files. A
 * harmless reword at a producer site would silently break that measurement (latency returns null) and the gates —
 * so the markers live here as shared consts referenced by BOTH the producers and the harness. The runtime text is
 * byte-identical; only the source references are shared.
 *
 * Two flavors, both single-sourced here:
 *  - FREE-TEXT pino messages (`log.info(fields, MARKER)`): the marker IS the message; the harness `.includes()`-greps
 *    it (the latency markers + the reshape marker below).
 *  - STRUCTURED CopyEvent codes: a `CopyEvents.emit(code, …)` line logs the code + flat admin fields as pino JSON, so
 *    the harness matches the `"code":"…"` field. The code is a type-locked identifier (`CopyCode` union + CODE_REGISTRY,
 *    pinned by codes.test.ts) — it can never silently drift like prose — but it is shared here so the harness gate and
 *    the producer reference the SAME identifier.
 */
import type { CopyCode } from '@/domain/copybot/observability/codes';

/** Brain: a detected leader event was routed (start of the bot's controllable reaction latency). */
export const LOG_MARKER_EVENT_ROUTED = '👁️ event routed';

/** Coffre: the copy tx is ON THE WIRE (end of the controllable latency; on-chain confirm is separate). */
export const LOG_MARKER_SUBMITTED = '🚀 submitted';

/**
 * Brain: a reshape (proportional add/remove mirroring the leader's bin-shape change) was published to the bus. This is
 * the STABLE core of the emit message `🔧 reshape published (per-bin exact)` (user-runtime.ts) — the emoji and the
 * `(per-bin exact)` qualifier are volatile decoration, so the shared marker is the semantic substring the harness gates
 * on. The emit site (user-runtime.ts `handleResync`) builds its message from this const (#168), so the producer and the
 * harness gate share the SAME source string — a reword there can no longer silently drift the gate dead.
 */
export const LOG_MARKER_RESHAPE_PUBLISHED = 'reshape published';

/**
 * Coffre: the CopyEvent code emitted when a signed tx is CONFIRMED landed on-chain (`ConfirmWorker.resolveLanded` →
 * `CopyEvents.emit('sign.landed', { kind, pool, … })`). The admin mirror logs it as flat pino JSON, so the harness
 * gates the "our add/remove actually landed" corroboration on the structured `"code":"sign.landed"` + `"kind"` +
 * `"pool"` fields (NOT free text). Typed as `CopyCode` so a taxonomy rename breaks compilation on both sides.
 *
 * This replaces the harness's former `SIGN landed` free-text gate, which matched the REMOVED `formatJournalLine` /
 * `CopyJournalStore` stdout mirror — a producer that no longer exists, so that gate had silently gone dead.
 */
export const LOG_MARKER_SIGN_LANDED_CODE: CopyCode = 'sign.landed';
