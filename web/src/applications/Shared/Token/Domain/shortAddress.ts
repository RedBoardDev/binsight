// A Solana address shortened the way the whole app writes it: its first and last four characters
// ("Edfe…fegz"). The wallet labels the server fills in follow the same rule.
const KEPT_CHARACTERS = 4;

export const shortAddress = (address: string): string =>
  address.length <= KEPT_CHARACTERS * 2 + 1
    ? address
    : `${address.slice(0, KEPT_CHARACTERS)}…${address.slice(-KEPT_CHARACTERS)}`;
