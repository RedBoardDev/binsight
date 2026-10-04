//! Reading query strings: the extractor that answers the API's own error, and the parameters
//! most routes share.

use axum::extract::{FromRequestParts, Query};
use axum::http::request::Parts;
use binsight_ledger::report::valued;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::error::{ApiError, ErrorCode};

/// A query string parsed into `T`; a bad one answers `400 invalid_request` naming the field.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct ApiQuery<T>(pub(crate) T);

impl<T, S> FromRequestParts<S> for ApiQuery<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        match Query::<T>::from_request_parts(parts, state).await {
            Ok(Query(value)) => Ok(Self(value)),
            Err(rejection) => Err(ApiError::new(
                ErrorCode::InvalidRequest,
                rejection.body_text(),
            )),
        }
    }
}

/// The currency figures are shown in.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Currency {
    /// SOL, the native unit (the default).
    #[default]
    Sol,
    /// US dollars, converted at the rate of each figure's day (or the spot rate for live
    /// figures).
    Usd,
}

impl From<Currency> for valued::Currency {
    fn from(currency: Currency) -> Self {
        match currency {
            Currency::Sol => Self::Sol,
            Currency::Usd => Self::Usd,
        }
    }
}

/// The query of a read whose only parameter is the currency.
#[derive(Debug, Clone, Copy, Default, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub(crate) struct CurrencyQuery {
    /// The currency of the figures (`sol` by default).
    pub(crate) currency: Option<Currency>,
}

impl CurrencyQuery {
    /// The requested currency, `sol` by default.
    pub(crate) fn currency(self) -> valued::Currency {
        self.currency.unwrap_or_default().into()
    }
}
