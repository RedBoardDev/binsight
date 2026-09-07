/**
 * Web Push endpoint allowlist (PURE, no I/O). A subscription's `endpoint` is a URL the server later POSTs to
 * (web-push delivery), so an unvalidated endpoint is a blind-SSRF vector (ULTRACODE #108): web-push forces HTTPS
 * + rejectUnauthorized, but a valid-cert INTERNAL host is still probeable on-demand via /push/test. We therefore
 * pin the endpoint host to the KNOWN push-service vendors before storing it.
 */

/** Canonical Web Push endpoint host SUFFIXES per vendor. A host is allowed iff it equals, or ends with `.` + one
 *  of these (suffix match on a DNS label boundary → `evil-fcm.googleapis.com.attacker.com` is rejected). */
const ALLOWED_PUSH_HOST_SUFFIXES: readonly string[] = [
  // Google / Chrome (FCM + legacy GCM)
  'fcm.googleapis.com',
  'android.googleapis.com',
  // Mozilla / Firefox
  'push.services.mozilla.com',
  // Apple / Safari (Apple Push for Web)
  'push.apple.com',
  'icloud.com',
  // Microsoft / Edge (Windows Notification Service)
  'notify.windows.com',
  'wns.windows.com',
];

/** True iff `host` equals an allowed suffix or is a subdomain of one (label-boundary match, case-insensitive). */
function hostMatchesAllowlist(host: string): boolean {
  const h = host.toLowerCase();
  return ALLOWED_PUSH_HOST_SUFFIXES.some((suffix) => h === suffix || h.endsWith(`.${suffix}`));
}

/**
 * Validates a Web Push subscription `endpoint`: it MUST be an HTTPS URL whose host belongs to a known push
 * service. A malformed URL, a non-HTTPS scheme, or a foreign/internal host → false (the caller rejects with 400).
 * Pure and total (never throws).
 */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false; // not a parseable absolute URL
  }
  if (url.protocol !== 'https:') return false; // push delivery is HTTPS-only
  return hostMatchesAllowlist(url.hostname);
}
