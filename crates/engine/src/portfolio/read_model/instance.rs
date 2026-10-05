//! Reads about the instance itself: its synchronization and its settings.

use crate::portfolio::answer::Answer;
use crate::portfolio::views::{InstanceSettings, SyncReport};

/// What the API reads about the instance.
pub trait InstanceReads: Send + Sync {
    /// The synchronization of the instance and of each wallet.
    fn sync_report(&self) -> Answer<'_, SyncReport>;

    /// The settings every client shares.
    fn settings(&self) -> Answer<'_, InstanceSettings>;
}
