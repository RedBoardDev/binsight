import { describe, expect, it } from 'vitest';
import { isPushEndpoint } from './push-routes';

// The server POSTs web-push payloads to whatever endpoint a subscription names, so an unchecked one
// turns /push/subscribe into an SSRF primitive aimed at the host's own network.
describe('isPushEndpoint — push subscription endpoint allowlist (SSRF guard)', () => {
  it('accepts real browser push service URLs', () => {
    expect(isPushEndpoint('https://fcm.googleapis.com/fcm/send/abc:def')).toBe(true);
    expect(isPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/gAAAA')).toBe(true);
    expect(isPushEndpoint('https://web.push.apple.com/QGx7abc')).toBe(true);
  });

  it('refuses plain http', () => {
    expect(isPushEndpoint('http://fcm.googleapis.com/fcm/send/abc')).toBe(false);
  });

  it('refuses localhost and internal host names', () => {
    expect(isPushEndpoint('https://localhost/x')).toBe(false);
    expect(isPushEndpoint('https://printer.local/x')).toBe(false);
    expect(isPushEndpoint('https://metadata.google.internal/x')).toBe(false);
    expect(isPushEndpoint('https://intranet/x')).toBe(false); // single-label: never a public host
  });

  it('refuses IP literals (v4 and v6)', () => {
    expect(isPushEndpoint('https://127.0.0.1/x')).toBe(false);
    expect(isPushEndpoint('https://169.254.169.254/latest/meta-data')).toBe(false); // cloud metadata
    expect(isPushEndpoint('https://10.0.0.5/x')).toBe(false);
    expect(isPushEndpoint('https://[::1]/x')).toBe(false);
    // Integer / hex spellings are normalised to a dotted quad by the URL parser, so they are caught too.
    expect(isPushEndpoint('https://2130706433/x')).toBe(false);
    expect(isPushEndpoint('https://0x7f.0.0.1/x')).toBe(false);
  });

  it('refuses a custom port (push services listen on 443; a port targets some other service)', () => {
    expect(isPushEndpoint('https://fcm.googleapis.com:8443/fcm/send/abc')).toBe(false);
    expect(isPushEndpoint('https://push.example.com:6379/x')).toBe(false);
  });

  it('refuses garbage and oversized endpoints', () => {
    expect(isPushEndpoint('not a url')).toBe(false);
    expect(isPushEndpoint(`https://fcm.googleapis.com/${'a'.repeat(2100)}`)).toBe(false);
  });
});
