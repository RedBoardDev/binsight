//! Fills free fetch slots from the current queue, preserving one slot for real-time work.

use std::collections::BTreeMap;

use binsight_core::credits::Priority;
use binsight_solana::Signature;
use binsight_store::StoreError;
use tokio::task::JoinSet;

use super::fetch_attempt::{Fetched, fetch_one};
use crate::ingestion::Ingestion;

const TOTAL_SLOTS: usize = 4;
const BACKGROUND_SLOTS: usize = TOTAL_SLOTS - 1;
// At most four queried rows can already be in flight; the next four can fill free slots.
const QUEUE_WINDOW: u32 = 8;

pub(super) fn allowed_class(
    least_urgent: Option<Priority>,
    active: &BTreeMap<Signature, Priority>,
) -> Option<Priority> {
    if active.len() >= TOTAL_SLOTS {
        return None;
    }
    let background = active
        .values()
        .filter(|priority| **priority != Priority::Realtime)
        .count();
    least_urgent.map(|class| {
        if background >= BACKGROUND_SLOTS {
            class.min(Priority::Realtime)
        } else {
            class
        }
    })
}

pub(super) async fn fill_slots(
    ingestion: &Ingestion,
    class: Priority,
    active: &mut BTreeMap<Signature, Priority>,
    running: &mut JoinSet<(Signature, Fetched)>,
) -> Result<(), StoreError> {
    let tasks = ingestion
        .store
        .fetch_queue()
        .due(ingestion.clock.now(), QUEUE_WINDOW, class)
        .await?;
    for task in tasks {
        let Some(allowed) = allowed_class(Some(class), active) else {
            break;
        };
        if task.priority > allowed || active.contains_key(&task.signature) {
            continue;
        }
        active.insert(task.signature, task.priority);
        let ingestion = ingestion.clone();
        running.spawn(async move {
            let signature = task.signature;
            (signature, fetch_one(ingestion, task).await)
        });
    }
    Ok(())
}
