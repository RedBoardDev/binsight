'use client';

import { COPIED_RESET_MS } from '@app/applications/Shared/Domain/timings';
import { useEffect, useRef, useState } from 'react';

/** Copy to the clipboard and flash a brief confirmation. Blocked-permission failures are swallowed. */
export function useCopy() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    } catch {
      /* clipboard blocked */
    }
  };

  return { copied, copy };
}
