//! `GET /api/v1/sync`: how the instance and each wallet keep up with the chain, and the credits
//! of the month. One read serves the live badge, its popover and the health page.

use axum::Json;
use axum::extract::State;
use binsight_engine::portfolio::views;
use jiff::Timestamp;
use serde::Serialize;
use utoipa::ToSchema;

use super::health::EngineStatus;
use crate::app::AppState;
use crate::contract::{DecimalString, PercentFigure, SyncState, WalletRef};
use crate::error::{ApiError, ErrorBody};

/// The synchronization of one wallet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct WalletSync {
    /// Its state.
    pub(crate) state: SyncState,
    /// How far behind the chain it is, in seconds, when known.
    pub(crate) lag_seconds: Option<u64>,
    /// When its last transaction happened.
    pub(crate) last_tx_at: Option<Timestamp>,
    /// How many of its transactions are indexed.
    pub(crate) indexed_tx: u64,
    /// The progress of the import of its history, while it runs.
    pub(crate) import: Option<ImportProgress>,
}

/// The progress of a history import.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct ImportProgress {
    /// How far it is, in percent; null when its total is unknown.
    #[schema(required = true)]
    pub(crate) progress: Option<DecimalString>,
    /// How long it should still take, in seconds, when known.
    pub(crate) eta_seconds: Option<u64>,
}

/// A wallet and its synchronization.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct WalletSyncLine {
    /// The wallet.
    pub(crate) wallet: WalletRef,
    /// Its synchronization.
    #[serde(flatten)]
    pub(crate) sync: WalletSync,
}

/// The last slot the instance saw.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct ChainTip {
    /// The slot.
    pub(crate) last_slot: Option<u64>,
    /// When it was seen.
    pub(crate) last_slot_at: Option<Timestamp>,
}

/// The billing cycle supplied by the credit source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct BillingCycle {
    /// The first charged instant, inclusive.
    pub(crate) start: Timestamp,
    /// The reset instant, exclusive.
    pub(crate) end: Timestamp,
}

/// The provider credits of the current billing cycle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct CreditsSummary {
    /// Exact cycle boundaries from the governor, simulated independently in demo mode.
    pub(crate) cycle: BillingCycle,
    /// Credits spent so far.
    pub(crate) used: u64,
    /// The cycle budget.
    pub(crate) budget: u64,
    /// `used / budget`, in percent.
    pub(crate) used_percent: PercentFigure,
    /// Expected cycle spending by elapsed seconds; null when no second has elapsed.
    #[schema(required = true)]
    pub(crate) projected: Option<u64>,
    /// Observed or projected excess; null when neither proves a verdict yet.
    #[schema(required = true)]
    pub(crate) is_over_budget: Option<bool>,
}

/// The synchronization of the instance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct SyncReport {
    /// The worst state of the wallets.
    pub(crate) state: SyncState,
    /// Where the engine is in its lifecycle.
    pub(crate) engine: EngineStatus,
    /// When this report was made.
    pub(crate) as_of: Timestamp,
    /// When the engine started.
    pub(crate) started_at: Timestamp,
    /// The chain tip.
    pub(crate) chain: ChainTip,
    /// How often open positions are valued, in seconds, when they are.
    pub(crate) valuation_interval_seconds: Option<u64>,
    /// The credits of the billing cycle.
    pub(crate) credits: CreditsSummary,
    /// Each wallet, in the order of the wallet list.
    pub(crate) wallets: Vec<WalletSyncLine>,
}

impl From<&views::WalletSync> for WalletSync {
    fn from(sync: &views::WalletSync) -> Self {
        Self {
            state: sync.state.into(),
            lag_seconds: sync.lag_seconds,
            last_tx_at: sync.last_tx_at,
            indexed_tx: sync.indexed_tx,
            import: sync.import.map(|import| ImportProgress {
                progress: import.progress.map(DecimalString::from),
                eta_seconds: import.eta_seconds,
            }),
        }
    }
}

impl From<views::SyncReport> for SyncReport {
    fn from(report: views::SyncReport) -> Self {
        let credits = report.credits;
        Self {
            state: report.state.into(),
            engine: report.engine.into(),
            as_of: report.as_of,
            started_at: report.started_at,
            chain: ChainTip {
                last_slot: report.chain.last_slot,
                last_slot_at: report.chain.last_slot_at,
            },
            valuation_interval_seconds: report.valuation_interval_seconds,
            credits: CreditsSummary {
                cycle: BillingCycle {
                    start: credits.cycle.start,
                    end: credits.cycle.end,
                },
                used: credits.used,
                budget: credits.budget,
                used_percent: (&credits.used_percent).into(),
                projected: credits.projected,
                is_over_budget: credits.is_over_budget,
            },
            wallets: report
                .wallets
                .iter()
                .map(|line| WalletSyncLine {
                    wallet: (&line.wallet).into(),
                    sync: (&line.sync).into(),
                })
                .collect(),
        }
    }
}

/// Reports how the instance and each wallet keep up with the chain.
#[utoipa::path(
    get,
    path = "/api/v1/sync",
    operation_id = "getSyncReport",
    tag = "system",
    security(("session_cookie" = [])),
    responses(
        (status = 200, description = "The synchronization of the instance.", body = SyncReport),
        (status = 401, description = "Not signed in (`unauthenticated`).", body = ErrorBody),
        (status = 500, description = "The database could not be read (`internal`).", body = ErrorBody),
    ),
)]
pub(crate) async fn get_sync_report(
    State(state): State<AppState>,
) -> Result<Json<SyncReport>, ApiError> {
    let report = state.engine.read_model().sync_report().await?;
    Ok(Json(report.into()))
}
