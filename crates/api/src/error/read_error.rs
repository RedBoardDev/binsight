//! How a failed read of the portfolio answers.

use binsight_engine::portfolio::ReadError;

use super::api_error::ApiError;
use super::code::ErrorCode;

impl From<ReadError> for ApiError {
    fn from(error: ReadError) -> Self {
        match error {
            ReadError::NotReady => Self::new(
                ErrorCode::DataNotReady,
                "the engine does not serve figures yet",
            ),
            ReadError::WalletNotFound(address) => Self::new(
                ErrorCode::WalletNotFound,
                format!("the wallet {address} is not tracked"),
            ),
            ReadError::PositionNotFound(id) => Self::new(
                ErrorCode::PositionNotFound,
                format!("the position {id} is not tracked"),
            ),
            ReadError::InvalidInterval => Self::new(
                ErrorCode::InvalidRequest,
                "interval: this candle size does not fit the chart (see the chart's intervals)",
            ),
            ReadError::LogoNotFound(mint) => Self::new(
                ErrorCode::NotFound,
                format!("no logo is stored for the token {mint}"),
            ),
            ReadError::TooManyBuckets(limit) => Self::new(
                ErrorCode::InvalidRequest,
                format!("the window has more than {limit} buckets: choose a larger bucket"),
            ),
            ReadError::Rule(_)
            | ReadError::Window(_)
            | ReadError::MissingFact
            | ReadError::BinOutOfRange { .. } => Self::internal(error.to_string()),
        }
    }
}
