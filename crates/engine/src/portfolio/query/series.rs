//! A chart series of a scope over a period: net worth, real PnL or closed-position PnL.

use binsight_ledger::report::period::{Bucket, Period, buckets};
use binsight_ledger::report::real_pnl::PnlTimeline;
use binsight_ledger::report::series::{SeriesKind, SeriesRequest as RuleRequest, series};
use binsight_ledger::report::valued::{Currency, resolve};

use super::scope_figures::{live_point, net_worth};
use super::window::{period_window, window_view};
use crate::portfolio::read_error::ReadError;
use crate::portfolio::scope::{ReadContext, Scope};
use crate::portfolio::snapshot::Snapshot;
use crate::portfolio::views::{SeriesHeaderView, SeriesPointView, SeriesView};

/// The most buckets a series may have.
pub const MAX_SERIES_BUCKETS: usize = 1_000;

/// What a series read asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SeriesRequest {
    /// Whose figures.
    pub scope: Scope,
    /// The window.
    pub period: Period,
    /// Which series.
    pub series: SeriesKind,
    /// The size of its buckets.
    pub bucket: Bucket,
    /// The currency of the figures.
    pub currency: Currency,
}

/// The series the request asks for.
///
/// # Errors
///
/// Returns [`ReadError::WalletNotFound`] for an untracked wallet,
/// [`ReadError::TooManyBuckets`] beyond [`MAX_SERIES_BUCKETS`], and an error when a figure
/// overflows.
pub fn stats_series(
    snapshot: &Snapshot,
    request: SeriesRequest,
    context: &ReadContext,
) -> Result<SeriesView, ReadError> {
    super::check_scope(snapshot, request.scope)?;
    let window = period_window(snapshot, request.scope, request.period, context)?;
    let spans = buckets(&window, request.bucket, &context.timezone)?;
    if spans.len() > MAX_SERIES_BUCKETS {
        return Err(ReadError::TooManyBuckets(MAX_SERIES_BUCKETS));
    }
    let worth = net_worth(snapshot, request.scope)?;
    let live = live_point(snapshot, request.scope, &worth, context.now)?;
    let histories = snapshot.histories_in(request.scope);
    let timeline = PnlTimeline::new(&histories, snapshot.rates());
    let currency = request.currency;
    let computed = series(
        &timeline,
        &live,
        RuleRequest {
            kind: request.series,
            window: &window,
            buckets: &spans,
            currency,
        },
    )?;
    let optional = |figure: &Option<_>| figure.as_ref().map(|figure| resolve(figure, currency));
    Ok(SeriesView {
        window: window_view(&window, context),
        series: request.series,
        bucket: request.bucket,
        header: SeriesHeaderView {
            value: resolve(&computed.header.value, currency),
            change: optional(&computed.header.change),
            net_deposits: optional(&computed.header.net_deposits),
        },
        points: computed
            .points
            .into_iter()
            .map(|point| SeriesPointView {
                start: point.span.start,
                end: point.span.end,
                bar: optional(&point.bar),
                bar_share_of_net_worth: point.bar_share_of_net_worth,
                line: resolve(&point.line, currency),
                line_share_of_net_worth: point.line_share_of_net_worth,
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use binsight_core::money::SignedLamports;
    use binsight_core::units::Lamports;
    use binsight_ledger::facts::{
        HistoryCoverage, WalletEntry, WalletEntryKind, WalletFacts, WalletHoldings,
    };
    use binsight_ledger::report::valued::Currency;
    use binsight_solana::Address;
    use jiff::Timestamp;
    use jiff::tz::TimeZone;

    use super::*;
    use crate::portfolio::snapshot::{SnapshotFacts, TrackedWallet};
    use crate::portfolio::views::{SyncState, WalletColor, WalletSync};
    use crate::portfolio::wallet_label::WalletLabel;

    /// A wallet whose first deposit was at `first_deposit_at`.
    fn snapshot_since(first_deposit_at: Timestamp) -> Snapshot {
        let address = Address::from_bytes([7; 32]);
        let wallet = TrackedWallet {
            facts: WalletFacts {
                address,
                added_at: first_deposit_at,
                history: HistoryCoverage::Complete,
            },
            label: WalletLabel::short_address(&address),
            color: WalletColor::Wallet1,
            holdings: WalletHoldings {
                wallet: address,
                idle: Lamports(1_000_000_000),
                recoverable_rent: Lamports(0),
                unpriced: Vec::new(),
                observed_at: first_deposit_at,
            },
            sync: WalletSync {
                state: SyncState::Live,
                lag_seconds: None,
                last_tx_at: None,
                indexed_tx: 0,
                import: None,
            },
        };
        let deposit = WalletEntry {
            wallet: address,
            at: first_deposit_at,
            kind: WalletEntryKind::CapitalDeposit,
            amount: SignedLamports(1_000_000_000),
            signature: None,
        };
        Snapshot::new(SnapshotFacts {
            wallets: vec![wallet],
            entries: vec![deposit],
            ..SnapshotFacts::default()
        })
        .unwrap()
    }

    fn request(bucket: Bucket) -> SeriesRequest {
        SeriesRequest {
            scope: Scope::All,
            period: Period::All,
            series: SeriesKind::RealPnl,
            bucket,
            currency: Currency::Sol,
        }
    }

    #[test]
    fn refuses_a_window_of_more_than_a_thousand_buckets() {
        let snapshot = snapshot_since("2023-01-01T00:00:00Z".parse().unwrap());
        let context = ReadContext {
            now: "2026-10-04T12:00:00Z".parse().unwrap(),
            timezone: TimeZone::UTC,
        };

        let days = stats_series(&snapshot, request(Bucket::Day), &context);
        let weeks = stats_series(&snapshot, request(Bucket::Week), &context).unwrap();

        assert_eq!(
            days.unwrap_err(),
            ReadError::TooManyBuckets(MAX_SERIES_BUCKETS)
        );
        assert_eq!(weeks.points.len(), 197);
    }
}
