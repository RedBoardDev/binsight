//! Layer 3: the bookkeeping of the disposable projection tables.
//!
//! A projection (positions, PnL, curves...) lives in its own table named `proj_<name>`, created and
//! filled by code, and is rebuilt from layers 1 and 2 whenever its calculation version changes.
//! The `projection_meta` table remembers, for each projection, which calculation version its table
//! holds and whether it is complete. This module keeps that bookkeeping; deciding what to rebuild
//! is the engine's job.

use jiff::Timestamp;
use rusqlite::{Row, params};

use crate::codec::{timestamp_from_sql, timestamp_to_sql, version_from_sql, version_to_sql};
use crate::error::StoreError;
use crate::pools::Database;
use crate::store::Store;

const SELECT_ALL: &str =
    "SELECT name, calc_version, status, built_at FROM projection_meta ORDER BY name";
const UPSERT: &str = "
    INSERT INTO projection_meta (name, calc_version, status, built_at) VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT (name) DO UPDATE SET calc_version = ?2, status = ?3, built_at = ?4";
const DELETE: &str = "DELETE FROM projection_meta WHERE name = ?1";

/// Whether a projection table can be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectionStatus {
    /// The table is being rebuilt; its content is incomplete.
    Building,
    /// The table is complete for its calculation version.
    Ready {
        /// When the rebuild finished.
        built_at: Timestamp,
    },
}

/// The stored state of one projection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectionState {
    /// The projection's name; its table is `proj_<name>`.
    pub name: String,
    /// The calculation version its table holds (1 or more).
    pub calc_version: u32,
    /// Whether the table is complete.
    pub status: ProjectionStatus,
}

/// Reads and writes the projection bookkeeping. Get one with [`Store::projections`].
#[derive(Debug, Clone)]
pub struct ProjectionMetaRepo {
    database: Database,
}

impl Store {
    /// The bookkeeping of the projection tables (layer 3).
    pub fn projections(&self) -> ProjectionMetaRepo {
        ProjectionMetaRepo {
            database: self.database().clone(),
        }
    }
}

impl ProjectionMetaRepo {
    /// Every known projection, sorted by name.
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be read or holds an invalid row.
    pub async fn list(&self) -> Result<Vec<ProjectionState>, StoreError> {
        self.database
            .read(|connection| {
                let mut query = connection.prepare(SELECT_ALL)?;
                let rows = query.query_map([], |row| Ok(state_from_row(row)))?;
                rows.map(|row| row?).collect()
            })
            .await
    }

    /// Records that the projection `name` is being rebuilt for `calc_version`.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::InvalidProjectionName`] for a name that is not lowercase
    /// `snake_case`, or an error if the database cannot be written.
    pub async fn mark_building(&self, name: &str, calc_version: u32) -> Result<(), StoreError> {
        self.save(name, calc_version, ProjectionStatus::Building)
            .await
    }

    /// Records that the projection `name` is complete for `calc_version`.
    ///
    /// # Errors
    ///
    /// Same as [`ProjectionMetaRepo::mark_building`].
    pub async fn mark_ready(
        &self,
        name: &str,
        calc_version: u32,
        built_at: Timestamp,
    ) -> Result<(), StoreError> {
        self.save(name, calc_version, ProjectionStatus::Ready { built_at })
            .await
    }

    /// Drops the projection table `proj_<name>` and its bookkeeping, in one transaction.
    ///
    /// # Errors
    ///
    /// Same as [`ProjectionMetaRepo::mark_building`].
    pub async fn forget(&self, name: &str) -> Result<(), StoreError> {
        let name = checked_name(name)?;
        self.database
            .write(move |connection| {
                let transaction = connection.transaction()?;
                transaction.execute_batch(&format!("DROP TABLE IF EXISTS proj_{name}"))?;
                transaction.execute(DELETE, [&name])?;
                transaction.commit()?;
                Ok(())
            })
            .await
    }

    async fn save(
        &self,
        name: &str,
        calc_version: u32,
        status: ProjectionStatus,
    ) -> Result<(), StoreError> {
        let name = checked_name(name)?;
        let (status, built_at) = match status {
            ProjectionStatus::Building => ("building", None),
            ProjectionStatus::Ready { built_at } => ("ready", Some(timestamp_to_sql(built_at))),
        };
        self.database
            .write(move |connection| {
                connection.execute(
                    UPSERT,
                    params![name, version_to_sql(calc_version), status, built_at],
                )?;
                Ok(())
            })
            .await
    }
}

/// Builds a state from a row of [`SELECT_ALL`].
fn state_from_row(row: &Row<'_>) -> Result<ProjectionState, StoreError> {
    Ok(ProjectionState {
        name: row.get(0)?,
        calc_version: version_from_sql(row.get(1)?)?,
        status: status_from_sql(&row.get::<_, String>(2)?, row.get(3)?)?,
    })
}

/// Accepts only lowercase `snake_case` names, because the name becomes part of a table name.
fn checked_name(name: &str) -> Result<String, StoreError> {
    let starts_with_letter = name.chars().next().is_some_and(|c| c.is_ascii_lowercase());
    let is_snake_case = name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
    if starts_with_letter && is_snake_case {
        Ok(name.to_owned())
    } else {
        Err(StoreError::InvalidProjectionName {
            name: name.to_owned(),
        })
    }
}

fn status_from_sql(status: &str, built_at: Option<i64>) -> Result<ProjectionStatus, StoreError> {
    match (status, built_at) {
        ("building", None) => Ok(ProjectionStatus::Building),
        ("ready", Some(seconds)) => Ok(ProjectionStatus::Ready {
            built_at: timestamp_from_sql(seconds)?,
        }),
        _ => Err(StoreError::InvalidStoredValue {
            what: "projection status",
            value: status.to_owned(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_database::{assert_queries_prepare, migrated_store};

    #[tokio::test]
    async fn prepares_every_query_against_the_schema() {
        assert_queries_prepare(&[SELECT_ALL, UPSERT, DELETE]).await;
    }

    #[tokio::test]
    async fn follows_a_projection_from_building_to_ready() {
        let (_folder, store) = migrated_store().await;
        let built_at = Timestamp::from_second(1_790_000_300).unwrap();

        store
            .projections()
            .mark_building("positions", 3)
            .await
            .unwrap();
        let building = store.projections().list().await.unwrap();
        store
            .projections()
            .mark_ready("positions", 3, built_at)
            .await
            .unwrap();
        let ready = store.projections().list().await.unwrap();

        assert_eq!(building[0].status, ProjectionStatus::Building);
        assert_eq!(
            ready,
            vec![ProjectionState {
                name: "positions".to_owned(),
                calc_version: 3,
                status: ProjectionStatus::Ready { built_at },
            }]
        );
    }

    #[tokio::test]
    async fn drops_the_table_of_a_forgotten_projection() {
        let (_folder, store) = migrated_store().await;
        store
            .database()
            .write(|connection| Ok(connection.execute_batch("CREATE TABLE proj_curves (x TEXT)")?))
            .await
            .unwrap();
        store
            .projections()
            .mark_building("curves", 1)
            .await
            .unwrap();

        store.projections().forget("curves").await.unwrap();

        assert_eq!(store.projections().list().await.unwrap(), Vec::new());
        let leftover = store
            .database()
            .read(|connection| {
                Ok(connection.query_row(
                    "SELECT count(*) FROM sqlite_schema WHERE name = 'proj_curves'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?)
            })
            .await
            .unwrap();
        assert_eq!(leftover, 0);
    }

    #[tokio::test]
    async fn refuses_a_name_that_is_not_snake_case() {
        let (_folder, store) = migrated_store().await;

        for name in ["", "Positions", "1st", "x; DROP TABLE raw_tx", "pnl-curve"] {
            let attempt = store.projections().forget(name).await;
            assert!(
                matches!(attempt, Err(StoreError::InvalidProjectionName { .. })),
                "{name}"
            );
        }
    }
}
