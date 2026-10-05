//! `GET /api/v1/settings`: the settings every client of the instance shares.

use axum::Json;
use axum::extract::State;
use binsight_engine::portfolio::views;
use binsight_ledger::report::valued;
use serde::Serialize;
use utoipa::ToSchema;

use crate::app::AppState;
use crate::contract::Currency;
use crate::error::{ApiError, ErrorBody};

/// The settings of the instance. Language, theme and density are preferences of each device and
/// are not here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub(crate) struct InstanceSettings {
    /// The IANA time zone that decides where days start (today, periods, calendars), such as
    /// `Europe/Paris`.
    pub(crate) timezone: String,
    /// `default` until the owner chooses a time zone (clients may then suggest theirs once).
    pub(crate) timezone_source: TimezoneSource,
    /// The currency figures are shown in unless a client asks for another.
    pub(crate) default_currency: Currency,
    /// Whether clients hide amounts until the owner reveals them.
    pub(crate) hide_amounts_by_default: bool,
}

/// Where the time zone setting comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TimezoneSource {
    /// The default, UTC.
    Default,
    /// The owner's choice.
    Owner,
}

impl From<views::InstanceSettings> for InstanceSettings {
    fn from(settings: views::InstanceSettings) -> Self {
        Self {
            timezone: settings.timezone,
            timezone_source: match settings.timezone_source {
                views::TimezoneSource::Default => TimezoneSource::Default,
                views::TimezoneSource::Owner => TimezoneSource::Owner,
            },
            default_currency: match settings.default_currency {
                valued::Currency::Sol => Currency::Sol,
                valued::Currency::Usd => Currency::Usd,
            },
            hide_amounts_by_default: settings.hide_amounts_by_default,
        }
    }
}

/// Reads the settings of the instance.
#[utoipa::path(
    get,
    path = "/api/v1/settings",
    operation_id = "getSettings",
    tag = "settings",
    security(("session_cookie" = [])),
    responses(
        (status = 200, description = "The settings of the instance.", body = InstanceSettings),
        (status = 401, description = "Not signed in (`unauthenticated`).", body = ErrorBody),
        (status = 503, description = "The engine does not serve figures yet (`data_not_ready`).", body = ErrorBody),
    ),
)]
pub(crate) async fn get_settings(
    State(state): State<AppState>,
) -> Result<Json<InstanceSettings>, ApiError> {
    let settings = state.engine.read_model().settings().await?;
    Ok(Json(settings.into()))
}
