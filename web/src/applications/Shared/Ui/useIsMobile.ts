'use client';

import { useMediaQuery } from '@heroui/react';
import { useEffect, useState } from 'react';

/** The single mobile/desktop divide for the whole app: below Tailwind's `md` (768px) is mobile. */
const MOBILE_QUERY = '(max-width: 767px)';

export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY, { defaultValue: false, initializeWithValue: false });
}

/** False on the server and the first client render, true thereafter — avoids a hydration flash
 *  between the server's desktop assumption and the resolved viewport. */
export function useIsMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}
