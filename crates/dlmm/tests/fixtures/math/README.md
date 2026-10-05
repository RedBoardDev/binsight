These fixtures contain only synthetic inputs and numerical reference results. They are not
mainnet captures, and do not establish the deployed program's accumulator rewind semantics.

`proportional-amounts.json` holds `[amount, share, supply, floor(amount * share / supply)]`
strings calculated independently with Python's unbounded integers. Seven explicit boundary
cases include u128::MAX and u64::MAX. The remaining 32 cases use `random.Random(20261005)`:
`supply = randrange(2**120, 2**128-1)`, `share = randrange(supply+1)`, and
`amount = randrange(2**63, 2**64)`, in that order. No Rust calculation generates these results.

`synthetic-position-sdk-expected.json` was calculated with the actual
[`@meteora-ag/dlmm` 1.9.14](https://www.npmjs.com/package/@meteora-ag/dlmm/v/1.9.14)
`processPosition` helper, using the same synthetic bytes constructed in `position_amounts.rs`:
87 bins (-17 through 69), two arrays (-1 and 0), one third of each bin's supply, checkpoints
at half its accumulators, and pending X/Y fees of offset+1/offset+2. This covers 17 extended
PositionV2 records beyond its 70 inline records. All accounts are synthetic. The SDK coder
and helper execute offline; all connection methods throw if called. No SDK source or account
fixture from its repository is redistributed here. Rust tests do not need Node or the SDK.

The npm archive was verified against its registry integrity:
`sha512-3xJGBaYgkHWSZ7sjfaMYTuCUE9/FGibIwhoNKSaP3iXX3kZck4b3qrtFwDl/1+JaflTeiZQY4zO25e+u2V/9ug==`.
The SDK's raw `totalXAmount`, `totalYAmount`, `feeX`, and `feeY` outputs are stored as decimal
strings. Synthetic mint metadata (6/9 decimals, no transfer-fee extensions) and clock epoch/time
zero are supplied only to satisfy the helper's other calculations; assertions cover raw
liquidity and fees, not rewards, human prices, or transfer-fee-adjusted proceeds.

The layout reference is the public SDK's
[IDL at revision 576919e3e4368e542c402f000b4264724f7f23ec](https://github.com/MeteoraAg/dlmm-sdk/blob/576919e3e4368e542c402f000b4264724f7f23ec/ts-client/src/dlmm/idl/idl.json).
A current mainnet PositionV2 snapshot remains a separate acceptance requirement.

`q64-division.json` contains 152 independent Python bigint results for
`quotient = (value << 64) // price`, with `null` for a zero price or a quotient
greater than `2**128-1`. The first 120 cases are the Cartesian product, in order, of:

- amounts: `0, 1, 3, 2**64-1, 2**64, 2**64+1, 2**127-1, 2**127, 2**128-2, 2**128-1`;
- prices: `0, 1, 2, 3, 2**64-1, 2**64, 2**64+1, 3*2**64, 2**127-1, 2**127, 2**128-2, 2**128-1`.

For the remaining 32 cases, `random.Random(20261005)` draws the amount and then
the price with `randrange(2**128)`. The oracle uses direct unbounded division,
without the Rust remainder recurrence or a rounded reciprocal. These are
mathematical fixtures; they do not claim an SDK or mainnet comparison.

`inverse-unit-price.json` contains 1,100 independent Python bigint results for
`floor(2**64 * 10**(18 + y_decimals - x_decimals) / raw)`, moving a negative
power of ten to the denominator. A zero raw price or result above `2**128-1`
is recorded as `null`. These are mathematical presentation fixtures, not SDK
or mainnet comparisons; they do not replace the original raw price for amounts.

The first 100 cases are the Cartesian product, in order, of raw prices
`0, 1, 2, 3, 2**64-1, 2**64, 2**64+1, 3*2**64, 2**127, 2**128-1`
and decimal pairs `(0,0), (6,9), (9,6), (0,255), (255,0), (0,38),
(0,39), (18,0), (19,0), (255,255)`. The remaining 1,000 cases use
`random.Random(20261005)`, drawing raw with `randrange(1, 2**128)` and then
X and Y decimals each with `randrange(256)`. Expected values use direct
unbounded integer division, without the Rust decimal remainder recurrence.
