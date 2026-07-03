/**
 * Copy-bot · 3c — per-user SIGNING LANES (pure concurrency plumbing, no I/O). The vault's consume loop dispatches
 * each cmd:sign into the lane keyed by the request's SIGNED `userId`:
 *  - WITHIN a user: strict FIFO (`KeyedSerializer`) — one user's commands sign in bus order, so per-position
 *    ordering (open before close) is preserved (positions are per-user);
 *  - ACROSS users: concurrent, bounded by `MAX_CONCURRENT_SIGNING_LANES` (`Semaphore`) — one slow user's sign/
 *    broadcast can never head-of-line-block another user's CLOSE (ULTRACODE #22/#31).
 * A lane task ends at the BROADCAST (confirmation is the async worker's) so a lane is held only for the fast
 * verify→sign→land section.
 */
import { KeyedSerializer, Semaphore } from '@/util/concurrency';

// Cross-user signing fan-out ceiling. All lanes share ONE RPC key today, so a small bound keeps the burst RPC
// pressure (getSlot + broadcast per command) predictable; each lane is serial, so this = "users signing at once".
// Revisit when custody lands (per-user keys/endpoints).
export const MAX_CONCURRENT_SIGNING_LANES = 4;

// Lane for messages whose payload carries no usable userId (failed HMAC → null payload, or a malformed body).
// They are rejected by process1's early checks without any chain I/O, so sharing one lane cannot stall a user.
// The NUL prefix cannot collide with a real userId (identifiers never contain NUL).
export const INVALID_PAYLOAD_LANE = '\u0000invalid-payload';

/** PURE: the lane key of a consumed cmd:sign — the request's `userId`, or the invalid-payload lane. */
export function laneKeyOf(payload: unknown): string {
  const userId = (payload as { userId?: unknown } | null)?.userId;
  return typeof userId === 'string' && userId.length > 0 ? userId : INVALID_PAYLOAD_LANE;
}

/** Per-key FIFO lanes with a global concurrency ceiling (see module doc). */
export class SigningLanes {
  private readonly serializer = new KeyedSerializer();
  private readonly cap: Semaphore;

  constructor(maxConcurrent = MAX_CONCURRENT_SIGNING_LANES) {
    this.cap = new Semaphore(maxConcurrent);
  }

  /**
   * Run `task` on `key`'s lane: after every earlier task of the SAME key (FIFO), concurrently with other keys,
   * never more than the global cap at once. Returns the task's own promise (a rejection isolates to its caller
   * and never wedges the lane — `KeyedSerializer` guarantees the next task still runs).
   */
  dispatch<T>(key: string, task: () => Promise<T>): Promise<T> {
    return this.serializer.run(key, () => this.cap.run(task));
  }
}
