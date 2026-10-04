const INITIALS_LENGTH = 2;

export const tokenInitials = (symbol: string): string =>
  [...symbol.toUpperCase()]
    .filter((character) => /[\p{L}\p{N}]/u.test(character))
    .slice(0, INITIALS_LENGTH)
    .join('');
