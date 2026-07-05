/**
 * Copy-bot · Inc.1 — Redis Streams bus (I/O). UNRELIABLE transport: integrity comes from the HMAC envelope
 * (`envelope.ts`), not from Redis. The brain `publish`es on `cmd:sign`; the vault `consume`s in pull-only
 * mode (XREADGROUP, no inbound socket). The expected `hop` is passed to consume → a message from another hop
 * (different MAC) is rejected (`payload: null`) without being parsed.
 */
import Redis from 'ioredis';
import { encodeEnvelope, HMAC_HEX_LEN, verifyEnvelope } from './envelope';

export interface ConsumedMessage {
  id: string;
  /** authenticated payload; `null` if the MAC/hop does not match (→ caller DLQ + ACK) OR if this is a tombstone. */
  payload: unknown | null;
  /** the EXACT raw stream fields (`body`/`hmac`) as read — needed to dead-letter a rejected/poison message verbatim; `{}` for a tombstone (the bytes are gone). */
  raw: Record<string, string>;
  /**
   * TOMBSTONE: this PEL entry's stream bytes were TRIMMED away — an `XTRIM MAXLEN` on the command stream evicted an
   * entry still awaiting confirmation, so Redis returned null/empty fields for it. The body/hmac are GONE: the entry
   * can be neither authenticated nor dead-lettered verbatim; the ONLY safe action is for the caller to ACK it and
   * move on. Distinct from a `payload: null` REJECT (bad MAC/hop), which still carries its raw body/hmac for the DLQ.
   */
  tombstone?: boolean;
}

const fieldsToRecord = (fields: string[] | null | undefined): Record<string, string> => {
  const r: Record<string, string> = {};
  // A PEL entry whose stream bytes were TRIMMED (XTRIM MAXLEN) comes back with null fields — never deref `.length`.
  if (!Array.isArray(fields)) return r;
  for (let i = 0; i + 1 < fields.length; i += 2) r[fields[i] as string] = fields[i + 1] as string;
  return r;
};

/**
 * Hard cap on a bus envelope body (bytes). An over-cap frame is rejected in `parse` BEFORE the HMAC + JSON.parse
 * (both are O(body length)) so a crafted giant body can never DoS the consume loop. 64 KiB sits far above any real
 * message — a cmd:sign's serialized DLMM tx is bounded by Solana's 1232-byte packet (~1.6 KB base64) plus a few
 * small fields; ev:executed is smaller still — yet well below a memory/CPU-abuse frame. The fixed 64-char hmac is
 * negligible, so the body length is the whole envelope's parse/HMAC surface.
 */
export const MAX_BUS_ENVELOPE_BYTES = 65_536;

/**
 * Approximate cap on the number of entries kept per bus stream (`cmd:sign`, `ev:executed`, and their `.DLQ`s),
 * applied with `XADD ... MAXLEN ~` on every write. Bounds stream growth so a flood of frames (legitimate backlog or a
 * forged flood) cannot grow Redis memory without limit; `~` trims in whole macro-nodes (cheap, amortized). Sized far
 * above any real backlog — the coffre consumes + ACKs each cmd:sign within seconds, so thousands of unconfirmed
 * entries never accumulate in normal operation — yet small enough to bound abuse. Trimming a still-unconfirmed PEL
 * entry is safe: `parse` surfaces it as a TOMBSTONE the consumer ACK-and-skips. NOTE: this caps entry COUNT and only
 * trims on OUR writes — the real backstop against an oversized single field (a forged 512MB `hmac`/`body`) is the
 * Redis-server `proto-max-bulk-len` config, which cannot be set from application code (ops follow-up).
 */
export const MAX_BUS_STREAM_LEN = 10_000;

export class RedisBus {
  constructor(private readonly redis: Redis) {}

  static connect(url: string): RedisBus {
    return new RedisBus(new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false }));
  }

  /** Publishes a signed payload (HMAC, bound to the hop) onto a stream. Returns the message id. */
  async publish(stream: string, hop: string, key: string, payload: unknown): Promise<string> {
    const env = encodeEnvelope(hop, key, payload);
    // MAXLEN ~ bounds the stream so a flood can never grow it unboundedly (see MAX_BUS_STREAM_LEN).
    const id = await this.redis.xadd(
      stream,
      'MAXLEN',
      '~',
      MAX_BUS_STREAM_LEN,
      '*',
      'body',
      env.body,
      'hmac',
      env.hmac,
    );
    return id as string;
  }

  /** Creates the consumer-group if it does not exist (idempotent, MKSTREAM).
   *  Anchored at `'0'` (not `'$'`): the group replays from the START of the stream. Replay-safe because consumers
   *  dedup (coffre = executions table INSERT-before-sign; brain = idempotent ev:executed handlers), and `'0'` is the
   *  no-miss anchor — it catches messages published BEFORE the group existed (startup race) AND everything after a
   *  Redis flush/eviction when a group is later re-created; `'$'` would silently drop both. Keep the BUSYGROUP swallow.
   *  A group re-creation replays the whole backlog, so the streams (`cmd:sign`, `ev:executed`) are bounded on every
   *  write via `XADD ... MAXLEN ~` (see MAX_BUS_STREAM_LEN, applied in `publish`/`deadLetter`). OPS FOLLOW-UP (cannot
   *  be set from application code): cap the per-field size with the Redis-server `proto-max-bulk-len` config so a
   *  single forged `hmac`/`body` field cannot be allocated at read time — the length guard in `parse` only stops the
   *  decode-side amplification, not ioredis reading the oversized field off the socket. */
  async ensureGroup(stream: string, group: string): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', stream, group, '0', 'MKSTREAM');
    } catch (err) {
      if (!(err as Error).message.includes('BUSYGROUP')) throw err;
    }
  }

  /** Runs an XREADGROUP read; if the group has vanished (Redis flush/eviction dropped it → the read throws NOGROUP),
   *  re-create the group and retry the read ONCE. Without this self-heal the consumer's outer loop just backs off
   *  forever on the NOGROUP throw and stays wedged (it never re-creates the group). Replay-safe: see `ensureGroup`. */
  private async readWithGroupHeal(
    stream: string,
    group: string,
    read: () => Promise<unknown>,
  ): Promise<Array<[string, Array<[string, string[] | null]>]> | null> {
    try {
      return (await read()) as Array<[string, Array<[string, string[] | null]>]> | null;
    } catch (err) {
      if (!(err as Error).message.includes('NOGROUP')) throw err;
      await this.ensureGroup(stream, group);
      return (await read()) as Array<[string, Array<[string, string[] | null]>]> | null;
    }
  }

  /** Reads (pulls) a batch via XREADGROUP, verifies each envelope against the expected hop, returns the
   *  messages (authenticated payload or null). Blocks up to `blockMs` if there is nothing to read. */
  async consume(
    stream: string,
    group: string,
    consumer: string,
    hop: string,
    key: string,
    count = 10,
    blockMs = 5000,
  ): Promise<ConsumedMessage[]> {
    const res = await this.readWithGroupHeal(stream, group, () =>
      this.redis.xreadgroup(
        'GROUP',
        group,
        consumer,
        'COUNT',
        count,
        'BLOCK',
        blockMs,
        'STREAMS',
        stream,
        '>',
      ),
    );
    return this.parse(res, hop, key);
  }

  /** Re-read THIS consumer's PENDING (delivered-but-unACKed) messages — XREADGROUP with id '0' returns the
   *  consumer's PEL (no BLOCK). A crashed prior instance read these but never ACKed; on boot the vault re-processes
   *  them (exactly-once via the executions table) so an in-flight cmd:sign is NEVER stranded by a crash. */
  async consumePending(
    stream: string,
    group: string,
    consumer: string,
    hop: string,
    key: string,
    count = 100,
  ): Promise<ConsumedMessage[]> {
    const res = await this.readWithGroupHeal(stream, group, () =>
      this.redis.xreadgroup('GROUP', group, consumer, 'COUNT', count, 'STREAMS', stream, '0'),
    );
    return this.parse(res, hop, key);
  }

  private parse(
    res: Array<[string, Array<[string, string[] | null]>]> | null,
    hop: string,
    key: string,
  ): ConsumedMessage[] {
    if (!res || res.length === 0) return [];
    const entries = res[0]?.[1] ?? [];
    return entries.map(([id, fields]) => {
      // TOMBSTONE: an XTRIM MAXLEN on the command stream can evict a PEL entry still awaiting confirmation; Redis then
      // returns null (or empty) fields for it. The body/hmac are GONE — it can be neither authenticated nor
      // dead-lettered verbatim — so surface a tombstone (`payload: null`, empty `raw`, `tombstone: true`) for the
      // caller to ACK-and-skip. Without this the map would deref `null.length` and throw, wedging the consume loop.
      if (!Array.isArray(fields) || fields.length === 0)
        return { id, payload: null, raw: {}, tombstone: true };
      const f = fieldsToRecord(fields);
      // #24 — reject an OVERSIZED envelope BEFORE the HMAC + JSON.parse (both O(body length)): a crafted giant body
      // would otherwise let ONE frame burn CPU / allocate unbounded and stall this consume loop. Over the cap → a
      // REJECT (payload null, raw KEPT) exactly like a bad MAC, so the caller dead-letters it verbatim (loud, not a
      // silent drop) — the "size" half of the coffre's documented bus checks 1-4. NOT a tombstone: the bytes exist.
      if (f.body !== undefined && Buffer.byteLength(f.body, 'utf8') > MAX_BUS_ENVELOPE_BYTES)
        return { id, payload: null, raw: f };
      // #166 — reject a MALFORMED-length `hmac` BEFORE verifyEnvelope's `Buffer.from(hmac,'hex')` (an allocation the
      // size of the field). Threat model (bus-key-guard): anyone who can reach Redis can XADD a forged frame. A small
      // (<cap) body passes the check above, but the `hmac` field can be up to Redis's 512MB proto-max-bulk-len; decoded
      // per message across a COUNT-sized batch (10 live / 100 boot PEL drain) and retained via `raw` until the batch
      // finishes → tens of GB → the SOLE coffre OOMs and no leader close is signed. A genuine MAC is exactly
      // HMAC_HEX_LEN hex chars; any other length is forged → REJECT (payload null, raw KEPT → caller dead-letters it,
      // loud not silent), exactly like an over-cap body. NOT a tombstone: the bytes exist.
      if (f.hmac !== undefined && f.hmac.length !== HMAC_HEX_LEN)
        return { id, payload: null, raw: f };
      const payload =
        f.body !== undefined && f.hmac !== undefined
          ? verifyEnvelope(hop, key, { body: f.body, hmac: f.hmac })
          : null;
      return { id, payload, raw: f };
    });
  }

  async ack(stream: string, group: string, id: string): Promise<void> {
    await this.redis.xack(stream, group, id);
  }

  /** DLQ: copies the raw message onto the `<stream>.DLQ` stream then ACKs the original. */
  async deadLetter(
    stream: string,
    group: string,
    id: string,
    raw: Record<string, string>,
  ): Promise<void> {
    const flat = Object.entries(raw).flat();
    // MAXLEN ~ bounds the DLQ too: a flood of rejected/forged frames each gets dead-lettered, so the DLQ must be
    // capped like the primary streams or an attacker could grow it unboundedly (see MAX_BUS_STREAM_LEN).
    await this.redis.xadd(`${stream}.DLQ`, 'MAXLEN', '~', MAX_BUS_STREAM_LEN, '*', ...flat);
    await this.redis.xack(stream, group, id);
  }

  // ── Singleton lease (ops mutual-exclusion, NOT a signing primitive) ─────────────────────────────────────────
  // A boot guard so only ONE coffre instance ever owns the shared consumer/PEL. A 2nd instance booting with the same
  // consumer would re-claim/re-sign in-flight `cmd:sign` from the PEL and DOUBLE-execute — the lease makes it refuse.

  /** `SET key=instanceId NX PX ttlMs`. Returns true iff THIS instance acquired the lease (no live holder). */
  async acquireLease(key: string, instanceId: string, ttlMs: number): Promise<boolean> {
    const res = await this.redis.set(key, instanceId, 'PX', ttlMs, 'NX');
    return res === 'OK';
  }

  /**
   * Renew OUR lease (compare-and-set: extend the TTL only if the stored value is still our instanceId — NEVER steal a
   * lease that expired and was re-acquired by another instance). Returns true iff the TTL was extended. Runs on a
   * ttl/2 timer; a false return means we lost exclusivity and the caller must stop (split-brain guard).
   */
  async renewLease(key: string, instanceId: string, ttlMs: number): Promise<boolean> {
    const res = (await this.redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
      1,
      key,
      instanceId,
      String(ttlMs),
    )) as number;
    return res === 1;
  }

  /** Release OUR lease on graceful shutdown (compare-and-set delete: never delete another instance's lease). */
  async releaseLease(key: string, instanceId: string): Promise<void> {
    await this.redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      key,
      instanceId,
    );
  }

  async del(...streams: string[]): Promise<void> {
    if (streams.length > 0) await this.redis.del(...streams);
  }

  async quit(): Promise<void> {
    await this.redis.quit();
  }
}
