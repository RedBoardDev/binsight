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
