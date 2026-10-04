//! The credits spent on the RPC provider, per UTC day.
//!
//! The chain client's meter counts every request in memory; the engine regularly hands the counts
//! here, and each one is added to its row (day, method, priority, purpose, wallet, outcome). The
//! day's total restores the hard daily limit after a restart, and the totals tell where the
//! credits went. This module stores and sums counts; it does not know what a method costs.

use binsight_core::credits::{CallOutcome, Credits, Priority, Purpose};
use binsight_solana::Address;
use jiff::civil::Date;
use rusqlite::{Row, params};

use crate::database::Database;
use crate::database::codec::{parse_from_sql, unsigned_from_sql, unsigned_to_sql};
use crate::error::StoreError;
use crate::store::Store;

/// The `wallet` column of a request no wallet is billed for.
const NO_WALLET: &str = "";

const ADD_USAGE: &str = "
    INSERT INTO credit_daily (day, method, priority, purpose, wallet, outcome, calls, credits)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    ON CONFLICT (day, method, priority, purpose, wallet, outcome)
    DO UPDATE SET calls = calls + excluded.calls, credits = credits + excluded.credits";
const SPENT_BETWEEN: &str =
    "SELECT coalesce(sum(credits), 0) FROM credit_daily WHERE day BETWEEN ?1 AND ?2";
const TOTALS_BETWEEN: &str = "
    SELECT method, priority, purpose, outcome, sum(calls), sum(credits) FROM credit_daily
    WHERE day BETWEEN ?1 AND ?2
    GROUP BY method, priority, purpose, outcome
    ORDER BY priority, method, purpose, outcome";

/// The credits a group of identical requests cost on one day.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreditUsage {
    /// The UTC day they were sent.
    pub day: Date,
    /// The JSON-RPC method, such as `getTransaction`.
    pub method: String,
    /// Their class.
    pub priority: Priority,
    /// The work they belonged to.
    pub purpose: Purpose,
    /// The wallet they served, if any.
    pub wallet: Option<Address>,
    /// How they ended.
    pub outcome: CallOutcome,
    /// How many requests were sent.
    pub calls: u64,
    /// The credits they cost.
    pub credits: Credits,
}

/// The requests and credits of one kind over a range of days, every wallet together.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreditTotal {
    /// The JSON-RPC method.
    pub method: String,
    /// The class of the requests.
    pub priority: Priority,
    /// The work they belonged to.
    pub purpose: Purpose,
    /// How they ended.
    pub outcome: CallOutcome,
    /// How many requests were sent.
    pub calls: u64,
    /// The credits they cost.
    pub credits: Credits,
}

/// Reads and writes the credit counts. Get one with [`Store::credits`].
#[derive(Debug, Clone)]
pub struct CreditsRepo {
    database: Database,
}

impl Store {
    /// The credits spent on the RPC provider.
    pub fn credits(&self) -> CreditsRepo {
        CreditsRepo {
            database: self.database().clone(),
        }
    }
}

impl CreditsRepo {
    /// Adds each count to its day's row, all or nothing.
    ///
    /// # Errors
    ///
    /// Returns an error if a count is too large for its column or the database cannot be
    /// written; nothing is added then.
    pub async fn add(&self, usages: Vec<CreditUsage>) -> Result<(), StoreError> {
        self.database
            .write(move |connection| {
                let transaction = connection.transaction()?;
                for usage in &usages {
                    let wallet = usage
                        .wallet
                        .map_or_else(|| NO_WALLET.to_owned(), |wallet| wallet.to_string());
                    transaction.execute(
                        ADD_USAGE,
                        params![
                            usage.day.to_string(),
                            usage.method,
                            usage.priority.as_str(),
                            usage.purpose.as_str(),
                            wallet,
                            usage.outcome.as_str(),
                            unsigned_to_sql(usage.calls, "call count")?,
                            unsigned_to_sql(usage.credits.0, "credits")?,
                        ],
                    )?;
                }
                transaction.commit()?;
                Ok(())
            })
            .await
    }

    /// The credits spent from `first_day` to `last_day`, both included.
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be read.
    pub async fn spent_between(
        &self,
        first_day: Date,
        last_day: Date,
    ) -> Result<Credits, StoreError> {
        self.database
            .read(move |connection| {
                let spent: i64 = connection.query_row(
                    SPENT_BETWEEN,
                    params![first_day.to_string(), last_day.to_string()],
                    |row| row.get(0),
                )?;
                unsigned_from_sql(spent, "credits").map(Credits)
            })
            .await
    }

    /// The requests and credits from `first_day` to `last_day` (both included), per method,
    /// priority, purpose and outcome.
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be read or holds an invalid row.
    pub async fn totals_between(
        &self,
        first_day: Date,
        last_day: Date,
    ) -> Result<Vec<CreditTotal>, StoreError> {
        self.database
            .read(move |connection| {
                let mut query = connection.prepare(TOTALS_BETWEEN)?;
                let rows = query.query_map(
                    params![first_day.to_string(), last_day.to_string()],
                    |row| Ok(total_from_row(row)),
                )?;
                rows.map(|row| row?).collect()
            })
            .await
    }
}

fn total_from_row(row: &Row<'_>) -> Result<CreditTotal, StoreError> {
    Ok(CreditTotal {
        method: row.get(0)?,
        priority: parse_from_sql(&row.get::<_, String>(1)?, "priority")?,
        purpose: parse_from_sql(&row.get::<_, String>(2)?, "purpose")?,
        outcome: parse_from_sql(&row.get::<_, String>(3)?, "call outcome")?,
        calls: unsigned_from_sql(row.get(4)?, "call count")?,
        credits: Credits(unsigned_from_sql(row.get(5)?, "credits")?),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::test_database::{assert_queries_prepare, migrated_store};

    fn usage(day: &str, outcome: CallOutcome, calls: u64) -> CreditUsage {
        CreditUsage {
            day: day.parse().unwrap(),
            method: "getTransaction".to_owned(),
            priority: Priority::History,
            purpose: Purpose::TransactionFetch,
            wallet: Some(Address::from_bytes([1; 32])),
            outcome,
            calls,
            credits: Credits(calls),
        }
    }

    fn day(text: &str) -> Date {
        text.parse().unwrap()
    }

    #[tokio::test]
    async fn prepares_every_query_against_the_schema() {
        assert_queries_prepare(&[ADD_USAGE, SPENT_BETWEEN, TOTALS_BETWEEN]).await;
    }

    #[tokio::test]
    async fn adds_credit_usage_to_the_same_day_row() {
        let (_folder, store) = migrated_store().await;
        let credits = store.credits();

        credits
            .add(vec![usage("2026-09-21", CallOutcome::Ok, 2)])
            .await
            .unwrap();
        credits
            .add(vec![usage("2026-09-21", CallOutcome::Ok, 3)])
            .await
            .unwrap();

        let totals = credits
            .totals_between(day("2026-09-21"), day("2026-09-21"))
            .await
            .unwrap();
        assert_eq!(totals.len(), 1);
        assert_eq!((totals[0].calls, totals[0].credits), (5, Credits(5)));
    }

    #[tokio::test]
    async fn sums_the_credits_of_the_days_in_the_range_only() {
        let (_folder, store) = migrated_store().await;
        let credits = store.credits();
        credits
            .add(vec![
                usage("2026-09-20", CallOutcome::Ok, 7),
                usage("2026-09-21", CallOutcome::Ok, 2),
                usage("2026-09-21", CallOutcome::Timeout, 1),
                usage("2026-09-22", CallOutcome::Ok, 4),
            ])
            .await
            .unwrap();

        let today = credits
            .spent_between(day("2026-09-21"), day("2026-09-21"))
            .await
            .unwrap();
        let nothing = credits
            .spent_between(day("2026-10-01"), day("2026-10-31"))
            .await
            .unwrap();

        assert_eq!(today, Credits(3));
        assert_eq!(nothing, Credits::ZERO);
    }

    #[tokio::test]
    async fn files_a_request_without_a_wallet_under_no_wallet() {
        let (_folder, store) = migrated_store().await;
        let unattributed = CreditUsage {
            wallet: None,
            ..usage("2026-09-21", CallOutcome::RateLimited, 1)
        };

        store.credits().add(vec![unattributed]).await.unwrap();

        let totals = store
            .credits()
            .totals_between(day("2026-09-21"), day("2026-09-21"))
            .await
            .unwrap();
        assert_eq!(totals[0].outcome, CallOutcome::RateLimited);
    }

    #[tokio::test]
    async fn accepts_every_priority_purpose_and_outcome_binsight_names() {
        let (_folder, store) = migrated_store().await;
        let mut usages = Vec::new();
        for priority in Priority::ALL {
            for purpose in Purpose::ALL {
                for outcome in CallOutcome::ALL {
                    usages.push(CreditUsage {
                        priority,
                        purpose,
                        ..usage("2026-09-21", outcome, 1)
                    });
                }
            }
        }
        let rows = u64::try_from(usages.len()).unwrap();

        store.credits().add(usages).await.unwrap();

        let spent = store
            .credits()
            .spent_between(day("2026-09-21"), day("2026-09-21"))
            .await;
        assert_eq!(spent.unwrap(), Credits(rows));
    }
}
