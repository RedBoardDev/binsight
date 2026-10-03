const FALLBACK_PATH = '/';
const FIRST_PRINTABLE_CODE = 0x20;
const DELETE_CODE = 0x7f;
const LOGIN_PATH = /^\/login(?:[/?#]|$)/;

const hasControlCharacter = (text: string): boolean =>
  Array.from(text).some((character) => {
    const code = character.charCodeAt(0);
    return code < FIRST_PRINTABLE_CODE || code === DELETE_CODE;
  });

// Only a path on this site is a safe destination. "//evil.example" and "/\evil.example" are
// read by browsers as another site, and the URL parser drops tabs and newlines, so "/\t/evil"
// becomes "//evil": accepting any of them turns the login page into an open redirect.
export const safeRedirect = (target: string | undefined): string => {
  if (
    target === undefined ||
    !target.startsWith('/') ||
    target.startsWith('//') ||
    target.startsWith('/\\') ||
    hasControlCharacter(target) ||
    LOGIN_PATH.test(target)
  ) {
    return FALLBACK_PATH;
  }
  return target;
};
