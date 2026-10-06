//! Keeping the projection tables in step with the code that computes them.
//!
//! Every projection the code knows is listed in [`REGISTRY`] with its calculation version. At
//! startup the engine compares the registry with the bookkeeping stored in the database: a
//! projection whose version changed (or that is new, or whose rebuild never finished) is stale;
//! a stored projection the code no longer knows is an orphan and is forgotten (its table is
//! dropped). The comparison is a pure function; this module also runs it against the store.

use binsight_store::{ProjectionState, ProjectionStatus, Store, StoreError};
use tracing::info;

/// A projection the code knows how to compute.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProjectionSpec {
    /// The projection's name; its table is `proj_<name>`.
    pub name: &'static str,
    /// The version of its calculation. Bump it whenever the computed values would change: the
    /// table is then rebuilt from the raw and decoded layers.
    pub calc_version: u32,
}

/// Every projection of the current code. Empty until the first projection is written.
pub const REGISTRY: &[ProjectionSpec] = &[];

/// The projections of `registry` whose stored table cannot be used as it is: never built, built
/// by another calculation version, or left incomplete by an interrupted rebuild.
pub fn stale_projections<'registry>(
    registry: &'registry [ProjectionSpec],
    stored: &[ProjectionState],
) -> Vec<&'registry ProjectionSpec> {
    registry
        .iter()
        .filter(|spec| {
            let current = stored.iter().find(|state| state.name == spec.name);
            !current.is_some_and(|state| {
                state.calc_version == spec.calc_version
                    && matches!(state.status, ProjectionStatus::Ready { .. })
            })
        })
        .collect()
}

/// The stored projections that `registry` no longer lists.
pub fn orphaned_projections<'stored>(
    registry: &[ProjectionSpec],
    stored: &'stored [ProjectionState],
) -> Vec<&'stored str> {
    stored
        .iter()
        .filter(|state| !registry.iter().any(|spec| spec.name == state.name))
        .map(|state| state.name.as_str())
        .collect()
}

/// Forgets the orphaned projections and reports the stale ones. Returns the stale projections,
/// which the engine rebuilds.
pub(crate) async fn reconcile_projections<'registry>(
    store: &Store,
    registry: &'registry [ProjectionSpec],
) -> Result<Vec<&'registry ProjectionSpec>, StoreError> {
    let stored = store.projections().list().await?;
    for name in orphaned_projections(registry, &stored) {
        store.projections().forget(name).await?;
        info!(projection = name, "orphaned projection forgotten");
    }
    let stale = stale_projections(registry, &stored);
    for spec in &stale {
        info!(
            projection = spec.name,
            calc_version = spec.calc_version,
            "projection is out of date"
        );
    }
    Ok(stale)
}

#[cfg(test)]
mod tests {
    use jiff::Timestamp;

    use super::*;
    use crate::test_support::temporary_engine;

    const POSITIONS: ProjectionSpec = ProjectionSpec {
        name: "positions",
        calc_version: 2,
    };
    const CURVES: ProjectionSpec = ProjectionSpec {
        name: "curves",
        calc_version: 1,
    };

    fn ready(name: &str, calc_version: u32) -> ProjectionState {
        ProjectionState {
            name: name.to_owned(),
            calc_version,
            status: ProjectionStatus::Ready {
                built_at: Timestamp::UNIX_EPOCH,
            },
        }
    }

    #[test]
    fn treats_a_projection_never_built_as_stale() {
        assert_eq!(stale_projections(&[POSITIONS], &[]), vec![&POSITIONS]);
    }

    #[test]
    fn keeps_a_ready_projection_of_the_same_version() {
        assert_eq!(
            stale_projections(&[CURVES], &[ready("curves", 1)]),
            Vec::<&ProjectionSpec>::new()
        );
    }

    #[test]
    fn treats_a_projection_of_another_version_as_stale() {
        assert_eq!(
            stale_projections(&[POSITIONS], &[ready("positions", 1)]),
            vec![&POSITIONS]
        );
    }

    #[test]
    fn recognizes_the_first_positions_definition_without_registering_a_producer() {
        assert_eq!(REGISTRY, []);
        let definition = ProjectionSpec {
            name: "positions",
            calc_version: binsight_ledger::calc_version::POSITIONS,
        };
        assert_eq!(
            stale_projections(
                &[definition],
                &[ready("positions", binsight_ledger::calc_version::POSITIONS)]
            ),
            Vec::<&ProjectionSpec>::new()
        );
        assert_eq!(
            stale_projections(
                &[definition],
                &[ready("positions", definition.calc_version + 1)]
            ),
            vec![&definition]
        );
    }

    #[test]
    fn treats_an_interrupted_rebuild_as_stale() {
        let building = ProjectionState {
            status: ProjectionStatus::Building,
            ..ready("curves", 1)
        };
        assert_eq!(stale_projections(&[CURVES], &[building]), vec![&CURVES]);
    }

    #[test]
    fn finds_the_projections_the_code_no_longer_knows() {
        let stored = [ready("curves", 1), ready("old_pnl", 4)];
        assert_eq!(orphaned_projections(&[CURVES], &stored), vec!["old_pnl"]);
    }

    #[tokio::test]
    async fn forgets_orphans_and_reports_stale_projections_at_startup() {
        let setup = temporary_engine().await;
        let store = setup.handle.store();
        store
            .projections()
            .mark_ready("old_pnl", 4, Timestamp::UNIX_EPOCH)
            .await
            .unwrap();
        store
            .projections()
            .mark_ready("curves", 1, Timestamp::UNIX_EPOCH)
            .await
            .unwrap();

        let stale = reconcile_projections(store, &[CURVES, POSITIONS])
            .await
            .unwrap();

        assert_eq!(stale, vec![&POSITIONS]);
        let names: Vec<String> = store
            .projections()
            .list()
            .await
            .unwrap()
            .into_iter()
            .map(|state| state.name)
            .collect();
        assert_eq!(names, vec!["curves"]);
    }
}
