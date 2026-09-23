'use client';

import {
  activeRegistration,
  dropPushSubscription,
  fetchVapidKey,
  sendTestPush,
  subscribeToPush,
} from '@app/applications/Settings/Api/usePush.api';
import { SectionLabel } from '@app/applications/Shared/Ui/SectionLabel';
import { Button, Switch } from '@heroui/react';
import { useEffect, useState } from 'react';

/** VAPID base64url public key → the Uint8Array PushManager.subscribe expects. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

type PushState =
  | 'loading'
  | 'unsupported'
  | 'unavailable'
  | 'denied'
  | 'idle'
  | 'subscribed'
  | 'busy';

const NOTE: Partial<Record<PushState, string>> = {
  loading: 'Checking…',
  unsupported: 'Push notifications are not supported in this browser.',
  unavailable: 'Push notifications are unavailable here (needs the installed/production app).',
  denied: 'Notifications are blocked — enable them for this site in your browser settings.',
};

export const PushNotificationsSection = () => {
  const [state, setState] = useState<PushState>('loading');

  useEffect(() => {
    let alive = true;
    void (async () => {
      const supported =
        typeof window !== 'undefined' &&
        'serviceWorker' in navigator &&
        'PushManager' in window &&
        'Notification' in window;
      if (!supported) return void (alive && setState('unsupported'));
      const { key } = await fetchVapidKey().catch(() => ({ key: '' }));
      if (!key) return void (alive && setState('unavailable')); // server has no VAPID keys
      if (Notification.permission === 'denied') return void (alive && setState('denied'));
      const registration = await activeRegistration();
      if (!registration) return void (alive && setState('unavailable')); // no SW (e.g. dev build)
      const subscription = await registration.pushManager.getSubscription();
      if (alive) setState(subscription ? 'subscribed' : 'idle');
    })();
    return () => {
      alive = false;
    };
  }, []);

  const enable = async () => {
    setState('busy');
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return setState(permission === 'denied' ? 'denied' : 'idle');
      const { key } = await fetchVapidKey();
      const registration = await activeRegistration();
      if (!key || !registration) return setState('unavailable');
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        // cast: the new TS lib types Uint8Array<ArrayBufferLike> doesn't unify with BufferSource.
        applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
      });
      const ok = await subscribeToPush(JSON.parse(JSON.stringify(subscription)));
      setState(ok ? 'subscribed' : 'idle');
    } catch {
      setState('idle');
    }
  };

  const disable = async () => {
    setState('busy');
    try {
      // SW not ready / no local subscription handle → we can't tell the server which endpoint to
      // drop, so the backend may still be delivering. DON'T claim disabled — keep 'subscribed' so a
      // retry is possible (showing 'idle' here lied while pushes kept arriving).
      setState((await dropPushSubscription()) ? 'idle' : 'subscribed');
    } catch {
      // unsubscribe failed — keep the truthful 'subscribed', not a false 'idle'.
      setState('subscribed');
    }
  };

  const note = NOTE[state];
  const toggleable = state === 'idle' || state === 'busy' || state === 'subscribed';

  return (
    <section className="flex flex-col gap-3">
      <SectionLabel>Notifications</SectionLabel>
      {note && <p className="text-faint text-xs leading-relaxed">{note}</p>}
      {toggleable && (
        <>
          <Switch.Root
            isDisabled={state === 'busy'}
            isSelected={state === 'subscribed'}
            onChange={(selected) => void (selected ? enable() : disable())}
          >
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              <span>{state === 'busy' ? 'Working…' : 'Push alerts'}</span>
            </Switch.Content>
          </Switch.Root>
          <p className="text-faint text-xs leading-relaxed">
            Get alerted on out-of-range, big PnL moves and closes — even when the app is closed.
          </p>
          {state === 'subscribed' && (
            <Button
              className="self-start"
              onPress={() => void sendTestPush()}
              size="sm"
              variant="secondary"
            >
              Send test
            </Button>
          )}
        </>
      )}
    </section>
  );
};
