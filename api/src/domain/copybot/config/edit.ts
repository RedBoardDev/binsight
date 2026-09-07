/**
 * Copy-bot · runtime config — PURE edit operations for the management CLI/API (no I/O, no validation side-effects).
 *
 * Dotted-path get/set over the config tree (`user.sizing.tradeRatioPct`, `leaders.0.overrides.priorityFee.tier`),
 * leader add/remove, and CLI value coercion. All operations are immutable (return a new config); the caller
 * validates the result against `CopybotConfigSchema` before persisting (so unknown keys / bad types are rejected).
 */
import type { CopybotConfig, LeaderSettings } from './types';

/** Read the value at a dotted path, or `undefined` if any segment is missing. Pure. */
export function getAtPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * Return a deep clone of `root` with `value` set at the dotted path. Missing intermediate OBJECTS are created;
 * descending into a non-object leaf throws (the path is invalid). Pure (never mutates `root`).
 */
export function setAtPath<T>(root: T, path: string, value: unknown): T {
  const segs = path.split('.');
  const clone = structuredClone(root) as Record<string, unknown>;
  let cur: Record<string, unknown> = clone;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i] as string;
    const next = cur[seg];
    if (next === undefined || next === null) cur[seg] = {};
    else if (typeof next !== 'object')
      throw new Error(`cannot descend into non-object at "${segs.slice(0, i + 1).join('.')}"`);
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[segs[segs.length - 1] as string] = value;
  return clone as T;
}

/** Coerce a CLI string into a typed value: JSON when parseable (number/bool/array/object), else the raw string. */
export function coerceValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // a bare token like a tier name or a pubkey
  }
}

/** Append a leader — STOPPED, no overrides, no per-leader exposure cap. A just-added leader must never start
 *  copying before the user presses Start (SPEC §4.2/§4.3); configured-but-stopped leaders are unlimited (only
 *  STARTED leaders are capped — see `validateConfigWrite`). Throws on duplicate. Pure. */
export function addLeader(config: CopybotConfig, address: string): CopybotConfig {
  if (config.leaders.some((l) => l.address === address))
    throw new Error(`leader already followed: ${address}`);
  const leader: LeaderSettings = {
    address,
    enabled: false,
    maxTotalExposureSol: null,
    overrides: {},
  };
  return { ...config, leaders: [...config.leaders, leader] };
}

/** Remove a leader by address. Throws if not followed. Pure. */
export function removeLeader(config: CopybotConfig, address: string): CopybotConfig {
  if (!config.leaders.some((l) => l.address === address))
    throw new Error(`leader not followed: ${address}`);
  return { ...config, leaders: config.leaders.filter((l) => l.address !== address) };
}
