import { create } from 'zustand';
import { type AccountIdentity, authApi } from '@/infrastructure/api/client';

type IdentityState = {
  identity: AccountIdentity | null;
  loaded: boolean;
  /** Fetch the caller's identity once (address + owner flag). Idempotent. */
  load: () => Promise<void>;
  /** Drop the cached identity on sign-out so the next login never sees the previous account. */
  reset: () => void;
};

/** The signed-in account's identity — drives the owner-only Admin entry and any future identity UI. */
export const useIdentity = create<IdentityState>((set, get) => ({
  identity: null,
  loaded: false,
  load: async () => {
    if (get().loaded) return;
    try {
      const me = await authApi.me();
      set({
        identity: me.registered ? { address: me.address, isOwner: me.isOwner } : null,
        loaded: true,
      });
    } catch {
      set({ identity: null, loaded: true });
    }
  },
  reset: () => set({ identity: null, loaded: false }),
}));
