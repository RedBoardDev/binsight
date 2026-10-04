import { findNewKeys, haveSameKeys } from '@app/applications/Shared/Motion/Domain/newKeys';
import { useState } from 'react';

interface KeySnapshot {
  readonly keys: readonly string[];
  readonly newKeys: ReadonlySet<string>;
}

const NOTHING_NEW: ReadonlySet<string> = new Set();

// The keys that arrived since the previous version of the list. The first render has no "before":
// a page that loads, or rows mounted by scrolling, must not slide in.
export const useNewKeys = (keys: readonly string[]): ReadonlySet<string> => {
  const [snapshot, setSnapshot] = useState<KeySnapshot>({ keys, newKeys: NOTHING_NEW });
  if (haveSameKeys(snapshot.keys, keys)) {
    return snapshot.newKeys;
  }
  const next = { keys, newKeys: findNewKeys(snapshot.keys, keys) };
  setSnapshot(next);
  return next.newKeys;
};
