// Navigations the app shell must not answer: the API, and the license notices, a real file.
export const NAVIGATION_DENYLIST: readonly RegExp[] = [/^\/api\//, /^\/third-party-licenses\.txt$/];
