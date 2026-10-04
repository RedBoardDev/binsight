//! Reads about the instance itself: its synchronization.

use crate::portfolio::answer::Answer;
use crate::portfolio::views::SyncReport;

/// What the API reads about the instance.
pub trait InstanceReads: Send + Sync {
    /// The synchronization of the instance and of each wallet.
    fn sync_report(&self) -> Answer<'_, SyncReport>;
}
