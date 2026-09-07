import { describe, expect, it } from 'vitest';
import { isAllowedPushEndpoint } from './push-endpoint';

describe('isAllowedPushEndpoint — blind-SSRF guard on the Web Push endpoint (ULTRACODE #108)', () => {
  it('allows each known push-service vendor host (real subscription endpoints)', () => {
    // WHY: a legitimate PushManager.subscribe endpoint always lives on a vendor host — the guard must never
    // reject a real subscription (that would silently disable notifications for that browser).
    const allowed = [
      'https://fcm.googleapis.com/fcm/send/abc123', // Chrome / FCM
      'https://android.googleapis.com/gcm/send/xyz', // legacy GCM
      'https://updates.push.services.mozilla.com/wpush/v2/token', // Firefox
      'https://web.push.apple.com/QABC...', // Safari / Apple Push for Web
      'https://p01-content.icloud.com/pushkit', // Apple iCloud
      'https://sea1.notify.windows.com/w/?token=xyz', // Edge / WNS
      'https://db5.wns.windows.com/w/?token=xyz', // WNS
    ];
    for (const url of allowed) expect(isAllowedPushEndpoint(url)).toBe(true);
  });

  it('rejects a foreign / internal / metadata host (the SSRF target)', () => {
    // WHY: the server later POSTs to this endpoint (delivery + /push/test) — an attacker-chosen internal host
    // would turn the subscription into an on-demand SSRF probe of our network.
    const rejected = [
      'https://attacker.example.com/steal', // arbitrary external host
      'https://169.254.169.254/latest/meta-data/', // cloud metadata service
      'https://127.0.0.1/internal', // loopback
      'https://internal.corp.local/admin', // internal DNS
    ];
    for (const url of rejected) expect(isAllowedPushEndpoint(url)).toBe(false);
  });

  it('rejects a look-alike host that only SUFFIX-collides at a non-label boundary', () => {
    // WHY: a naive `includes`/`endsWith` without a `.`-boundary check would accept these forgeries.
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com.attacker.com/send')).toBe(false);
    expect(isAllowedPushEndpoint('https://evilfcm.googleapis.com.co/send')).toBe(false);
    expect(isAllowedPushEndpoint('https://notfcm.googleapis.com/send')).toBe(false);
  });

  it('rejects a non-HTTPS scheme (push delivery is HTTPS-only)', () => {
    expect(isAllowedPushEndpoint('http://fcm.googleapis.com/fcm/send/abc')).toBe(false);
    expect(isAllowedPushEndpoint('ftp://fcm.googleapis.com/x')).toBe(false);
  });

  it('rejects a malformed / non-absolute URL without throwing (total predicate)', () => {
    expect(isAllowedPushEndpoint('not a url')).toBe(false);
    expect(isAllowedPushEndpoint('')).toBe(false);
    expect(isAllowedPushEndpoint('/relative/path')).toBe(false);
    expect(isAllowedPushEndpoint('https://')).toBe(false);
  });
});
